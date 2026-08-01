import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_ID = 'cloud_lounge_accelerator';
const PLUGIN_ID = 'cloud-lounge-accelerator';
const VERSION = '1.0.3';
const API_BASE = `/api/plugins/${PLUGIN_ID}`;
const CACHE_PREFIX = 'cloud-lounge-static-';
const ROOT_ID = 'cloud-lounge-accelerator-settings';
const LOG_PREFIX = '[Cloud Lounge Accelerator]';
const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoWarm: true,
    cacheThirdPartyAssets: false,
});

let settings;
let initialized = false;
let panelObserver = null;
let lastError = '';

function loadSettings() {
    settings = Object.assign({}, DEFAULT_SETTINGS, extension_settings[MODULE_ID] || {});
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

async function findRootRegistration() {
    const rootScope = new URL('/', location.href).href;
    const registrations = await navigator.serviceWorker.getRegistrations();
    return registrations.find(item => item.scope === rootScope) || null;
}

async function probeServerPlugin() {
    const response = await fetch(`${API_BASE}/health`, {
        credentials: 'same-origin',
        cache: 'no-store',
    });
    if (!response.ok) throw new Error(`服务端插件未就绪（HTTP ${response.status}）`);
    const payload = await response.json();
    if (!payload?.ok) throw new Error('服务端插件返回异常');
    return payload;
}

async function registerWorker() {
    if (!isSecureContextAvailable()) {
        throw new Error('需要 HTTPS（或 localhost）才能启用本地加速缓存');
    }
    await probeServerPlugin();
    const current = await findRootRegistration();
    if (current && !isOurWorker(current)) {
        throw new Error('站点根路径已由其他 Service Worker 控制，为避免破坏现有功能已停止安装');
    }

    const registration = await navigator.serviceWorker.register(
        `${API_BASE}/service-worker.js?v=${encodeURIComponent(VERSION)}`,
        { scope: '/', updateViaCache: 'none' },
    );
    await navigator.serviceWorker.ready;
    await sendWorkerMessage('CONFIG', { allowThirdParty: settings.cacheThirdPartyAssets });
    return registration;
}

function workerFor(registration) {
    return registration?.active || registration?.waiting || registration?.installing || navigator.serviceWorker.controller;
}

async function sendWorkerMessage(type, payload = {}, timeout = 15000) {
    const registration = await findRootRegistration();
    if (!registration || !isOurWorker(registration)) throw new Error('加速服务尚未启用');
    const worker = workerFor(registration);
    if (!worker) throw new Error('加速服务尚未激活');

    return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => reject(new Error('加速服务响应超时')), timeout);
        channel.port1.onmessage = event => {
            clearTimeout(timer);
            event.data?.ok ? resolve(event.data) : reject(new Error(event.data?.error || '加速服务执行失败'));
        };
        worker.postMessage({ type, ...payload }, [channel.port2]);
    });
}

function collectWarmUrls() {
    const urls = new Set([
        new URL('/script.js', location.href).href,
        new URL('/style.css', location.href).href,
        new URL('/lib.js', location.href).href,
        new URL('/locales/lang.json', location.href).href,
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

async function warmCurrentInstall() {
    const result = await sendWorkerMessage('WARM', { urls: collectWarmUrls() }, 120000);
    await refreshPanel();
    return result;
}

async function unregisterWorker({ clear = true } = {}) {
    let unregistered = false;
    if ('serviceWorker' in navigator) {
        const registration = await findRootRegistration();
        if (registration && isOurWorker(registration)) {
            if (clear) {
                try {
                    await sendWorkerMessage('CLEAR');
                } catch (error) {
                    console.warn(LOG_PREFIX, '通过加速服务清理缓存失败', error);
                }
            }
            unregistered = await registration.unregister();
        }
    }

    if (clear && 'caches' in window) {
        try {
            const names = await caches.keys();
            await Promise.all(names
                .filter(name => name.startsWith(CACHE_PREFIX))
                .map(name => caches.delete(name)));
        } catch (error) {
            console.warn(LOG_PREFIX, '从页面清理缓存失败', error);
        }
    }
    return unregistered;
}

async function removeLocalAcceleration() {
    const confirmed = globalThis.confirm('确定删除这台设备上的云酒馆加速吗？\n\n这会注销加速服务并清除本插件的本地缓存，不会删除聊天、角色卡、设置或服务器文件。');
    if (!confirmed) return { cancelled: true };

    settings.enabled = false;
    persistSettings();
    await unregisterWorker({ clear: true });
    lastError = '';
    return { cancelled: false };
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
    if (!Number.isFinite(value) || value <= 0) return '—';
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

async function getRuntimeState() {
    if (!isSecureContextAvailable()) return { state: 'unsupported', label: '当前页面不支持（请检查 HTTPS）' };
    const registration = await findRootRegistration();
    if (!registration) return { state: 'off', label: '未启用' };
    if (!isOurWorker(registration)) return { state: 'conflict', label: '已有其他站点缓存，本插件未介入' };
    try {
        const stats = await sendWorkerMessage('STATS');
        return { state: 'active', label: `已启用 · ${stats.entries} 个本地资源`, stats };
    } catch {
        return { state: 'pending', label: '正在激活' };
    }
}

async function refreshPanel() {
    const status = await getRuntimeState().catch(error => ({ state: 'error', label: error.message }));
    if (status.state === 'active') lastError = '';
    setStatus(lastError || status.label, lastError ? 'error' : status.state);
    const toggle = document.querySelector(`#${ROOT_ID} [data-cloud-enabled]`);
    if (toggle) toggle.checked = settings.enabled && status.state !== 'conflict';

    const metrics = getNavigationMetrics();
    const fields = {
        ttfb: metrics ? formatMilliseconds(metrics.ttfb) : '—',
        interactive: metrics ? formatMilliseconds(metrics.interactive) : '—',
        transferred: metrics ? formatBytes(metrics.transferred) : '—',
        protocol: metrics?.protocol || '—',
        hits: status.stats ? String(status.stats.hits) : '—',
    };
    for (const [name, value] of Object.entries(fields)) {
        const node = document.querySelector(`#${ROOT_ID} [data-cloud-metric="${name}"]`);
        if (node) node.textContent = value;
    }
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

function makeButton(label, iconClass, handler, { danger = false } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button cla-action';
    if (danger) button.classList.add('cla-action-danger');
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

function mountPanel() {
    if (document.getElementById(ROOT_ID)) return;
    const host = document.querySelector('#extensions_settings2')
        || document.querySelector('#extensions_settings')
        || document.querySelector('#extensions_settings_block');
    if (!host) return;

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

    const body = document.createElement('div');
    body.className = 'inline-drawer-content cla-body';
    const intro = document.createElement('p');
    intro.className = 'cla-intro';
    intro.textContent = '只缓存 SillyTavern 程序文件；聊天、角色卡、设置和 API 响应永远不进入缓存。';

    const enabledRow = document.createElement('label');
    enabledRow.className = 'checkbox_label cla-switch';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.dataset.cloudEnabled = '';
    enabled.checked = settings.enabled;
    const enabledText = document.createElement('span');
    enabledText.innerHTML = '<strong>启用本地加速</strong><small>首次进入后预热，从第二次开始明显受益。</small>';
    enabled.addEventListener('change', async () => {
        settings.enabled = enabled.checked;
        persistSettings();
        lastError = '';
        try {
            if (settings.enabled) {
                await registerWorker();
                if (settings.autoWarm) await warmCurrentInstall();
            } else {
                await unregisterWorker({ clear: true });
            }
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            settings.enabled = false;
            persistSettings();
        }
        await refreshPanel();
    });
    enabledRow.append(enabled, enabledText);

    const warmRow = document.createElement('label');
    warmRow.className = 'checkbox_label cla-switch';
    const autoWarm = document.createElement('input');
    autoWarm.type = 'checkbox';
    autoWarm.checked = settings.autoWarm;
    const warmText = document.createElement('span');
    warmText.innerHTML = '<strong>自动预热当前安装</strong><small>包括你实际启用的第三方扩展资源。</small>';
    autoWarm.addEventListener('change', () => {
        settings.autoWarm = autoWarm.checked;
        persistSettings();
    });
    warmRow.append(autoWarm, warmText);

    const thirdPartyRow = document.createElement('label');
    thirdPartyRow.className = 'checkbox_label cla-switch';
    const thirdParty = document.createElement('input');
    thirdParty.type = 'checkbox';
    thirdParty.checked = settings.cacheThirdPartyAssets;
    const thirdPartyText = document.createElement('span');
    thirdPartyText.innerHTML = '<strong>缓存第三方扩展</strong><small>仅个人单账号酒馆建议开启；多账号共用同一域名时请保持关闭。</small>';
    thirdParty.addEventListener('change', async () => {
        settings.cacheThirdPartyAssets = thirdParty.checked;
        persistSettings();
        lastError = '';
        try {
            if (settings.enabled) {
                await registerWorker();
                if (settings.cacheThirdPartyAssets && settings.autoWarm) await warmCurrentInstall();
            }
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await refreshPanel();
    });
    thirdPartyRow.append(thirdParty, thirdPartyText);

    const status = document.createElement('div');
    status.className = 'cla-status';
    status.dataset.cloudStatus = '';
    status.textContent = '正在检查…';

    const metrics = document.createElement('div');
    metrics.className = 'cla-metrics';
    metrics.append(
        makeMetric('首字节', 'ttfb'),
        makeMetric('DOM 可交互', 'interactive'),
        makeMetric('首页传输', 'transferred'),
        makeMetric('连接协议', 'protocol'),
        makeMetric('本次命中', 'hits'),
    );

    const actions = document.createElement('div');
    actions.className = 'cla-actions';
    actions.append(
        makeButton('立即预热', 'fa-solid fa-bolt', async () => {
            await registerWorker();
            const result = await warmCurrentInstall();
            globalThis.toastr?.success?.(`新预热 ${result.warmed} 个资源`, '云酒馆加速器');
        }),
        makeButton('清空并重建', 'fa-solid fa-arrows-rotate', async () => {
            await sendWorkerMessage('CLEAR');
            const result = await warmCurrentInstall();
            globalThis.toastr?.success?.(`缓存已重建：${result.warmed} 个资源`, '云酒馆加速器');
        }),
        makeButton('删除本机加速', '', async () => {
            const result = await removeLocalAcceleration();
            if (!result.cancelled) {
                globalThis.toastr?.success?.('已删除这台设备上的加速服务和本地缓存', '云酒馆加速器');
            }
        }, { danger: true }),
    );

    const note = document.createElement('small');
    note.className = 'cla-note';
    note.textContent = '页面大改或扩展更新后可点“清空并重建”。首次访问速度还取决于 1Panel 反代和角色库体积。';

    body.append(intro, enabledRow, warmRow, thirdPartyRow, status, metrics, actions, note);
    root.append(header, body);
    host.append(root);
}

async function ensurePanel() {
    mountPanel();
    if (!document.getElementById(ROOT_ID) && !panelObserver) {
        panelObserver = new MutationObserver(() => {
            mountPanel();
            if (document.getElementById(ROOT_ID)) {
                panelObserver.disconnect();
                panelObserver = null;
                void refreshPanel();
            }
        });
        panelObserver.observe(document.body, { childList: true, subtree: true });
    }
    await refreshPanel();
}

async function initialize() {
    if (initialized) return;
    initialized = true;
    loadSettings();
    await ensurePanel();
    if (!settings.enabled) return;
    try {
        await registerWorker();
        if (settings.autoWarm) await warmCurrentInstall();
    } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        console.warn(LOG_PREFIX, lastError);
    }
    await refreshPanel();
}

jQuery(() => void initialize());

export async function onActivate() {
    await initialize();
}

export async function onUpdate() {
    if (!settings) loadSettings();
    await registerWorker();
    await warmCurrentInstall();
}

export async function onDisable() {
    await unregisterWorker({ clear: true });
}

export async function onDelete() {
    await unregisterWorker({ clear: true });
}
