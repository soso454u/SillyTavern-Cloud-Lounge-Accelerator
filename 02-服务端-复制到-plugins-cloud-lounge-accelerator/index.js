import {
    chat,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    isGenerating,
    refreshSwipeButtons,
    saveSettingsDebounced,
    scrollChatToBottom,
} from '../../../../script.js';
import * as chatApi from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { ChatOptimizer } from './modules/chat-optimizer.js';
import { StartupOptimizer } from './modules/startup-optimizer.js';
import { getLegacyChatTruncation, normalizeSettings } from './settings.js';
import { FrameScheduler } from './utils/scheduler.js';

const MODULE_ID = 'cloud_lounge_accelerator';
const LOG_PREFIX = '[Cloud Lounge Accelerator]';
const PANEL_RETRY_LIMIT = 24;

let settings = null;
let legacyTruncation = null;
let activated = false;
let appReady = false;
let settingsLoaded = false;
let settingsSavePending = false;
let panel = null;
let panelTimer = null;
let panelRetries = 0;
let runtime = null;
const runtimeStatus = { chat: '自动', interaction: '自动' };

function loadSettings() {
    const previous = extension_settings[MODULE_ID];
    legacyTruncation ??= getLegacyChatTruncation(previous);
    settings = normalizeSettings(previous);
    extension_settings[MODULE_ID] = settings;
    // A version-only upgrade must not upload the entire SillyTavern settings payload.
    const previousKeys = previous && typeof previous === 'object' ? Object.keys(previous) : [];
    const changed = !previous
        || Object.entries(settings).some(([key, value]) => key !== 'settingsVersion' && previous[key] !== value)
        || previousKeys.some(key => key !== 'settingsVersion' && !(key in settings));
    if (changed) requestSettingsSave();
    return settings;
}

function requestSettingsSave() {
    if (appReady) saveSettingsDebounced();
    else settingsSavePending = true;
}

function persistSettings() {
    extension_settings[MODULE_ID] = settings;
    saveSettingsDebounced();
}

function updateRuntimeStatus(key, value) {
    runtimeStatus[key] = value;
    void panel?.refresh();
}

function createRuntime() {
    const scheduler = new FrameScheduler({
        budgetMs: 9,
        onError: error => {
            if (error?.name !== 'AbortError') console.debug(LOG_PREFIX, '分帧任务失败', error);
        },
    });
    const chatOptimizer = new ChatOptimizer({
        eventSource,
        eventTypes: event_types,
        chat,
        isGenerating,
        getCurrentChatId,
        scheduler,
        saveSettings: requestSettingsSave,
        scrollToBottom: scrollChatToBottom,
        refreshSwipeButtons,
        onStatus: updateRuntimeStatus,
    });
    const startupOptimizer = new StartupOptimizer({
        eventSource,
        eventTypes: event_types,
        onStatus: value => updateRuntimeStatus('startup', value),
    });
    return {
        scheduler, chatOptimizer, startupOptimizer,
        generation: 0, deferredPromise: null, readyStart: null, chatStart: null,
    };
}

async function loadDeferredRuntime(current) {
    current.deferredPromise ??= import('./modules/deferred-runtime.js').then(module => {
        if (!activated || current !== runtime) return;
        Object.assign(current, module.createDeferredRuntime({
            chat, eventSource, eventTypes: event_types, getCurrentChatId,
            getRequestHeaders, isGenerating, scheduler: current.scheduler,
            getStreamingProcessor: () => chatApi.streamingProcessor,
            extensionSettings: extension_settings,
            scriptApi: chatApi,
            onStatus: updateRuntimeStatus,
        }), {
            SettingsPanel: module.SettingsPanel,
            copyDiagnosticText: module.copyDiagnosticText,
            repairAccelerator: module.repairAccelerator,
        });
    }).catch(error => {
        current.deferredPromise = null;
        throw error;
    });
    await current.deferredPromise;
}

function getRuntime() {
    runtime ??= createRuntime();
    return runtime;
}

async function startEnabledModules({ skipCache = false, forceCache = false } = {}) {
    if (!activated) return;
    const current = getRuntime();
    const generation = current.generation;
    const isCurrent = () => activated && current === runtime && generation === current.generation;
    if (settings.pageAcceleration || settings.chatOptimization) {
        current.startupOptimizer.start({ startupFeatures: settings.pageAcceleration });
    }
    // Keep the chat page limit before the first native chat load. All optional
    // UI / regex / cache modules are downloaded only after native APP_READY.
    if (settings.chatOptimization) {
        current.chatStart ??= current.chatOptimizer.start({ legacyTruncation, chatPageSize: settings.chatPageSize });
        await current.chatStart;
        if (!isCurrent()) return;
        legacyTruncation = null;
    }
    if (!appReady || !isCurrent()) return;
    await loadDeferredRuntime(current);
    if (!isCurrent()) return;
    if (current.readyStart) {
        await current.readyStart;
        if (!forceCache || !isCurrent()) return;
    }
    const pending = (async () => {
        if (settings.interactionOptimization) await current.interactionOptimizer.start();
        if (!isCurrent()) return;
        if (settings.interactionOptimization) await current.chatHistoryBatch?.start();
        if (!isCurrent()) {
            current.chatHistoryBatch?.stop();
            return;
        }
        if (settings.chatOptimization) {
            current.streamingRender.start();
            const refreshReady = await current.regexRefresh.start();
            if (!isCurrent()) {
                current.regexRefresh.stop();
                return;
            }
            if (refreshReady) {
                await current.regexUiAdapter.start();
                if (!isCurrent()) {
                    current.regexUiAdapter.stop();
                    return;
                }
            }
        }
        if (!isCurrent()) return;
        if (settings.pageAcceleration && !skipCache) {
            try {
                await current.cacheController.startAfterLogin({ force: forceCache });
            } catch (error) {
                console.debug(LOG_PREFIX, '页面缓存增强未启用', error);
            }
        }
        if (!isCurrent()) return;
        ensurePanel();
        await panel?.refresh();
    })();
    current.readyStart = pending;
    try {
        await pending;
    } finally {
        if (current.readyStart === pending) current.readyStart = null;
    }
}

function scheduleEnabledModules(options) {
    void startEnabledModules(options).catch(error => console.debug(LOG_PREFIX, '后台优化启动失败', error));
}

async function stopOptimizationModules({ stopCache = false } = {}) {
    if (!runtime) return;
    runtime.generation += 1;
    runtime.chatStart = null;
    runtime.startupOptimizer.stop();
    runtime.chatHistoryBatch?.stop();
    runtime.regexUiAdapter?.stop();
    runtime.regexRefresh?.stop();
    runtime.streamingRender?.stop();
    await runtime.chatOptimizer.stop();
    runtime.interactionOptimizer?.stop();
    runtime.scheduler.cancelAll('优化模块正在重启');
    if (stopCache) await runtime.cacheController?.stop({ clear: true });
}

async function restartModules({ stopOnly = false, skipCache = false } = {}) {
    await stopOptimizationModules({ stopCache: false });
    if (!stopOnly) await startEnabledModules({ skipCache });
}

async function changePageAcceleration(enabled, current) {
    if (enabled) {
        current.startupOptimizer.start({ startupFeatures: true });
        if (appReady) await current.cacheController.startAfterLogin();
        return;
    }
    if (settings.chatOptimization) current.startupOptimizer.start({ startupFeatures: false });
    else current.startupOptimizer.stop();
    await current.cacheController.stop({ clear: true });
}

async function changeChatOptimization(enabled, current) {
    if (!enabled) {
        current.regexUiAdapter.stop();
        current.regexRefresh.stop();
        current.streamingRender.stop();
        await current.chatOptimizer.stop();
        if (!settings.pageAcceleration) current.startupOptimizer.stop();
        return;
    }
    const chatStart = current.chatOptimizer.start({ legacyTruncation, chatPageSize: settings.chatPageSize });
    current.startupOptimizer.start({ startupFeatures: settings.pageAcceleration });
    await chatStart;
    legacyTruncation = null;
    if (!appReady) return;
    current.streamingRender.start();
    const refreshReady = await current.regexRefresh.start();
    if (refreshReady) await current.regexUiAdapter.start();
}

async function changeInteractionOptimization(enabled, current) {
    if (enabled && appReady) {
        const generation = current.generation;
        await current.interactionOptimizer.start();
        if (!activated || runtime !== current || current.generation !== generation || !settings.interactionOptimization) return;
        await current.chatHistoryBatch?.start();
        if (!activated || runtime !== current || current.generation !== generation || !settings.interactionOptimization) current.chatHistoryBatch?.stop();
    } else {
        current.interactionOptimizer.stop();
        current.chatHistoryBatch?.stop();
    }
}

async function changeChatPageSize(value, current) {
    const pageSize = current.chatOptimizer.setPageSize(value);
    settings.chatPageSize = pageSize;
}

const settingHandlers = Object.freeze({
    pageAcceleration: changePageAcceleration,
    chatOptimization: changeChatOptimization,
    interactionOptimization: changeInteractionOptimization,
    chatPageSize: changeChatPageSize,
});

async function changeSetting(key, value) {
    const handler = settingHandlers[key];
    settings[key] = value;
    if (handler) await handler(value, getRuntime());
    persistSettings();
    await panel?.refresh();
}

async function getPanelStatus() {
    const { cacheController, interactionOptimizer, performanceConfig, startupOptimizer } = getRuntime();
    // A confirmed /health 404 means there is no backend /performance route either.
    const backendMissing = cacheController.backendMissing === true;
    const unavailablePerformance = {
        available: false,
        settings: { keepAlive: null, lazyCharacters: null, chatCompression: null },
        error: '服务端插件未安装或接口不存在',
    };
    const [, performance] = await Promise.all([
        appReady && cacheController?.state === 'available' ? cacheController.refreshStats() : null,
        backendMissing ? unavailablePerformance : (appReady ? performanceConfig.refresh() : (performanceConfig.status || { pending: true })),
    ]);
    return {
        ...cacheController?.getStatus(),
        chat: settings.chatOptimization ? runtimeStatus.chat : '关闭',
        interaction: settings.interactionOptimization ? runtimeStatus.interaction : '关闭',
        startupDiagnostic: startupOptimizer.getDiagnosticSummary(),
        interactionDiagnostic: interactionOptimizer.getDiagnosticSummary(),
        performance: backendMissing ? performance : (performanceConfig.status || performance),
    };
}

async function copyDiagnostics() {
    const { interactionOptimizer, startupOptimizer, copyDiagnosticText } = getRuntime();
    const report = {
        schema: 1,
        pluginVersion: settings?.settingsVersion || 'unknown',
        exportedAt: new Date().toISOString(),
        sillyTavernVersion: document.querySelector('#version_display')?.textContent?.match(
            /SillyTavern \d+\.\d+\.\d+(?: '[\w./-]{1,48}' \([a-f\d]{4,40}\))?/i,
        )?.[0] || 'unknown',
        chatState: {
            active: getCurrentChatId() != null,
            messages: chat.length,
            renderedMessages: document.querySelectorAll('#chat .mes[mesid]').length,
            generating: Boolean(isGenerating()),
        },
        startup: startupOptimizer.getDiagnosticReport(),
        interaction: interactionOptimizer.getDiagnosticReport(),
        streaming: getRuntime().streamingRender?.getReport?.() || null,
    };
    await copyDiagnosticText(JSON.stringify(report, null, 2));
}

async function changePerformanceSetting(key, enabled) {
    const { performanceConfig } = getRuntime();
    const result = await performanceConfig.set(key, enabled);
    await panel?.refresh();
    return result;
}

function mountPanel() {
    if (!settings) loadSettings();
    const { SettingsPanel, repairAccelerator } = getRuntime();
    if (!SettingsPanel || !activated) return false;
    panel ??= new SettingsPanel({
        settings,
        onSettingChange: changeSetting,
        onPerformanceChange: changePerformanceSetting,
        onRerender: () => getRuntime().regexRefresh.reapply({ automatic: false }),
        onRepair: () => settings.pageAcceleration
            ? repairAccelerator({ cacheController: getRuntime().cacheController, restartModules })
            : restartModules().then(() => ({ warmed: 0 })),
        onCopyDiagnostics: copyDiagnostics,
        getStatus: getPanelStatus,
    });
    return panel.mount();
}

function ensurePanel() {
    if (mountPanel()) {
        panelRetries = 0;
        return;
    }
    if (panelTimer !== null || panelRetries >= PANEL_RETRY_LIMIT) return;
    panelTimer = setTimeout(() => {
        panelTimer = null;
        panelRetries += 1;
        ensurePanel();
    }, 250);
}

// Avoid doing chat DOM/highlighter work while SillyTavern is activating extensions.
eventSource.once(event_types.SETTINGS_LOADED, () => {
    settingsLoaded = true;
    if (activated) scheduleEnabledModules();
});

eventSource.once(event_types.APP_READY, () => {
    appReady = true;
    if (settingsSavePending && activated) {
        settingsSavePending = false;
        saveSettingsDebounced();
    }
    if (activated) scheduleEnabledModules();
});

export function onActivate() {
    activated = true;
    loadSettings();
    const current = getRuntime();
    if (settingsLoaded || appReady) {
        scheduleEnabledModules();
    } else if (settings.pageAcceleration || settings.chatOptimization) {
        current.startupOptimizer.start({ startupFeatures: settings.pageAcceleration });
    }
}

export function onUpdate() {
    if (!settings) loadSettings();
    if (!activated) return;
    if (settingsLoaded || appReady) scheduleEnabledModules({ forceCache: true });
    else if (settings.pageAcceleration || settings.chatOptimization) {
        getRuntime().startupOptimizer.start({ startupFeatures: settings.pageAcceleration });
    }
}

async function cleanup() {
    activated = false;
    settingsSavePending = false;
    if (panelTimer !== null) clearTimeout(panelTimer);
    panelTimer = null;
    panelRetries = 0;
    panel?.remove();
    panel = null;
    await stopOptimizationModules({ stopCache: true });
    runtime?.scheduler.destroy();
    runtime = null;
}

export async function onDisable() {
    await cleanup();
}

export async function onDelete() {
    await cleanup();
}
