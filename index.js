import {
    chat,
    eventSource,
    event_types,
    isGenerating,
    reloadCurrentChat,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { CacheController } from './modules/cache-controller.js';
import { ChatOptimizer } from './modules/chat-optimizer.js';
import { InteractionOptimizer } from './modules/interaction-optimizer.js';
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
let cacheController = null;
let startupOptimizer = null;
let chatOptimizer = null;
let regexRefresh = null;
let regexUiAdapter = null;
let interactionOptimizer = null;
let scheduler = null;
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

function ensureModules() {
    if (scheduler) return;
    scheduler = new FrameScheduler({
        budgetMs: 9,
        onError: error => {
            if (error?.name !== 'AbortError') console.debug(LOG_PREFIX, '分帧任务失败', error);
        },
    });
    cacheController = new CacheController({ onStatus: updateRuntimeStatus });
    chatOptimizer = new ChatOptimizer({
        eventSource,
        eventTypes: event_types,
        chat,
        isGenerating,
        scheduler,
        saveSettings: saveSettingsDebounced,
        onStatus: updateRuntimeStatus,
    });
    startupOptimizer = new StartupOptimizer({
        eventSource,
        eventTypes: event_types,
        onChatPayload: messages => chatOptimizer.inspectPayload(messages),
        onStatus: value => updateRuntimeStatus('startup', value),
    });
    regexRefresh = new RegexRefreshController({
        chat,
        eventSource,
        eventTypes: event_types,
        reloadCurrentChat,
        scheduler,
        onStatus: updateRuntimeStatus,
    });
    regexUiAdapter = new RegexUiAdapter({ onSaved: () => regexRefresh.noteChange() });
    interactionOptimizer = new InteractionOptimizer({
        isGenerating,
        eventSource,
        eventTypes: event_types,
        onStatus: updateRuntimeStatus,
    });
}

async function startEnabledModules({ skipCache = false, forceCache = false } = {}) {
    if (!activated) return;
    ensureModules();
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
    startupOptimizer?.stop();
    regexUiAdapter?.stop();
    regexRefresh?.stop();
    await chatOptimizer?.stop();
    interactionOptimizer?.stop();
    scheduler?.cancelAll('优化模块正在重启');
    if (stopCache) await cacheController?.stop({ clear: true });
}

async function restartModules({ stopOnly = false, skipCache = false } = {}) {
    await stopOptimizationModules({ stopCache: false });
    if (!stopOnly) await startEnabledModules({ skipCache });
}

async function changeSetting(key, enabled) {
    settings[key] = enabled;
    persistSettings();
    if (key === 'pageAcceleration') {
        if (enabled) {
            startupOptimizer.start({ startupFeatures: true });
            if (appReady) await cacheController.startAfterLogin();
        } else {
            if (settings.chatOptimization) startupOptimizer.start({ startupFeatures: false });
            else startupOptimizer.stop();
            await cacheController.stop({ clear: true });
        }
    } else if (key === 'chatOptimization') {
        if (enabled) {
            const chatStart = chatOptimizer.start({ legacyTruncation });
            startupOptimizer.start({ startupFeatures: settings.pageAcceleration });
            await chatStart;
            legacyTruncation = null;
            if (appReady) {
                const refreshReady = await regexRefresh.start();
                if (refreshReady) await regexUiAdapter.start();
            }
        } else {
            regexUiAdapter.stop();
            regexRefresh.stop();
            await chatOptimizer.stop();
            if (!settings.pageAcceleration) startupOptimizer.stop();
        }
    } else if (key === 'interactionOptimization') {
        if (enabled) await interactionOptimizer.start();
        else interactionOptimizer.stop();
    }
    await panel?.refresh();
}

async function getPanelStatus() {
    if (cacheController?.state === 'available') await cacheController.refreshStats();
    return {
        ...cacheController?.getStatus(),
        chat: settings.chatOptimization ? runtimeStatus.chat : '关闭',
        interaction: settings.interactionOptimization ? runtimeStatus.interaction : '关闭',
    };
}

function mountPanel() {
    if (!settings) loadSettings();
    panel ??= new SettingsPanel({
        settings,
        onSettingChange: changeSetting,
        onRerender: () => regexRefresh.reapply({ automatic: false }),
        onRepair: () => settings.pageAcceleration
            ? repairAccelerator({ cacheController, restartModules })
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
    ensureModules();
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
    scheduler?.destroy();
    scheduler = null;
    cacheController = null;
    startupOptimizer = null;
    chatOptimizer = null;
    regexRefresh = null;
    regexUiAdapter = null;
    interactionOptimizer = null;
}

export async function onDisable() {
    await cleanup();
}

export async function onDelete() {
    await cleanup();
}
