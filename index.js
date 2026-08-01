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
    buildChatDiagnostics,
    findLatestChatRequest,
    normalizeSettings,
    shouldActivateRenderBoost,
    shouldAutoWarm,
} from './client-core.js';

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

function loadSettings() {
    settings = normalizeSettings(extension_settings[MODULE_ID]);
    extension_settings[MODULE_ID] = settings;
}

function persistSettings() {
    extension_settings[MODULE_ID] = settings;
    saveSettingsDebounced();
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
            await warmCurrentInstall();
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

async function reapplyRegexRendering() {
    try {
        const regexEngine = await import('../../regex/engine.js');
        regexEngine.RegexProvider?.instance?.clear?.();
    } catch (error) {
        console.debug(LOG_PREFIX, '当前版本没有可清理的正则编译缓存', error);
    }
    await reloadCurrentChat();
}

async function getPowerUserSettings() {
    const module = await import('../../power-user.js');
    if (!module.power_user) throw new Error('当前 SillyTavern 版本未提供聊天截断设置');
    return module.power_user;
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
    if (reload) await reloadCurrentChat();
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
    if (renderRefreshFrame !== null) cancelAnimationFrame(renderRefreshFrame);
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
    renderRefreshFrame = requestAnimationFrame(refreshRenderBoostState);
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
    return {
        displayedMessages: chatElement?.querySelectorAll('.mes').length || 0,
        totalMessages: Array.isArray(chat) ? chat.length : 0,
        domNodes: chatElement?.querySelectorAll('*').length || 0,
    };
}

function updateChatDiagnosticFields() {
    if (!latestChatDiagnostics) return;
    const fields = {
        chatRequest: formatMilliseconds(latestChatDiagnostics.requestMs),
        chatTransfer: formatBytes(latestChatDiagnostics.transferBytes),
        displayedMessages: String(latestChatDiagnostics.displayedMessages),
        totalMessages: String(latestChatDiagnostics.totalMessages),
        domNodes: latestChatDiagnostics.domNodes.toLocaleString(),
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
        ? timing
        : { ...latestChatDiagnostics, ...complexity, measuredAt: now };
    updateChatDiagnosticFields();
}

function scheduleChatDiagnosticCapture({ includeTiming = false } = {}) {
    diagnosticIncludeTiming ||= includeTiming;
    if (diagnosticRefreshFrame !== null) return;
    diagnosticRefreshFrame = requestAnimationFrame(() => {
        const shouldIncludeTiming = diagnosticIncludeTiming;
        diagnosticIncludeTiming = false;
        captureChatDiagnostics({ includeTiming: shouldIncludeTiming });
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

    chatChangedHandler = () => scheduleChatDiagnosticCapture({ includeTiming: true });
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
    if (diagnosticRefreshFrame !== null) cancelAnimationFrame(diagnosticRefreshFrame);
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
        longChatMode.disabled = settings.heavyBeautifyMode;
    }
    if (longChatLimit) {
        longChatLimit.value = String(settings.longChatLimit);
        longChatLimit.disabled = settings.heavyBeautifyMode;
    }

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

function makeButton(label, iconClass, handler, { danger = false, needsServer = false } = {}) {
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
        button.disabled = true;
        lastError = '';
        try {
            await handler();
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            console.error(LOG_PREFIX, error);
        } finally {
            button.disabled = false;
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
    intro.textContent = '只安装 UI 扩展也能使用前端优化；服务端插件仅用于额外的静态资源缓存。聊天、角色卡、设置和 API 响应永远不会被缓存。';

    const frontendTitle = makeSectionTitle('前端优化', '无需服务端、HTTPS 或服务器权限，安装 UI 扩展即可使用。');

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
    frontendActions.append(makeButton('重新应用正则', 'fa-solid fa-wand-magic-sparkles', async () => {
        await reapplyRegexRendering();
        globalThis.toastr?.success?.('已重新应用正则并渲染当前聊天', '云酒馆加速器');
    }));

    const regexNote = document.createElement('small');
    regexNote.className = 'cla-note cla-warning-note';
    regexNote.textContent = '“重新应用正则”仅在修改正则后旧消息没有更新时使用；它会清理编译缓存并重绘当前聊天，不是日常加速按钮。';

    const diagnosticsTitle = makeSectionTitle('聊天加载诊断', '仅使用浏览器 Performance API 与官方聊天事件，不缓存聊天，也不接管官方渲染和滚动。');
    const chatMetrics = document.createElement('div');
    chatMetrics.className = 'cla-metrics cla-chat-metrics';
    chatMetrics.append(
        makeMetric('聊天请求', 'chatRequest'),
        makeMetric('聊天传输', 'chatTransfer'),
        makeMetric('本次显示', 'displayedMessages'),
        makeMetric('聊天总数', 'totalMessages'),
        makeMetric('聊天 DOM 节点', 'domNodes'),
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
        frontendTitle,
        heavyModeSwitch.row,
        renderBoostSwitch.row,
        longChatSwitch.row,
        limitRow,
        frontendActions,
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
    if (appReady && !appReadyWorkStarted) {
        if (!settings) loadSettings();
        appReadyWorkStarted = true;
        void startAfterAppReady();
    }
}

export function onUpdate() {
    if (appReady) {
        if (!settings) loadSettings();
        void startAfterAppReady({ forceProbe: true, forceWarm: true });
    }
}

function cleanupUi() {
    activated = false;
    appReadyWorkStarted = false;
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
        await restoreLongChatMode({ reload: true });
    } catch (error) {
        console.warn(LOG_PREFIX, '恢复聊天截断设置失败', error);
    }
    cleanupUi();
    await unregisterWorker({ clear: true });
}

export async function onDelete() {
    try {
        await restoreLongChatMode({ reload: true });
    } catch (error) {
        console.warn(LOG_PREFIX, '恢复聊天截断设置失败', error);
    }
    cleanupUi();
    await unregisterWorker({ clear: true });
}
