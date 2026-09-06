import {
    chat,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    isGenerating,
    refreshSwipeButtons,
    reloadCurrentChat,
    saveSettingsDebounced,
    scrollChatToBottom,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { CacheController } from './modules/cache-controller.js';
import { ChatOptimizer } from './modules/chat-optimizer.js';
import { InteractionOptimizer } from './modules/interaction-optimizer.js';
import { PerformanceConfigController } from './modules/performance-config.js';
import { RegexRefreshController } from './modules/regex-refresh.js';
import { RegexUiAdapter } from './modules/regex-ui-adapter.js';
import { repairAccelerator } from './modules/repair.js';
import { StartupOptimizer } from './modules/startup-optimizer.js';
import { getLegacyChatTruncation, normalizeSettings } from './settings.js';
import { SettingsPanel } from './ui/panel.js';
import { FrameScheduler } from './utils/scheduler.js';

const MODULE_ID = 'cloud_lounge_accelerator';
const LOG_PREFIX = '[Cloud Lounge Accelerator]';
const PANEL_RETRY_LIMIT = 24;

let settings = null;
let legacyTruncation = null;
let activated = false;
let appReady = false;
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
    saveSettingsDebounced();
    return settings;
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
    const cacheController = new CacheController({ onStatus: updateRuntimeStatus });
    const chatOptimizer = new ChatOptimizer({
        eventSource,
        eventTypes: event_types,
        chat,
        isGenerating,
        getCurrentChatId,
        scheduler,
        saveSettings: saveSettingsDebounced,
        scrollToBottom: scrollChatToBottom,
        refreshSwipeButtons,
        onStatus: updateRuntimeStatus,
    });
    const startupOptimizer = new StartupOptimizer({
        eventSource,
        eventTypes: event_types,
        getCurrentChatId,
        onChatPayload: messages => chatOptimizer.inspectPayload(messages),
        onStatus: value => updateRuntimeStatus('startup', value),
    });
    const regexRefresh = new RegexRefreshController({
        chat,
        eventSource,
        eventTypes: event_types,
        reloadCurrentChat,
        scheduler,
        onStatus: updateRuntimeStatus,
    });
    const regexUiAdapter = new RegexUiAdapter({ onSaved: () => regexRefresh.noteChange() });
    const interactionOptimizer = new InteractionOptimizer({
        isGenerating,
        eventSource,
        eventTypes: event_types,
        onStatus: updateRuntimeStatus,
    });
    const performanceConfig = new PerformanceConfigController({ getRequestHeaders });
    return {
        cacheController,
        chatOptimizer,
        interactionOptimizer,
        performanceConfig,
        regexRefresh,
        regexUiAdapter,
        scheduler,
        startupOptimizer,
    };
}

function getRuntime() {
    runtime ??= createRuntime();
    return runtime;
}

async function startEnabledModules({ skipCache = false, forceCache = false } = {}) {
    if (!activated) return;
    const {
        cacheController,
        chatOptimizer,
        interactionOptimizer,
        regexRefresh,
        regexUiAdapter,
        startupOptimizer,
    } = getRuntime();
    let chatStart = null;
    if (settings.chatOptimization) {
        chatStart = chatOptimizer.start({ legacyTruncation });
    }
    if (settings.pageAcceleration || settings.chatOptimization) {
        startupOptimizer.start({ startupFeatures: settings.pageAcceleration });
    }
    if (chatStart) {
        await chatStart;
        legacyTruncation = null;
    }
    if (settings.interactionOptimization) await interactionOptimizer.start();
    if (!appReady) return;
    if (settings.chatOptimization) {
        const refreshReady = await regexRefresh.start();
        if (refreshReady) await regexUiAdapter.start();
    }
    if (settings.pageAcceleration && !skipCache) {
        try {
            await cacheController.startAfterLogin({ force: forceCache });
        } catch (error) {
            console.debug(LOG_PREFIX, '页面缓存增强未启用', error);
        }
    }
    ensurePanel();
    await panel?.refresh();
}

async function stopOptimizationModules({ stopCache = false } = {}) {
    if (!runtime) return;
    runtime.startupOptimizer.stop();
    runtime.regexUiAdapter.stop();
    runtime.regexRefresh.stop();
    await runtime.chatOptimizer.stop();
    runtime.interactionOptimizer.stop();
    runtime.scheduler.cancelAll('优化模块正在重启');
    if (stopCache) await runtime.cacheController.stop({ clear: true });
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
        await current.chatOptimizer.stop();
        if (!settings.pageAcceleration) current.startupOptimizer.stop();
        return;
    }
    const chatStart = current.chatOptimizer.start({ legacyTruncation });
    current.startupOptimizer.start({ startupFeatures: settings.pageAcceleration });
    await chatStart;
    legacyTruncation = null;
    if (!appReady) return;
    const refreshReady = await current.regexRefresh.start();
    if (refreshReady) await current.regexUiAdapter.start();
}

async function changeInteractionOptimization(enabled, current) {
    if (enabled) await current.interactionOptimizer.start();
    else current.interactionOptimizer.stop();
}

const settingHandlers = Object.freeze({
    pageAcceleration: changePageAcceleration,
    chatOptimization: changeChatOptimization,
    interactionOptimization: changeInteractionOptimization,
});

async function changeSetting(key, enabled) {
    const handler = settingHandlers[key];
    settings[key] = enabled;
    persistSettings();
    if (handler) await handler(enabled, getRuntime());
    await panel?.refresh();
}

async function getPanelStatus() {
    const { cacheController, performanceConfig } = getRuntime();
    const [, performance] = await Promise.all([
        cacheController?.state === 'available' ? cacheController.refreshStats() : null,
        performanceConfig?.refresh(),
    ]);
    return {
        ...cacheController?.getStatus(),
        chat: settings.chatOptimization ? runtimeStatus.chat : '关闭',
        interaction: settings.interactionOptimization ? runtimeStatus.interaction : '关闭',
        performance,
    };
}

async function changePerformanceSetting(key, enabled) {
    const { performanceConfig } = getRuntime();
    const result = await performanceConfig.set(key, enabled);
    await panel?.refresh();
    return result;
}

function mountPanel() {
    if (!settings) loadSettings();
    getRuntime();
    panel ??= new SettingsPanel({
        settings,
        onSettingChange: changeSetting,
        onPerformanceChange: changePerformanceSetting,
        onRerender: () => getRuntime().regexRefresh.reapply({ automatic: false }),
        onRepair: () => settings.pageAcceleration
            ? repairAccelerator({ cacheController: getRuntime().cacheController, restartModules })
            : restartModules().then(() => ({ warmed: 0 })),
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

eventSource.once(event_types.APP_READY, () => {
    appReady = true;
    if (activated) void startEnabledModules();
});

export function onActivate() {
    activated = true;
    loadSettings();
    getRuntime();
    ensurePanel();
    void startEnabledModules();
}

export function onUpdate() {
    if (!settings) loadSettings();
    if (activated) void startEnabledModules({ forceCache: true });
}

async function cleanup() {
    activated = false;
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
