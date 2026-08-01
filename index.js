import {
    chat,
    eventSource,
    event_types,
    reloadCurrentChat,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import {
    CHAT_LIMIT_CHOICES,
    CLIENT_VERSION,
    TAKEOVER_INTENSITIES,
    buildChatDiagnostics,
    estimateRenderComplexity,
    findLatestChatRequest,
    getAdaptiveBatchSize,
    normalizeSettings,
    prioritizeMessageDescriptors,
    shouldActivateRenderBoost,
    shouldAutoWarm,
} from './client-core.js';
import { FrontendTakeoverController } from './frontend-takeover.js';
import { FrameBudgetScheduler, budgetForIntensity } from './frontend-scheduler.js';

const MODULE_ID = 'cloud_lounge_accelerator';
const PLUGIN_ID = 'cloud-lounge-accelerator';
const API_BASE = `/api/plugins/${PLUGIN_ID}`;
const CACHE_PREFIX = 'cloud-lounge-static-';
const ROOT_ID = 'cloud-lounge-accelerator-settings';
const LOG_PREFIX = '[Cloud Lounge Accelerator]';
const PANEL_RETRY_LIMIT = 20;
const INTERACTIVE_CORE_URLS = Object.freeze([
    '/scripts/extensions/regex/dropdown.html',
    '/scripts/extensions/regex/editor.html',
    '/scripts/extensions/regex/scriptTemplate.html',
    '/scripts/extensions/regex/debugger.html',
    '/scripts/extensions/regex/debugger.css',
    '/scripts/extensions/regex/importTarget.html',
    '/scripts/extensions/regex/embeddedScripts.html',
    '/scripts/extensions/regex/presetEmbeddedScripts.html',
    '/scripts/templates/themeDelete.html',
    '/scripts/templates/themeImportWarning.html',
]);

let settings;
let activated = false;
let appReady = false;
let appReadyWorkStarted = false;
let panelRetryTimer = null;
let panelRetryCount = 0;
let scheduledWarmup = null;
let renderObserver = null;
let renderRefreshFrame = null;
let chatDiagnosticObserver = null;
let longTaskObserver = null;
let diagnosticRefreshFrame = null;
let diagnosticIncludeTiming = false;
let chatChangedHandler = null;
let chatLoadStart = null;
let firstContentAt = null;
let recentLongTasks = [];
let latestChatDiagnostics = null;
let cachedRegistration;
let serverState = 'unknown';
let serverHealth = null;
let lastWorkerStats = null;
let lastError = '';
let takeoverController = null;
let takeoverState = 'native';
let takeoverLabel = '酒馆原生流程';
const frontendScheduler = new FrameBudgetScheduler({
    budgetMs: 10,
    onError: error => {
        if (error?.name !== 'AbortError') console.error(LOG_PREFIX, '统一帧预算任务失败', error);
    },
});
let frontendTaskGeneration = 0;
let chatUiApiPromise = null;
let frontendTaskState = {
    status: 'idle',
    kind: '',
    label: '',
    completed: 0,
    total: 0,
    elapsedMs: 0,
};

function loadSettings() {
    settings = normalizeSettings(extension_settings[MODULE_ID]);
    extension_settings[MODULE_ID] = settings;
    frontendScheduler.setBudget(budgetForIntensity(settings.takeoverIntensity));
    return settings;
}

function persistSettings() {
    extension_settings[MODULE_ID] = settings;
    saveSettingsDebounced();
    takeoverController?.updateSettings(settings);
}

function updateTakeoverStatus(state, label) {
    takeoverState = state;
    takeoverLabel = label;
    if (['circuit', 'native', 'safe'].includes(state) && frontendTaskState.status === 'running') {
        cancelFrontendTask(label);
    }
    const node = document.querySelector(`#${ROOT_ID} [data-cloud-takeover-status]`);
    if (node) {
        node.dataset.state = state;
        node.textContent = label;
    }
    const master = document.querySelector(`#${ROOT_ID} [data-cloud-takeover-master]`);
    if (master && settings) master.checked = settings.takeoverEnabled;
}

function ensureTakeoverController() {
    if (takeoverController) return takeoverController;
    takeoverController = new FrontendTakeoverController({
        settings,
        scheduler: frontendScheduler,
        eventSource,
        eventTypes: event_types,
        chat,
        refreshRegex: () => reapplyRegexRendering(),
        loadEarlier: (count, options) => loadEarlierMessagesSmoothly(count, options),
        reloadChat: () => reloadCurrentChat(),
        persistSettings,
        loadSettings,
        onStatus: updateTakeoverStatus,
    });
    return takeoverController;
}

function isSecureContextAvailable() {
    return window.isSecureContext && 'serviceWorker' in navigator && 'caches' in window;
}

function isOurWorker(registration) {
    const worker = registration?.active || registration?.waiting || registration?.installing;
    return Boolean(worker?.scriptURL?.includes(`${API_BASE}/service-worker.js`));
}

async function findRootRegistration({ refresh = false } = {}) {
    if (!('serviceWorker' in navigator)) return null;
    if (!refresh && cachedRegistration !== undefined) return cachedRegistration;
    const rootScope = new URL('/', location.href).href;
    const registrations = await navigator.serviceWorker.getRegistrations();
    cachedRegistration = registrations.find(item => item.scope === rootScope) || null;
    return cachedRegistration;
}

async function probeServerPlugin({ force = false } = {}) {
    if (!force && serverState === 'available') return serverHealth;
    if (!force && ['missing', 'unsupported'].includes(serverState)) return null;
    if (!isSecureContextAvailable()) {
        serverState = 'unsupported';
        return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
        const response = await fetch(`${API_BASE}/health`, {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
        });
        if (!response.ok) {
            serverState = response.status === 404 ? 'missing' : 'error';
            return null;
        }
        const payload = await response.json();
        if (!payload?.ok) {
            serverState = 'error';
            return null;
        }
        serverHealth = payload;
        serverState = 'available';
        return payload;
    } catch (error) {
        serverState = error?.name === 'AbortError' ? 'error' : 'missing';
        console.debug(LOG_PREFIX, '可选服务端增强不可用，继续使用纯 UI 模式', error);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function requireServerPlugin() {
    const health = await probeServerPlugin({ force: serverState !== 'available' });
    if (!health) {
        throw new Error('当前为纯 UI 模式；安装可选服务端插件后才能使用静态资源缓存');
    }
    return health;
}

function workerFor(registration) {
    return registration?.active || registration?.waiting || registration?.installing || navigator.serviceWorker.controller;
}

async function sendWorkerMessage(type, payload = {}, timeout = 15000) {
    const registration = await findRootRegistration();
    if (!registration || !isOurWorker(registration)) throw new Error('静态资源缓存尚未启用');
    const worker = workerFor(registration);
    if (!worker) throw new Error('静态资源缓存尚未激活');

    return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => reject(new Error('静态资源缓存响应超时')), timeout);
        channel.port1.onmessage = event => {
            clearTimeout(timer);
            event.data?.ok ? resolve(event.data) : reject(new Error(event.data?.error || '静态资源缓存执行失败'));
        };
        worker.postMessage({ type, ...payload }, [channel.port2]);
    });
}

async function registerWorker() {
    if (!isSecureContextAvailable()) {
        serverState = 'unsupported';
        throw new Error('静态资源缓存需要 HTTPS（或 localhost）；前端优化仍可正常使用');
    }
    await requireServerPlugin();
    const current = await findRootRegistration({ refresh: true });
    if (current && !isOurWorker(current)) {
        serverState = 'conflict';
        throw new Error('站点根路径已有其他 Service Worker，本插件不会覆盖；前端优化仍可使用');
    }

    cachedRegistration = await navigator.serviceWorker.register(
        `${API_BASE}/service-worker.js?v=${encodeURIComponent(CLIENT_VERSION)}`,
        { scope: '/', updateViaCache: 'none' },
    );
    await navigator.serviceWorker.ready;
    await sendWorkerMessage('CONFIG', { allowThirdParty: settings.cacheThirdPartyAssets });
    return cachedRegistration;
}

function collectWarmUrls() {
    const urls = new Set([
        new URL('/script.js', location.href).href,
        new URL('/style.css', location.href).href,
        new URL('/lib.js', location.href).href,
        new URL('/locales/lang.json', location.href).href,
        ...INTERACTIVE_CORE_URLS.map(path => new URL(path, location.href).href),
    ]);
    for (const entry of performance.getEntriesByType('resource')) {
        try {
            const url = new URL(entry.name, location.href);
            if (url.origin === location.origin) urls.add(url.href);
        } catch {
            // Ignore malformed entries from third-party instrumentation.
        }
    }
    return [...urls];
}

function cancelScheduledWarmup() {
    if (scheduledWarmup === null) return;
    if (scheduledWarmup.kind === 'idle' && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(scheduledWarmup.id);
    } else {
        clearTimeout(scheduledWarmup.id);
    }
    scheduledWarmup = null;
}

function scheduleAutoWarmup() {
    cancelScheduledWarmup();
    if (!appReady || serverState !== 'available') return;
    if (!shouldAutoWarm({
        enabled: settings.enabled,
        autoWarm: settings.autoWarm,
        visible: document.visibilityState === 'visible',
        connection: navigator.connection,
        lastWarmVersion: settings.lastWarmVersion,
    })) return;

    const run = async () => {
        scheduledWarmup = null;
        if (document.visibilityState !== 'visible') return;
        try {
            await frontendScheduler.schedule(() => warmCurrentInstall(), { priority: 4 });
            settings.lastWarmVersion = CLIENT_VERSION;
            persistSettings();
        } catch (error) {
            console.warn(LOG_PREFIX, '后台预热未完成', error);
        }
    };

    if ('requestIdleCallback' in window) {
        scheduledWarmup = {
            kind: 'idle',
            id: window.requestIdleCallback(() => void run(), { timeout: 15000 }),
        };
    } else {
        scheduledWarmup = { kind: 'timer', id: setTimeout(() => void run(), 8000) };
    }
}

async function warmCurrentInstall() {
    const result = await sendWorkerMessage('WARM', { urls: collectWarmUrls() }, 120000);
    lastWorkerStats = null;
    return result;
}

async function unregisterWorker({ clear = true } = {}) {
    let unregistered = false;
    if ('serviceWorker' in navigator) {
        const registration = await findRootRegistration({ refresh: true });
        if (registration && isOurWorker(registration)) {
            if (clear) {
                try {
                    await sendWorkerMessage('CLEAR');
                } catch (error) {
                    console.warn(LOG_PREFIX, '通过 Worker 清理缓存失败', error);
                }
            }
            unregistered = await registration.unregister();
            cachedRegistration = null;
        }
    }

    if (clear && 'caches' in window) {
        try {
            const names = await caches.keys();
            await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX)).map(name => caches.delete(name)));
        } catch (error) {
            console.warn(LOG_PREFIX, '从页面清理缓存失败', error);
        }
    }
    lastWorkerStats = null;
    return unregistered;
}

async function removeLocalAcceleration() {
    const confirmed = globalThis.confirm('确定删除这台设备上的静态资源缓存吗？\n\n前端长聊天优化仍会保留；聊天、角色卡、设置和服务器文件不会被删除。');
    if (!confirmed) return { cancelled: true };
    settings.enabled = false;
    settings.lastWarmVersion = '';
    persistSettings();
    cancelScheduledWarmup();
    await unregisterWorker({ clear: true });
    lastError = '';
    return { cancelled: false };
}

function nextAnimationFrame(priority = 2) {
    return frontendScheduler.yield(priority);
}

function renderFrontendTaskState() {
    const container = document.querySelector(`#${ROOT_ID} [data-cloud-task]`);
    if (!container) return;
    const progress = container.querySelector('progress');
    const label = container.querySelector('[data-cloud-task-label]');
    const cancel = container.querySelector('[data-cloud-task-cancel]');
    const { status, completed, total, elapsedMs } = frontendTaskState;
    container.hidden = status === 'idle';
    container.dataset.state = status;
    if (progress) {
        progress.max = Math.max(1, total);
        progress.value = Math.min(completed, Math.max(1, total));
    }
    if (label) {
        const count = total > 0 ? ` · ${completed} / ${total}` : '';
        const elapsed = elapsedMs > 0 ? ` · ${formatMilliseconds(elapsedMs)}` : '';
        label.textContent = `${frontendTaskState.label}${count}${elapsed}`;
    }
    if (cancel) cancel.hidden = status !== 'running';
}

function setFrontendTaskState(taskId, patch) {
    if (taskId !== frontendTaskGeneration) return false;
    frontendTaskState = { ...frontendTaskState, ...patch };
    renderFrontendTaskState();
    return true;
}

function beginFrontendTask(label, total = 0, kind = '') {
    frontendTaskGeneration += 1;
    frontendTaskState = {
        status: 'running',
        kind,
        label,
        completed: 0,
        total,
        elapsedMs: 0,
    };
    renderFrontendTaskState();
    return frontendTaskGeneration;
}

function cancelFrontendTask(label = '任务已取消') {
    frontendTaskGeneration += 1;
    frontendTaskState = {
        ...frontendTaskState,
        status: 'cancelled',
        label,
    };
    renderFrontendTaskState();
}

async function getChatUiApi() {
    chatUiApiPromise ||= import('../../../../script.js');
    return chatUiApiPromise;
}

function getMessageRenderDetails() {
    const chatElement = document.querySelector('#chat');
    if (!chatElement) return [];
    const chatRect = chatElement.getBoundingClientRect();
    const elements = [...chatElement.querySelectorAll('.mes[mesid]')];
    const recentIds = new Set(elements.slice(-5).map(element => Number(element.getAttribute('mesid'))));

    const descriptors = elements.map(element => {
        const messageId = Number(element.getAttribute('mesid'));
        const rect = element.getBoundingClientRect();
        const domNodes = element.querySelectorAll('*').length;
        const htmlLength = element.innerHTML.length;
        const richElements = element.querySelectorAll('details, table, pre, svg, iframe').length;
        return {
            element,
            messageId,
            visible: rect.bottom >= chatRect.top && rect.top <= chatRect.bottom,
            recent: recentIds.has(messageId),
            complexity: estimateRenderComplexity({ domNodes, htmlLength, richElements }),
        };
    }).filter(item => Number.isInteger(item.messageId) && chat[item.messageId]);

    return prioritizeMessageDescriptors(descriptors);
}

async function reapplyRegexRendering() {
    const api = await getChatUiApi();
    if (typeof api.updateMessageBlock !== 'function') {
        throw new Error('当前 SillyTavern 版本不支持局部消息刷新，请使用“完整重载（高级）”');
    }

    const descriptors = getMessageRenderDetails();
    if (!descriptors.length) throw new Error('当前聊天没有可刷新的已显示消息');

    const taskId = beginFrontendTask('正在原地重新应用正则', descriptors.length, 'regexRefresh');
    const startedAt = performance.now();
    let completed = 0;
    let failed = 0;
    let batchSize = 4;
    let previousFrameMs = 0;

    takeoverController?.setRegexRefreshing(true);
    try {
        while (completed < descriptors.length) {
            await nextAnimationFrame(descriptors[completed]?.visible ? 0 : (descriptors[completed]?.recent ? 1 : 2));
            if (taskId !== frontendTaskGeneration) return { cancelled: true, completed, total: descriptors.length };

            const frameStartedAt = performance.now();
            const nextComplexity = descriptors[completed]?.complexity || 0;
            batchSize = getAdaptiveBatchSize({
                complexity: nextComplexity,
                previousFrameMs,
                currentBatch: batchSize,
            });
            let processedThisFrame = 0;

            while (completed < descriptors.length && processedThisFrame < batchSize) {
                if (taskId !== frontendTaskGeneration) return { cancelled: true, completed, total: descriptors.length };
                const descriptor = descriptors[completed];
                try {
                    api.updateMessageBlock(descriptor.messageId, chat[descriptor.messageId], { rerenderMessage: true });
                } catch (error) {
                    failed += 1;
                    console.warn(LOG_PREFIX, `局部刷新消息 ${descriptor.messageId} 失败`, error);
                }
                completed += 1;
                processedThisFrame += 1;
                if (performance.now() - frameStartedAt >= 12) break;
            }

            previousFrameMs = performance.now() - frameStartedAt;
            setFrontendTaskState(taskId, {
                completed,
                elapsedMs: performance.now() - startedAt,
            });
        }

        const elapsedMs = performance.now() - startedAt;
        setFrontendTaskState(taskId, {
            status: failed ? 'warning' : 'done',
            label: failed ? `局部刷新完成，${failed} 条失败` : '局部刷新完成',
            completed,
            elapsedMs,
        });
        scheduleChatDiagnosticCapture();
        return { cancelled: false, completed, failed, total: descriptors.length, elapsedMs };
    } finally {
        takeoverController?.setRegexRefreshing(false);
    }
}

async function fullReloadRegexRendering() {
    const confirmed = globalThis.confirm(
        '完整重载会清空正则编译缓存、重新请求并渲染当前聊天，期间可能出现短暂空白。\n\n仅在局部刷新无效或正则状态异常时使用。是否继续？',
    );
    if (!confirmed) return { cancelled: true };

    const taskId = beginFrontendTask('正在完整重载聊天', 0, 'fullReload');
    const startedAt = performance.now();
    try {
        const regexEngine = await import('../../regex/engine.js');
        regexEngine.RegexProvider?.instance?.clear?.();
    } catch (error) {
        console.debug(LOG_PREFIX, '当前版本没有可清理的正则编译缓存', error);
    }
    if (taskId !== frontendTaskGeneration) return { cancelled: true };
    try {
        await reloadCurrentChat();
    } catch (error) {
        setFrontendTaskState(taskId, {
            status: 'error',
            label: error instanceof Error ? error.message : String(error),
            elapsedMs: performance.now() - startedAt,
        });
        throw error;
    }
    const elapsedMs = performance.now() - startedAt;
    setFrontendTaskState(taskId, {
        status: 'done',
        label: '完整重载完成',
        completed: 1,
        total: 1,
        elapsedMs,
    });
    return { cancelled: false, elapsedMs };
}

function getVisibleMessageAnchor() {
    const chatElement = document.querySelector('#chat');
    if (!chatElement) return null;
    const chatRect = chatElement.getBoundingClientRect();
    const element = [...chatElement.querySelectorAll('.mes[mesid]')].find(message => {
        const rect = message.getBoundingClientRect();
        return rect.bottom >= chatRect.top && rect.top <= chatRect.bottom;
    });
    if (!element) return null;
    const messageId = Number(element.getAttribute('mesid'));
    return Number.isInteger(messageId) ? { messageId, top: element.getBoundingClientRect().top } : null;
}

async function loadEarlierMessagesSmoothly(limit = 10, { source = 'manual' } = {}) {
    if (source === 'auto' && frontendTaskState.status === 'running') {
        return { cancelled: true, completed: 0, total: 0 };
    }
    const api = await getChatUiApi();
    if (typeof api.showMoreMessages !== 'function') {
        throw new Error('当前 SillyTavern 版本不支持官方“显示更多”接口');
    }
    const first = document.querySelector('#chat .mes[mesid]');
    const firstId = Number(first?.getAttribute('mesid'));
    if (!Number.isInteger(firstId) || firstId <= 0) return { empty: true, cancelled: false, completed: 0 };

    const total = Math.min(limit, firstId);
    const taskId = beginFrontendTask('正在平滑加载更早消息', total, 'loadEarlier');
    const startedAt = performance.now();
    let completed = 0;
    let batchSize = settings?.heavyBeautifyMode ? 1 : 2;
    let previousFrameMs = 0;

    while (completed < total) {
        if (taskId !== frontendTaskGeneration) return { cancelled: true, completed, total };
        const anchor = getVisibleMessageAnchor();
        const count = Math.min(batchSize, total - completed);
        const frameStartedAt = performance.now();
        try {
            await api.showMoreMessages(count);
        } catch (error) {
            setFrontendTaskState(taskId, {
                status: 'error',
                label: error instanceof Error ? error.message : String(error),
                elapsedMs: performance.now() - startedAt,
            });
            throw error;
        }
        await nextAnimationFrame(2);
        if (taskId !== frontendTaskGeneration) return { cancelled: true, completed, total };

        if (anchor) {
            const anchorElement = document.querySelector(`#chat .mes[mesid="${anchor.messageId}"]`);
            const chatElement = document.querySelector('#chat');
            if (anchorElement && chatElement) {
                const delta = anchorElement.getBoundingClientRect().top - anchor.top;
                if (Math.abs(delta) > 0.5) chatElement.scrollTop += delta;
            }
        }

        completed += count;
        previousFrameMs = performance.now() - frameStartedAt;
        batchSize = Math.min(3, getAdaptiveBatchSize({
            complexity: getChatComplexity().renderComplexity,
            previousFrameMs,
            currentBatch: batchSize,
        }));
        setFrontendTaskState(taskId, {
            completed,
            elapsedMs: performance.now() - startedAt,
        });
    }

    const elapsedMs = performance.now() - startedAt;
    setFrontendTaskState(taskId, {
        status: 'done',
        label: '更早消息加载完成',
        completed,
        elapsedMs,
    });
    scheduleChatDiagnosticCapture();
    return { empty: false, cancelled: false, completed, total, elapsedMs };
}

async function getPowerUserSettings() {
    const module = await import('../../power-user.js');
    if (!module.power_user) throw new Error('当前 SillyTavern 版本未提供聊天截断设置');
    return module.power_user;
}

async function syncDisplayedChatLimit(limit) {
    const chatElement = document.querySelector('#chat');
    if (!chatElement || !Number.isFinite(limit) || limit < 1) return;
    const messages = [...chatElement.querySelectorAll('.mes[mesid]')];
    if (messages.length > limit) {
        messages.slice(0, messages.length - limit).forEach(message => message.remove());
        const firstRemaining = chatElement.querySelector('.mes[mesid]');
        const firstId = Number(firstRemaining?.getAttribute('mesid'));
        if (firstRemaining && firstId > 0 && !chatElement.querySelector('#show_more_messages')) {
            const showMore = document.createElement('div');
            showMore.id = 'show_more_messages';
            showMore.textContent = '显示更多消息';
            firstRemaining.before(showMore);
        }
        queueRenderBoostRefresh();
        scheduleChatDiagnosticCapture();
        return;
    }
    if (messages.length < limit) {
        const firstId = Number(messages[0]?.getAttribute('mesid'));
        if (Number.isInteger(firstId) && firstId > 0) {
            await loadEarlierMessagesSmoothly(Math.min(limit - messages.length, firstId));
        }
    }
}

async function applyLongChatMode({ reload = false } = {}) {
    const powerUser = await getPowerUserSettings();
    if (settings.longChatMode) {
        if (!Number.isFinite(settings.previousChatTruncation)) {
            settings.previousChatTruncation = Number.isFinite(powerUser.chat_truncation)
                ? powerUser.chat_truncation
                : 100;
        }
        powerUser.chat_truncation = settings.longChatLimit;
    } else if (Number.isFinite(settings.previousChatTruncation)) {
        powerUser.chat_truncation = settings.previousChatTruncation;
        settings.previousChatTruncation = null;
    }
    persistSettings();
    if (reload) {
        if (settings.takeoverEnabled) await syncDisplayedChatLimit(powerUser.chat_truncation);
        else await reloadCurrentChat();
    }
}

async function setHeavyBeautifyMode(enabled) {
    if (enabled) {
        if (!settings.heavyBeautifyMode) {
            settings.heavyModePrevious = {
                renderBoost: settings.renderBoost,
                longChatMode: settings.longChatMode,
                longChatLimit: settings.longChatLimit,
            };
        }
        settings.heavyBeautifyMode = true;
        settings.renderBoost = true;
        settings.longChatMode = true;
        if (settings.longChatLimit > 20) settings.longChatLimit = 20;
    } else {
        const previous = settings.heavyModePrevious;
        settings.heavyBeautifyMode = false;
        settings.renderBoost = previous?.renderBoost === true;
        settings.longChatMode = previous?.longChatMode === true;
        settings.longChatLimit = previous?.longChatLimit || 20;
        settings.heavyModePrevious = null;
    }
    persistSettings();
    settings.renderBoost ? startRenderObserver() : stopRenderObserver();
    await applyLongChatMode({ reload: true });
}

async function restoreLongChatMode({ reload = false } = {}) {
    if (!settings?.longChatMode || !Number.isFinite(settings.previousChatTruncation)) return;
    const powerUser = await getPowerUserSettings();
    powerUser.chat_truncation = settings.previousChatTruncation;
    saveSettingsDebounced();
    if (reload) await reloadCurrentChat();
}

function stopRenderObserver() {
    renderObserver?.disconnect();
    renderObserver = null;
    renderRefreshFrame = null;
    document.body?.classList.remove('cla-render-boost-active');
    document.querySelectorAll('#chat .mes.cla-render-live').forEach(message => message.classList.remove('cla-render-live'));
}

function refreshRenderBoostState() {
    renderRefreshFrame = null;
    const chat = document.querySelector('#chat');
    const messages = chat ? [...chat.querySelectorAll('.mes')] : [];
    const active = shouldActivateRenderBoost({
        enabled: settings?.renderBoost,
        messageCount: messages.length,
        threshold: settings?.heavyBeautifyMode ? 1 : settings?.renderBoostThreshold,
    });
    document.body?.classList.toggle('cla-render-boost-active', active);
    messages.forEach(message => message.classList.remove('cla-render-live'));
    if (active) messages.slice(-5).forEach(message => message.classList.add('cla-render-live'));
}

function queueRenderBoostRefresh() {
    if (renderRefreshFrame !== null) return;
    renderRefreshFrame = true;
    void frontendScheduler.schedule(refreshRenderBoostState, { priority: 2 }).catch(error => {
        renderRefreshFrame = null;
        if (error?.name !== 'AbortError') console.error(LOG_PREFIX, '渲染减负调度失败', error);
    });
}

function startRenderObserver() {
    stopRenderObserver();
    if (!settings?.renderBoost) return;
    const chat = document.querySelector('#chat');
    if (!chat) return;
    renderObserver = new MutationObserver(queueRenderBoostRefresh);
    renderObserver.observe(chat, { childList: true });
    queueRenderBoostRefresh();
}

function nodeContainsMessage(node) {
    return node instanceof Element
        && (node.matches('.mes') || Boolean(node.querySelector('.mes')));
}

function getChatComplexity() {
    const chatElement = document.querySelector('#chat');
    const domNodes = chatElement?.querySelectorAll('*').length || 0;
    const htmlLength = chatElement?.innerHTML.length || 0;
    const richElements = chatElement?.querySelectorAll('details, table, pre, svg, iframe').length || 0;
    return {
        displayedMessages: chatElement?.querySelectorAll('.mes').length || 0,
        totalMessages: Array.isArray(chat) ? chat.length : 0,
        domNodes,
        htmlLength,
        richElements,
        renderComplexity: estimateRenderComplexity({ domNodes, htmlLength, richElements }),
    };
}

function formatRenderComplexity(value) {
    if (!Number.isFinite(value)) return '—';
    const level = value >= 1800 ? '重' : (value >= 700 ? '中' : '轻');
    return `${level} · ${Math.round(value).toLocaleString()}`;
}

function updateChatDiagnosticFields() {
    if (!latestChatDiagnostics) return;
    const fields = {
        chatRequest: formatMilliseconds(latestChatDiagnostics.requestMs),
        chatTransfer: formatBytes(latestChatDiagnostics.transferBytes),
        displayedMessages: String(latestChatDiagnostics.displayedMessages),
        totalMessages: String(latestChatDiagnostics.totalMessages),
        domNodes: latestChatDiagnostics.domNodes.toLocaleString(),
        renderComplexity: formatRenderComplexity(latestChatDiagnostics.renderComplexity),
        firstContent: formatMilliseconds(latestChatDiagnostics.firstContentMs),
        frontendWork: formatMilliseconds(latestChatDiagnostics.frontendMs),
        totalLoad: formatMilliseconds(latestChatDiagnostics.totalLoadMs),
        longestTask: Number.isFinite(latestChatDiagnostics.longestTaskMs)
            ? formatMilliseconds(latestChatDiagnostics.longestTaskMs)
            : (longTaskObserver ? '< 50 ms' : '—'),
    };
    for (const [name, value] of Object.entries(fields)) {
        const node = document.querySelector(`#${ROOT_ID} [data-cloud-metric="${name}"]`);
        if (node) node.textContent = value;
    }
}

function captureChatDiagnostics({ includeTiming = true } = {}) {
    diagnosticRefreshFrame = null;
    const now = performance.now();
    const latestRequestEntry = includeTiming
        ? findLatestChatRequest(performance.getEntriesByType('resource'), now)
        : null;
    const requestEntry = latestRequestEntry
        && (!Number.isFinite(chatLoadStart) || latestRequestEntry.responseEnd >= chatLoadStart)
        ? latestRequestEntry
        : null;
    const complexity = getChatComplexity();
    const timing = buildChatDiagnostics({
        now,
        requestEntry,
        loadStart: includeTiming ? chatLoadStart : null,
        firstContentAt: includeTiming ? firstContentAt : null,
        ...complexity,
        longTasks: recentLongTasks,
    });
    latestChatDiagnostics = includeTiming || !latestChatDiagnostics
        ? { ...timing, ...complexity }
        : { ...latestChatDiagnostics, ...complexity, measuredAt: now };
    updateChatDiagnosticFields();
}

function scheduleChatDiagnosticCapture({ includeTiming = false } = {}) {
    diagnosticIncludeTiming ||= includeTiming;
    if (diagnosticRefreshFrame !== null) return;
    diagnosticRefreshFrame = true;
    void frontendScheduler.schedule(() => {
        const shouldIncludeTiming = diagnosticIncludeTiming;
        diagnosticIncludeTiming = false;
        captureChatDiagnostics({ includeTiming: shouldIncludeTiming });
    }, { priority: 3 }).catch(error => {
        diagnosticRefreshFrame = null;
        if (error?.name !== 'AbortError') console.error(LOG_PREFIX, '聊天诊断调度失败', error);
    });
}

function startChatDiagnostics() {
    stopChatDiagnostics();
    const chatElement = document.querySelector('#chat');
    if (!chatElement) return;

    latestChatDiagnostics = null;
    chatDiagnosticObserver = new MutationObserver(records => {
        const removedMessage = records.some(record => [...record.removedNodes].some(nodeContainsMessage));
        const addedMessage = records.some(record => [...record.addedNodes].some(nodeContainsMessage));
        if (removedMessage) {
            chatLoadStart = performance.now();
            firstContentAt = null;
            recentLongTasks = [];
        }
        if (addedMessage && firstContentAt === null) firstContentAt = performance.now();
        if (removedMessage || addedMessage) scheduleChatDiagnosticCapture();
    });
    chatDiagnosticObserver.observe(chatElement, { childList: true });

    if ('PerformanceObserver' in window) {
        try {
            longTaskObserver = new PerformanceObserver(list => {
                recentLongTasks.push(...list.getEntries().map(entry => ({
                    startTime: entry.startTime,
                    duration: entry.duration,
                })));
                if (recentLongTasks.length > 200) recentLongTasks = recentLongTasks.slice(-200);
            });
            longTaskObserver.observe({ type: 'longtask', buffered: true });
        } catch (error) {
            longTaskObserver = null;
            console.debug(LOG_PREFIX, '当前浏览器不支持 Long Tasks 诊断', error);
        }
    }

    chatChangedHandler = () => {
        if (frontendTaskState.status === 'running' && frontendTaskState.kind !== 'fullReload') {
            cancelFrontendTask('聊天已切换，任务已取消');
        }
        scheduleChatDiagnosticCapture({ includeTiming: true });
    };
    eventSource.on(event_types.CHAT_CHANGED, chatChangedHandler);
    captureChatDiagnostics({ includeTiming: false });
}

function stopChatDiagnostics() {
    chatDiagnosticObserver?.disconnect();
    chatDiagnosticObserver = null;
    longTaskObserver?.disconnect();
    longTaskObserver = null;
    if (chatChangedHandler) eventSource.removeListener(event_types.CHAT_CHANGED, chatChangedHandler);
    chatChangedHandler = null;
    diagnosticRefreshFrame = null;
    diagnosticIncludeTiming = false;
    chatLoadStart = null;
    firstContentAt = null;
    recentLongTasks = [];
}

function getNavigationMetrics() {
    const navigation = performance.getEntriesByType('navigation')[0];
    if (!navigation) return null;
    return {
        ttfb: Math.max(0, navigation.responseStart - navigation.requestStart),
        interactive: Math.max(0, navigation.domInteractive - navigation.startTime),
        transferred: navigation.transferSize || 0,
        protocol: navigation.nextHopProtocol || (navigator.serviceWorker?.controller ? 'Service Worker' : '未知'),
    };
}

function formatMilliseconds(value) {
    return Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
}

function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function setStatus(text, state = '') {
    const node = document.querySelector(`#${ROOT_ID} [data-cloud-status]`);
    if (!node) return;
    node.textContent = text;
    node.dataset.state = state;
}

async function getRuntimeState({ includeStats = false } = {}) {
    if (!appReady || serverState === 'unknown') {
        return { state: 'ui', label: '前端模式已就绪 · 静态缓存将在酒馆启动完成后检查' };
    }
    if (serverState === 'unsupported') {
        return { state: 'ui', label: '仅 UI 模式 · 前端优化可用；静态缓存需要 HTTPS 或 localhost' };
    }
    if (serverState === 'missing') {
        return { state: 'ui', label: '仅 UI 模式 · 前端优化可用；服务端静态缓存未安装' };
    }
    if (serverState === 'error') {
        return { state: 'ui', label: '仅 UI 模式 · 服务端增强暂时不可达，前端优化不受影响' };
    }
    if (serverState === 'conflict') {
        return { state: 'conflict', label: '仅 UI 模式 · 站点已有其他 Service Worker，本插件未覆盖' };
    }

    const registration = await findRootRegistration();
    if (!registration) return { state: 'available', label: '前端模式已就绪 · 可选静态缓存尚未启用' };
    if (!isOurWorker(registration)) return { state: 'conflict', label: '仅 UI 模式 · 站点已有其他 Service Worker' };
    if (includeStats) lastWorkerStats = await sendWorkerMessage('STATS');
    return {
        state: 'active',
        label: lastWorkerStats
            ? `完整模式 · 已缓存 ${lastWorkerStats.entries} 个程序资源`
            : '完整模式 · 前端优化与静态资源缓存均已启用',
        stats: lastWorkerStats,
    };
}

async function refreshPanel({ includeStats = false } = {}) {
    if (!document.getElementById(ROOT_ID) || !settings) return;
    const status = await getRuntimeState({ includeStats }).catch(error => ({ state: 'error', label: error.message }));
    if (status.state === 'active') lastError = '';
    setStatus(lastError || status.label, lastError ? 'error' : status.state);

    const enabled = document.querySelector(`#${ROOT_ID} [data-cloud-enabled]`);
    if (enabled) {
        enabled.checked = settings.enabled;
        enabled.indeterminate = settings.enabled && serverState !== 'available';
    }
    const serverControls = document.querySelectorAll(`#${ROOT_ID} [data-needs-server]`);
    const canUseServer = serverState === 'available';
    serverControls.forEach(control => {
        control.disabled = !canUseServer;
        control.title = canUseServer ? '' : '安装并启用可选服务端插件后可用';
    });

    const heavyMode = document.querySelector(`#${ROOT_ID} [data-cloud-heavy-mode]`);
    const renderBoost = document.querySelector(`#${ROOT_ID} [data-cloud-render-boost]`);
    const longChatMode = document.querySelector(`#${ROOT_ID} [data-cloud-long-chat]`);
    const longChatLimit = document.querySelector(`#${ROOT_ID} [data-cloud-chat-limit]`);
    if (heavyMode) heavyMode.checked = settings.heavyBeautifyMode;
    if (renderBoost) {
        renderBoost.checked = settings.renderBoost;
        renderBoost.disabled = settings.heavyBeautifyMode;
    }
    if (longChatMode) {
        longChatMode.checked = settings.longChatMode;
        longChatMode.disabled = settings.heavyBeautifyMode || settings.adaptiveChatLimit;
    }
    if (longChatLimit) {
        longChatLimit.value = String(settings.longChatLimit);
        longChatLimit.disabled = settings.heavyBeautifyMode || settings.adaptiveChatLimit;
    }
    const takeoverStatusNode = document.querySelector(`#${ROOT_ID} [data-cloud-takeover-status]`);
    if (takeoverStatusNode) {
        takeoverStatusNode.dataset.state = takeoverState;
        takeoverStatusNode.textContent = takeoverLabel;
    }
    const takeoverMaster = document.querySelector(`#${ROOT_ID} [data-cloud-takeover-master]`);
    if (takeoverMaster) takeoverMaster.checked = settings.takeoverEnabled;
    document.querySelectorAll(`#${ROOT_ID} [data-cloud-setting]`).forEach(input => {
        const key = input.dataset.cloudSetting;
        if (key && key in settings && input instanceof HTMLInputElement) input.checked = settings[key] === true;
    });
    const intensity = document.querySelector(`#${ROOT_ID} [data-cloud-takeover-intensity]`);
    if (intensity) intensity.value = settings.takeoverIntensity;

    const metrics = getNavigationMetrics();
    const fields = {
        ttfb: metrics ? formatMilliseconds(metrics.ttfb) : '—',
        interactive: metrics ? formatMilliseconds(metrics.interactive) : '—',
        transferred: metrics ? formatBytes(metrics.transferred) : '—',
        protocol: metrics?.protocol || '—',
        hits: status.stats ? String(status.stats.hits) : '按需查询',
    };
    for (const [name, value] of Object.entries(fields)) {
        const node = document.querySelector(`#${ROOT_ID} [data-cloud-metric="${name}"]`);
        if (node) node.textContent = value;
    }
    updateChatDiagnosticFields();
}

function makeMetric(label, key) {
    const item = document.createElement('div');
    item.className = 'cla-metric';
    const name = document.createElement('small');
    name.textContent = label;
    const value = document.createElement('strong');
    value.dataset.cloudMetric = key;
    value.textContent = '—';
    item.append(name, value);
    return item;
}

function makeButton(label, iconClass, handler, {
    danger = false,
    needsServer = false,
    lockWhileRunning = true,
} = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button cla-action';
    if (danger) button.classList.add('cla-action-danger');
    if (needsServer) button.dataset.needsServer = '';
    const text = document.createElement('span');
    text.textContent = label;
    if (iconClass) {
        const icon = document.createElement('i');
        icon.className = iconClass;
        button.append(icon);
    }
    button.append(text);
    button.addEventListener('click', async () => {
        if (lockWhileRunning) button.disabled = true;
        lastError = '';
        try {
            await handler();
        } catch (error) {
            if (error?.name !== 'AbortError') {
                lastError = error instanceof Error ? error.message : String(error);
                console.error(LOG_PREFIX, error);
            }
        } finally {
            if (lockWhileRunning) button.disabled = false;
            await refreshPanel();
        }
    });
    return button;
}

function makeSectionTitle(title, description) {
    const section = document.createElement('div');
    section.className = 'cla-section-title';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const note = document.createElement('small');
    note.textContent = description;
    section.append(heading, note);
    return section;
}

function makeSwitch(title, description) {
    const row = document.createElement('label');
    row.className = 'checkbox_label cla-switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    const text = document.createElement('span');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const note = document.createElement('small');
    note.textContent = description;
    text.append(heading, note);
    row.append(input, text);
    return { row, input, text };
}

function mountPanel() {
    if (document.getElementById(ROOT_ID)) return true;
    const host = document.querySelector('#extensions_settings2')
        || document.querySelector('#extensions_settings')
        || document.querySelector('#extensions_settings_block');
    if (!host) return false;

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'inline-drawer cla-panel';

    const header = document.createElement('div');
    header.className = 'inline-drawer-toggle inline-drawer-header';
    const heading = document.createElement('b');
    heading.textContent = '云酒馆加速器';
    const drawerIcon = document.createElement('div');
    drawerIcon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
    header.append(heading, drawerIcon);
    header.addEventListener('click', () => setTimeout(() => {
        if (serverState === 'available') void refreshPanel({ includeStats: true });
    }, 0));

    const body = document.createElement('div');
    body.className = 'inline-drawer-content cla-body';
    const intro = document.createElement('p');
    intro.className = 'cla-intro';
    intro.textContent = '只安装 UI 扩展也能使用前端优化；服务端插件仅用于额外的静态资源缓存。聊天、角色卡、设置和 API 响应永远不会写入 Cache Storage。';

    const takeoverTitle = makeSectionTitle('全局前端接管', '统一调度启动预取、正则重绘、旧消息补载、聊天代码高亮和移动端手势；默认开启，连续异常会自动恢复原生流程。');
    const takeoverMaster = makeSwitch(
        '强力前端接管',
        '总开关。关闭会立即还原 fetch、代码高亮代理、事件、Observer 和计时器；静态资源缓存不受影响。',
    );
    takeoverMaster.row.classList.add('cla-takeover-master');
    takeoverMaster.input.dataset.cloudTakeoverMaster = '';
    takeoverMaster.input.checked = settings.takeoverEnabled;
    takeoverMaster.input.addEventListener('change', async () => {
        takeoverMaster.input.disabled = true;
        settings.takeoverEnabled = takeoverMaster.input.checked;
        persistSettings();
        try {
            if (settings.takeoverEnabled) await ensureTakeoverController().start();
            else await takeoverController?.stop({ reason: '已恢复酒馆原生流程' });
        } finally {
            takeoverMaster.input.disabled = false;
            await refreshPanel();
        }
    });

    const takeoverStatusNode = document.createElement('div');
    takeoverStatusNode.className = 'cla-status cla-takeover-status';
    takeoverStatusNode.dataset.cloudTakeoverStatus = '';
    takeoverStatusNode.dataset.state = takeoverState;
    takeoverStatusNode.textContent = takeoverLabel;

    const intensityRow = document.createElement('label');
    intensityRow.className = 'cla-select-row';
    const intensityText = document.createElement('span');
    intensityText.textContent = '接管强度';
    const intensitySelect = document.createElement('select');
    intensitySelect.className = 'text_pole';
    intensitySelect.dataset.cloudTakeoverIntensity = '';
    const intensityLabels = { balanced: '平衡 · 8 ms', strong: '强力 · 10 ms', extreme: '极致 · 12 ms' };
    for (const value of TAKEOVER_INTENSITIES) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = intensityLabels[value];
        option.selected = settings.takeoverIntensity === value;
        intensitySelect.append(option);
    }
    intensitySelect.addEventListener('change', () => {
        settings.takeoverIntensity = intensitySelect.value;
        frontendScheduler.setBudget(budgetForIntensity(settings.takeoverIntensity));
        persistSettings();
    });
    intensityRow.append(intensityText, intensitySelect);

    const takeoverSwitchGrid = document.createElement('div');
    takeoverSwitchGrid.className = 'cla-takeover-grid';
    const takeoverSwitchDefinitions = [
        ['earlyUi', '提前显示主界面', '设置加载后释放官方启动遮罩，并提示后台仍在初始化；下次启动生效。'],
        ['requestPrefetch', '初始化请求预取与去重', '仅在本页内复用完全相同的角色、头像、背景和扩展模板请求。'],
        ['regexAutoRefresh', '正则编辑器统一刷新', '连续保存、开关和批量操作合并成一次视口优先局部刷新。'],
        ['adaptiveChatLimit', '自适应首屏消息数', '根据聊天内容、富组件、设备核心数和内存提示自动选择 8～30 条。'],
        ['autoLoadOlder', '自动加载旧消息', '靠近聊天顶部时小批量补入旧消息，并代理官方“显示更多”按钮。'],
        ['deferChatHighlight', '聊天代码延迟高亮', '最近 3 条立即高亮，旧代码块进入视口后再处理；不影响聊天外代码。'],
        ['skipOldHighlight', '旧代码块不自动高亮', '屏幕外旧代码保持纯文本；最近消息仍正常高亮。'],
        ['collapseOldCode', '旧代码块默认折叠', '点击旧代码块后展开并按需高亮。'],
        ['mobileSwipeGuard', '移动端滑动保护', '垂直滚动时阻止误触消息左右切换，明确横向手势保持原生行为。'],
    ];
    for (const [key, title, description] of takeoverSwitchDefinitions) {
        const item = makeSwitch(title, description);
        item.input.dataset.cloudSetting = key;
        item.input.checked = settings[key];
        item.input.addEventListener('change', () => {
            settings[key] = item.input.checked;
            persistSettings();
        });
        takeoverSwitchGrid.append(item.row);
    }

    const autoLoadConfig = document.createElement('div');
    autoLoadConfig.className = 'cla-compact-settings';
    const compactChoices = [
        ['每批旧消息', 'autoLoadBatch', [1, 2, 3, 6, 10], value => `${value} 条`],
        ['顶部触发距离', 'autoLoadDistance', [80, 120, 180, 260, 400], value => `${value} px`],
        ['加载冷却', 'autoLoadCooldown', [300, 700, 1200, 2000], value => `${value} ms`],
    ];
    for (const [label, key, choices, formatter] of compactChoices) {
        const row = document.createElement('label');
        const text = document.createElement('small');
        text.textContent = label;
        const select = document.createElement('select');
        select.className = 'text_pole';
        for (const value of choices) {
            const option = document.createElement('option');
            option.value = String(value);
            option.textContent = formatter(value);
            option.selected = settings[key] === value;
            select.append(option);
        }
        select.addEventListener('change', () => {
            settings[key] = Number(select.value);
            persistSettings();
        });
        row.append(text, select);
        autoLoadConfig.append(row);
    }

    const takeoverActions = document.createElement('div');
    takeoverActions.className = 'cla-actions';
    const safeModeActive = new URLSearchParams(location.search).get('cla-safe') === '1';
    takeoverActions.append(
        makeButton('暂停当前前端任务', 'fa-solid fa-pause', async () => {
            cancelFrontendTask('当前前端任务已暂停');
            takeoverController?.pauseTasks();
        }),
        makeButton('恢复酒馆原生流程', 'fa-solid fa-shield-halved', async () => {
            settings.takeoverEnabled = false;
            persistSettings();
            await takeoverController?.stop({ reason: '已恢复酒馆原生流程' });
        }, { danger: true }),
        makeButton(safeModeActive ? '退出本次安全模式' : '本次安全模式', 'fa-solid fa-life-ring', async () => {
            const url = new URL(location.href);
            if (safeModeActive) url.searchParams.delete('cla-safe');
            else url.searchParams.set('cla-safe', '1');
            location.assign(url.href);
        }),
    );

    const frontendTitle = makeSectionTitle('聊天渲染与手动工具', '无需服务端、HTTPS 或服务器权限；全局接管异常时仍可使用高级完整重载。');

    const heavyModeSwitch = makeSwitch(
        '重美化聊天模式',
        '一键启用官方聊天截断与屏幕外渲染减负；适合消息不多但人物卡、仪表盘和折叠块很复杂的聊天。',
    );
    heavyModeSwitch.row.classList.add('cla-heavy-mode');
    heavyModeSwitch.input.dataset.cloudHeavyMode = '';
    heavyModeSwitch.input.checked = settings.heavyBeautifyMode;
    heavyModeSwitch.input.addEventListener('change', async () => {
        heavyModeSwitch.input.disabled = true;
        const nextValue = heavyModeSwitch.input.checked;
        try {
            await setHeavyBeautifyMode(nextValue);
            globalThis.toastr?.success?.(
                nextValue ? '重美化模式已开启：首批消息已减少并启用屏幕外减负' : '已恢复开启重美化模式前的设置',
                '云酒馆加速器',
            );
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            heavyModeSwitch.input.checked = settings.heavyBeautifyMode;
        } finally {
            heavyModeSwitch.input.disabled = false;
            await refreshPanel();
        }
    });

    const renderBoostSwitch = makeSwitch(
        '长聊天渲染减负',
        `消息达到 ${settings.renderBoostThreshold} 条后，跳过屏幕外复杂消息的布局和绘制，并始终保留最近 5 条。`,
    );
    renderBoostSwitch.input.dataset.cloudRenderBoost = '';
    renderBoostSwitch.input.checked = settings.renderBoost;
    renderBoostSwitch.input.addEventListener('change', () => {
        settings.renderBoost = renderBoostSwitch.input.checked;
        persistSettings();
        settings.renderBoost ? startRenderObserver() : stopRenderObserver();
    });

    const longChatSwitch = makeSwitch(
        '长聊天流畅模式',
        '使用 SillyTavern 官方聊天截断，只渲染最近一批消息；关闭时恢复原值。',
    );
    longChatSwitch.input.dataset.cloudLongChat = '';
    longChatSwitch.input.checked = settings.longChatMode;
    longChatSwitch.input.addEventListener('change', async () => {
        longChatSwitch.input.disabled = true;
        const nextValue = longChatSwitch.input.checked;
        settings.longChatMode = nextValue;
        try {
            await applyLongChatMode({ reload: true });
        } catch (error) {
            settings.longChatMode = !nextValue;
            longChatSwitch.input.checked = settings.longChatMode;
            lastError = error instanceof Error ? error.message : String(error);
        } finally {
            persistSettings();
            longChatSwitch.input.disabled = false;
            await refreshPanel();
        }
    });

    const limitRow = document.createElement('label');
    limitRow.className = 'cla-select-row';
    const limitText = document.createElement('span');
    limitText.textContent = '每批显示消息数';
    const limit = document.createElement('select');
    limit.className = 'text_pole';
    limit.dataset.cloudChatLimit = '';
    for (const value of CHAT_LIMIT_CHOICES) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = `${value} 条`;
        option.selected = settings.longChatLimit === value;
        limit.append(option);
    }
    limit.addEventListener('change', async () => {
        settings.longChatLimit = Number(limit.value);
        persistSettings();
        if (settings.longChatMode) await applyLongChatMode({ reload: true });
    });
    limitRow.append(limitText, limit);

    const frontendActions = document.createElement('div');
    frontendActions.className = 'cla-actions';
    frontendActions.append(
        makeButton('重新应用正则', 'fa-solid fa-wand-magic-sparkles', async () => {
            const result = await reapplyRegexRendering();
            if (result.cancelled) return;
            const message = result.failed
                ? `已刷新 ${result.completed} 条，其中 ${result.failed} 条失败`
                : `已原地刷新 ${result.completed} 条，用时 ${formatMilliseconds(result.elapsedMs)}`;
            globalThis.toastr?.[result.failed ? 'warning' : 'success']?.(message, '云酒馆加速器');
        }, { lockWhileRunning: false }),
        makeButton('平滑加载更早 10 条', 'fa-solid fa-clock-rotate-left', async () => {
            const result = await loadEarlierMessagesSmoothly(10);
            if (result.cancelled) return;
            if (result.empty) {
                globalThis.toastr?.info?.('已经显示到聊天开头', '云酒馆加速器');
                return;
            }
            globalThis.toastr?.success?.(`已加载更早的 ${result.completed} 条消息`, '云酒馆加速器');
        }),
        makeButton('完整重载（高级）', 'fa-solid fa-triangle-exclamation', async () => {
            const result = await fullReloadRegexRendering();
            if (!result.cancelled) {
                globalThis.toastr?.success?.(`完整重载完成，用时 ${formatMilliseconds(result.elapsedMs)}`, '云酒馆加速器');
            }
        }, { danger: true }),
    );

    const taskProgress = document.createElement('div');
    taskProgress.className = 'cla-task-progress';
    taskProgress.dataset.cloudTask = '';
    taskProgress.hidden = true;
    const taskProgressBar = document.createElement('progress');
    taskProgressBar.max = 1;
    taskProgressBar.value = 0;
    const taskProgressLabel = document.createElement('small');
    taskProgressLabel.dataset.cloudTaskLabel = '';
    const taskCancel = document.createElement('button');
    taskCancel.type = 'button';
    taskCancel.className = 'menu_button cla-task-cancel';
    taskCancel.dataset.cloudTaskCancel = '';
    taskCancel.textContent = '取消';
    taskCancel.addEventListener('click', () => cancelFrontendTask());
    taskProgress.append(taskProgressBar, taskProgressLabel, taskCancel);

    const regexNote = document.createElement('small');
    regexNote.className = 'cla-note cla-warning-note';
    regexNote.textContent = '“重新应用正则”会保留聊天页面，按视口优先分帧刷新已显示消息，默认不清缓存、不重新请求聊天；再次点击会取消旧刷新并开始新刷新。只有异常时才使用高级完整重载。';

    const diagnosticsTitle = makeSectionTitle('聊天加载诊断', '使用浏览器 Performance API 与官方聊天事件；聊天读取只做复杂度旁路分析，不进入请求复用缓存。');
    const chatMetrics = document.createElement('div');
    chatMetrics.className = 'cla-metrics cla-chat-metrics';
    chatMetrics.append(
        makeMetric('聊天请求', 'chatRequest'),
        makeMetric('聊天传输', 'chatTransfer'),
        makeMetric('本次显示', 'displayedMessages'),
        makeMetric('聊天总数', 'totalMessages'),
        makeMetric('聊天 DOM 节点', 'domNodes'),
        makeMetric('美化复杂度', 'renderComplexity'),
        makeMetric('首批内容出现', 'firstContent'),
        makeMetric('前端处理估算', 'frontendWork'),
        makeMetric('完整加载', 'totalLoad'),
        makeMetric('最长主线程阻塞', 'longestTask'),
    );
    const diagnosticsNote = document.createElement('small');
    diagnosticsNote.className = 'cla-note';
    diagnosticsNote.textContent = '“前端处理估算”包含 JSON 解析、正则、Markdown、HTML 清洗、DOM 创建及其他扩展处理；浏览器无法在不侵入官方函数的情况下把它们逐项精确拆开。';

    const serverTitle = makeSectionTitle('静态资源缓存（可选增强）', '需要服务端插件与 HTTPS；不安装不会影响上面的前端功能。');

    const enabledSwitch = makeSwitch('启用静态资源缓存', '服务端增强存在时注册 Service Worker；纯 UI 模式下保持待命，不会报错。');
    const enabled = enabledSwitch.input;
    enabled.dataset.cloudEnabled = '';
    enabled.checked = settings.enabled;
    enabled.addEventListener('change', async () => {
        settings.enabled = enabled.checked;
        persistSettings();
        lastError = '';
        try {
            if (settings.enabled) {
                await probeServerPlugin({ force: true });
                if (serverState === 'available') {
                    await registerWorker();
                    scheduleAutoWarmup();
                }
            } else {
                cancelScheduledWarmup();
                await unregisterWorker({ clear: true });
            }
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await refreshPanel();
    });

    const warmSwitch = makeSwitch('自动预热当前版本一次', '默认关闭；仅在页面可见、非省流/低速网络且浏览器空闲时执行。');
    warmSwitch.input.checked = settings.autoWarm;
    warmSwitch.input.addEventListener('change', () => {
        settings.autoWarm = warmSwitch.input.checked;
        settings.lastWarmVersion = '';
        persistSettings();
        settings.autoWarm ? scheduleAutoWarmup() : cancelScheduledWarmup();
    });

    const thirdPartySwitch = makeSwitch('缓存第三方扩展', '仅个人单账号酒馆建议开启；多账号共用同一域名时保持关闭。');
    thirdPartySwitch.input.checked = settings.cacheThirdPartyAssets;
    thirdPartySwitch.input.dataset.needsServer = '';
    thirdPartySwitch.input.addEventListener('change', async () => {
        settings.cacheThirdPartyAssets = thirdPartySwitch.input.checked;
        persistSettings();
        lastError = '';
        try {
            if (settings.enabled) {
                await registerWorker();
                if (settings.cacheThirdPartyAssets && settings.autoWarm) scheduleAutoWarmup();
            }
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await refreshPanel();
    });

    const status = document.createElement('div');
    status.className = 'cla-status';
    status.dataset.cloudStatus = '';
    status.textContent = '前端模式正在就绪…';

    const metrics = document.createElement('div');
    metrics.className = 'cla-metrics';
    metrics.append(
        makeMetric('首字节', 'ttfb'),
        makeMetric('DOM 可交互', 'interactive'),
        makeMetric('首页传输', 'transferred'),
        makeMetric('连接协议', 'protocol'),
        makeMetric('本次命中', 'hits'),
    );

    const serverActions = document.createElement('div');
    serverActions.className = 'cla-actions';
    serverActions.append(
        makeButton('立即预热', 'fa-solid fa-bolt', async () => {
            await registerWorker();
            const result = await warmCurrentInstall();
            globalThis.toastr?.success?.(`新预热 ${result.warmed} 个资源`, '云酒馆加速器');
        }, { needsServer: true }),
        makeButton('清空并重建', 'fa-solid fa-arrows-rotate', async () => {
            await sendWorkerMessage('CLEAR');
            const result = await warmCurrentInstall();
            globalThis.toastr?.success?.(`缓存已重建：${result.warmed} 个资源`, '云酒馆加速器');
        }, { needsServer: true }),
        makeButton('刷新缓存状态', 'fa-solid fa-chart-simple', async () => {
            await refreshPanel({ includeStats: true });
        }, { needsServer: true }),
        makeButton('删除本机缓存', '', async () => {
            const result = await removeLocalAcceleration();
            if (!result.cancelled) globalThis.toastr?.success?.('已删除这台设备上的静态资源缓存', '云酒馆加速器');
        }, { danger: true }),
    );

    const note = document.createElement('small');
    note.className = 'cla-note';
    note.textContent = '仅安装 UI 时可直接使用长聊天减负、官方聊天截断、正则刷新和性能指标；静态缓存按钮会安全地保持不可用。';

    body.append(
        intro,
        takeoverTitle,
        takeoverMaster.row,
        takeoverStatusNode,
        intensityRow,
        takeoverSwitchGrid,
        autoLoadConfig,
        takeoverActions,
        frontendTitle,
        heavyModeSwitch.row,
        renderBoostSwitch.row,
        longChatSwitch.row,
        limitRow,
        frontendActions,
        taskProgress,
        regexNote,
        diagnosticsTitle,
        chatMetrics,
        diagnosticsNote,
        serverTitle,
        enabledSwitch.row,
        warmSwitch.row,
        thirdPartySwitch.row,
        status,
        metrics,
        serverActions,
        note,
    );
    root.append(header, body);
    host.append(root);
    renderFrontendTaskState();
    return true;
}

function ensurePanel() {
    if (mountPanel()) {
        panelRetryCount = 0;
        void refreshPanel();
        return;
    }
    if (panelRetryTimer !== null || panelRetryCount >= PANEL_RETRY_LIMIT) return;
    panelRetryTimer = setTimeout(() => {
        panelRetryTimer = null;
        panelRetryCount += 1;
        ensurePanel();
    }, 250);
}

async function startAfterAppReady({ forceProbe = false, forceWarm = false } = {}) {
    if (!activated) return;
    if (!settings) loadSettings();
    ensurePanel();
    startRenderObserver();
    startChatDiagnostics();
    if (takeoverController?.safeMode && Number.isFinite(settings.adaptivePreviousChatTruncation)) {
        try {
            const powerUser = await getPowerUserSettings();
            powerUser.chat_truncation = settings.adaptivePreviousChatTruncation;
            settings.adaptivePreviousChatTruncation = null;
            persistSettings();
        } catch (error) {
            console.warn(LOG_PREFIX, '安全模式恢复原聊天截断值失败', error);
        }
    }
    if (settings.longChatMode) {
        try {
            await applyLongChatMode();
        } catch (error) {
            console.warn(LOG_PREFIX, '无法应用长聊天流畅模式', error);
        }
    }

    await probeServerPlugin({ force: forceProbe });
    if (settings.enabled && serverState === 'available') {
        try {
            await registerWorker();
            if (forceWarm) await warmCurrentInstall();
            else scheduleAutoWarmup();
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            console.warn(LOG_PREFIX, lastError);
        }
    }
    await refreshPanel();
}

eventSource.once(event_types.APP_READY, () => {
    appReady = true;
    if (!activated || appReadyWorkStarted) return;
    appReadyWorkStarted = true;
    void startAfterAppReady();
});

export function onActivate() {
    activated = true;
    if (!settings) loadSettings();
    void ensureTakeoverController().start();
    if (appReady && !appReadyWorkStarted) {
        appReadyWorkStarted = true;
        void startAfterAppReady();
    }
}

export function onUpdate() {
    if (!settings) loadSettings();
    takeoverController?.updateSettings(settings);
    if (appReady) {
        void startAfterAppReady({ forceProbe: true, forceWarm: true });
    }
}

function cleanupUi() {
    activated = false;
    appReadyWorkStarted = false;
    frontendTaskGeneration += 1;
    frontendScheduler.cancelAll('扩展已停用');
    frontendTaskState = {
        status: 'idle',
        kind: '',
        label: '',
        completed: 0,
        total: 0,
        elapsedMs: 0,
    };
    chatUiApiPromise = null;
    cancelScheduledWarmup();
    stopRenderObserver();
    stopChatDiagnostics();
    if (panelRetryTimer !== null) clearTimeout(panelRetryTimer);
    panelRetryTimer = null;
    panelRetryCount = 0;
    document.getElementById(ROOT_ID)?.remove();
}

export async function onDisable() {
    try {
        await restoreLongChatMode({ reload: false });
    } catch (error) {
        console.warn(LOG_PREFIX, '恢复聊天截断设置失败', error);
    }
    await takeoverController?.stop({ reason: '扩展已停用，酒馆原生流程已恢复' });
    takeoverController = null;
    cleanupUi();
    await unregisterWorker({ clear: true });
}

export async function onDelete() {
    try {
        await restoreLongChatMode({ reload: false });
    } catch (error) {
        console.warn(LOG_PREFIX, '恢复聊天截断设置失败', error);
    }
    await takeoverController?.stop({ reason: '扩展已删除，酒馆原生流程已恢复' });
    takeoverController = null;
    cleanupUi();
    await unregisterWorker({ clear: true });
}
