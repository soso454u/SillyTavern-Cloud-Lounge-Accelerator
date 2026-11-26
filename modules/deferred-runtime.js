import { MiniFeatures } from './mini-features.js';
import { PresetEntryActions } from './preset-entry-actions.js';
import { PresetTokenPreview } from './preset-token-preview.js';
// Loaded after APP_READY so these dependencies cannot hold up extension activation.
import { CacheController } from './cache-controller.js';
import { InteractionOptimizer } from './interaction-optimizer.js';
import { PerformanceConfigController } from './performance-config.js';
import { RegexRefreshController } from './regex-refresh.js';
import { RegexUiAdapter } from './regex-ui-adapter.js';
import { StreamingRenderOptimizer } from './streaming-render-optimizer.js';
import { ChatHistoryBatchActions } from './chat-history-batch.js';
import { SecretKeyBatchActions } from './secret-key-batch.js';
import { TransferMenu } from './transfer-menu.js';
import { AutoConnectController } from './auto-connect.js';
import { copyDiagnosticText } from './interaction-diagnostics.js';
import { collectMemoryDiagnostics } from './memory-diagnostics.js';
import { PerformanceDiagnostics } from './performance-diagnostics.js';
import { ChatScrollActivity } from './chat-scroll-activity.js';
export { repairAccelerator } from './repair.js';
export { SettingsPanel } from '../ui/panel.js';

export function createDeferredRuntime({
    chat, chatOptimizer, eventSource, eventTypes, getCurrentChatId, getRequestHeaders,
    isGenerating, scheduler, onStatus,
    getStreamingProcessor,
    extensionSettings,
    scriptApi,
}) {
    const chatScrollActivity = new ChatScrollActivity({
        onIdle: () => chatOptimizer?.queueCodeScan(),
    });
    if (chatOptimizer) chatOptimizer.scrollActivity = chatScrollActivity;
    const regexRefresh = new RegexRefreshController({
        chat, eventSource, eventTypes, getCurrentChatId, isGenerating, scheduler, onStatus,
    });
    const regexUiAdapter = new RegexUiAdapter({ onSaved: () => regexRefresh.noteChange(), extensionSettings });
    const miniFeatures = new MiniFeatures({ regexUiAdapter, factories: {
        presetEntryActions: () => new PresetEntryActions({ isGenerating, extensionSettings, saveSettings: () => scriptApi.saveSettingsDebounced() }),
        presetTokenPreview: () => new PresetTokenPreview({ sentOptions: { eventSource, eventTypes, getCurrentChatId, getRequestHeaders } }),
        chatHistoryBatch: () => new ChatHistoryBatchActions({ scriptApi }),
        secretKeyBatch: () => new SecretKeyBatchActions(),
        transferTools: () => new TransferMenu({ scriptApi, extensionSettings, isGenerating, onRegexSaved: () => regexRefresh.noteChange() }),
        autoConnect: () => new AutoConnectController({ scriptApi, isGenerating, isSecretBusy: () => miniFeatures.modules.secretKeyBatch?.busy }),
    } });
    return {
        miniFeatures,
        cacheController: new CacheController({ onStatus }),
        interactionOptimizer: new InteractionOptimizer({ isGenerating, eventSource, eventTypes, onStatus }),
        performanceConfig: new PerformanceConfigController({ getRequestHeaders }),
        regexRefresh,
        streamingRender: new StreamingRenderOptimizer({ eventSource, eventTypes, getStreamingProcessor }),
        regexUiAdapter,
        chatScrollActivity,
        performanceDiagnostics: new PerformanceDiagnostics(),
        async getPanelStatus(settings, runtimeStatus) {
            const { cacheController, interactionOptimizer, performanceConfig, startupOptimizer } = this;
            const backendMissing = cacheController.backendMissing === true;
            const [, performance] = await Promise.all([
                cacheController.state === 'available' ? cacheController.refreshStats() : null,
                backendMissing ? {
                    available: false,
                    settings: { keepAlive: null, lazyCharacters: null, chatCompression: null },
                    error: '服务端插件未安装或接口不存在',
                } : performanceConfig.refresh(),
            ]);
            return {
                ...cacheController.getStatus(),
                chat: settings.chatOptimization ? runtimeStatus.chat : '关闭',
                interaction: settings.interactionOptimization ? runtimeStatus.interaction : '关闭',
                startupDiagnostic: startupOptimizer.getDiagnosticSummary(),
                interactionDiagnostic: interactionOptimizer.getDiagnosticSummary(),
                performance: backendMissing ? performance : (performanceConfig.status || performance),
            };
        },
        async copyDiagnostics(settings) {
            const report = {
                schema: 2,
                pluginVersion: settings.settingsVersion,
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
                startup: this.startupOptimizer.getDiagnosticReport(),
                interaction: this.interactionOptimizer.getDiagnosticReport(),
                streaming: this.streamingRender.getReport(),
                scrolling: this.chatScrollActivity.getReport(),
                performanceCapture: this.performanceDiagnostics.stop(),
                memory: collectMemoryDiagnostics({ chat, characters: scriptApi?.characters }),
            };
            await copyDiagnosticText(JSON.stringify(report, null, 2));
        },
    };
}
