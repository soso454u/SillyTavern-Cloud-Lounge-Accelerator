// Loaded after APP_READY so these dependencies cannot hold up extension activation.
import { CacheController } from './cache-controller.js';
import { InteractionOptimizer } from './interaction-optimizer.js';
import { PerformanceConfigController } from './performance-config.js';
import { RegexRefreshController } from './regex-refresh.js';
import { RegexUiAdapter } from './regex-ui-adapter.js';
export { copyDiagnosticText } from './interaction-diagnostics.js';
export { repairAccelerator } from './repair.js';
export { SettingsPanel } from '../ui/panel.js';

export function createDeferredRuntime({
    chat, eventSource, eventTypes, getCurrentChatId, getRequestHeaders,
    isGenerating, scheduler, onStatus,
}) {
    const regexRefresh = new RegexRefreshController({
        chat, eventSource, eventTypes, getCurrentChatId, isGenerating, scheduler, onStatus,
    });
    return {
        cacheController: new CacheController({ onStatus }),
        interactionOptimizer: new InteractionOptimizer({ isGenerating, eventSource, eventTypes, onStatus }),
        performanceConfig: new PerformanceConfigController({ getRequestHeaders }),
        regexRefresh,
        regexUiAdapter: new RegexUiAdapter({ onSaved: () => regexRefresh.noteChange() }),
    };
}
