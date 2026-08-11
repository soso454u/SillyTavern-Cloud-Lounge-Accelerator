import { PromptToggleAdapter } from '../adapters/prompt-toggle.js';
import { MobileInteractionGuard } from './mobile-interaction-guard.js';

export class InteractionOptimizer {
    constructor({ isGenerating, eventSource, eventTypes, onStatus = null } = {}) {
        this.onStatus = onStatus;
        this.promptToggle = new PromptToggleAdapter({ isGenerating, eventSource, eventTypes });
        this.mobileGuard = new MobileInteractionGuard({
            onRecovered: () => this.onStatus?.('interaction', '触控已自愈'),
        });
        this.started = false;
    }

    async start() {
        if (this.started) return;
        this.started = true;
        const [promptToggleActive, mobileGuardActive] = await Promise.all([
            this.promptToggle.start(),
            this.mobileGuard.start(),
        ]);
        if (!this.started) {
            this.promptToggle.stop();
            this.mobileGuard.stop();
            return;
        }
        const status = [
            promptToggleActive ? '生成可切换' : null,
            mobileGuardActive ? '触控自愈' : null,
        ].filter(Boolean).join(' · ');
        this.onStatus?.('interaction', status || '原生');
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.promptToggle.stop();
        this.mobileGuard.stop();
    }
}
