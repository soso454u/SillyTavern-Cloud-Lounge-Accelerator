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
    // Defaults and normalized plugin options ride along on the next native or
    // explicit save. Initialization alone must not upload the shared payload.
    extension_settings[MODULE_ID] = settings;
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
        generation: 0, deferredPromise: null, readyStart: null, chatStart: null, cacheRefresh: null,
    };
}

async function loadDeferredRuntime(current) {
    current.deferredPromise ??= import('./modules/deferred-runtime.js').then(module => {
        if (!activated || current !== runtime) return;
        Object.assign(current, module.createDeferredRuntime({
            chat, chatOptimizer: current.chatOptimizer, eventSource, eventTypes: event_types, getCurrentChatId,
            getRequestHeaders, isGenerating, scheduler: current.scheduler,
            getStreamingProcessor: () => chatApi.streamingProcessor,
            extensionSettings: extension_settings,
            scriptApi: chatApi,
            onStatus: updateRuntimeStatus,
        }), {
            SettingsPanel: module.SettingsPanel,
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
    const afterFrame = callback => current.scheduler.schedule(() => {
        if (isCurrent()) return callback();
    }, { priority: 3 });
    const startCache = force => afterFrame(async () => {
        if (settings.pageAcceleration && !skipCache) {
            try {
                await current.cacheController.startAfterLogin({ force });
            } catch (error) {
                console.debug(LOG_PREFIX, '页面缓存增强未启用', error);
            }
        }
    });
    if (current.readyStart) {
        await current.readyStart;
        if (!forceCache || skipCache || !isCurrent()) return;
        current.cacheRefresh ??= startCache(true).finally(() => {
            if (isCurrent()) current.cacheRefresh = null;
        });
        await current.cacheRefresh;
        return;
    }
    const pending = (async () => {
        await afterFrame(() => loadDeferredRuntime(current));
        if (!isCurrent()) return;
        await afterFrame(() => {
            if (settings.chatOptimization) current.chatOptimizer.startCodeObservation();
            if (settings.interactionOptimization) return current.interactionOptimizer.start();
        });
        if (!isCurrent()) return;
        await afterFrame(() => {
            if (!settings.chatOptimization) return;
            current.streamingRender.start();
            return current.regexRefresh.start();
        });
        if (!isCurrent()) return;
        await current.miniFeatures.apply(settings, { scheduleStart: afterFrame });
        if (!isCurrent()) return;
        await startCache(forceCache);
        if (!isCurrent()) return;
        await afterFrame(ensurePanel);
    })();
    current.readyStart = pending;
    try {
        await pending;
    } catch (error) {
        if (current.readyStart === pending) current.readyStart = null;
        throw error;
    }
}

function scheduleEnabledModules(options) {
    void startEnabledModules(options).catch(error => {
        if (error?.name !== 'AbortError') console.debug(LOG_PREFIX, '后台优化启动失败', error);
    });
}

async function stopOptimizationModules({ stopCache = false } = {}) {
    if (!runtime) return;
    runtime.generation += 1;
    runtime.chatStart = null;
    runtime.readyStart = null;
    runtime.cacheRefresh = null;
    runtime.scheduler.cancelAll('优化模块正在重启');
    runtime.miniFeatures?.stop();
    runtime.startupOptimizer.stop();
    runtime.regexRefresh?.stop();
    runtime.streamingRender?.stop();
    runtime.performanceDiagnostics?.stop();
    await runtime.chatOptimizer.stop();
    runtime.interactionOptimizer?.stop();
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
    current.chatOptimizer.startCodeObservation();
    current.streamingRender.start();
    await current.regexRefresh.start();
}

async function changeInteractionOptimization(enabled, current) {
    if (enabled && appReady) await current.interactionOptimizer.start();
    else current.interactionOptimizer.stop();
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
    if (appReady && (!handler || key === 'chatOptimization')) await getRuntime().miniFeatures?.apply(settings);
    persistSettings();
    await panel?.refresh();
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
        onCopyDiagnostics: () => getRuntime().copyDiagnostics(settings),
        performanceDiagnostics: getRuntime().performanceDiagnostics,
        getStatus: () => getRuntime().getPanelStatus(settings, runtimeStatus),
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
