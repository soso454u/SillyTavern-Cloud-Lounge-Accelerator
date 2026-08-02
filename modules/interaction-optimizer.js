import { PromptToggleAdapter } from '../adapters/prompt-toggle.js';

export class InteractionOptimizer {
    constructor({ isGenerating, eventSource, eventTypes, onStatus = null } = {}) {
        this.onStatus = onStatus;
        this.promptToggle = new PromptToggleAdapter({ isGenerating, eventSource, eventTypes });
        this.started = false;
    }

    async start() {
        if (this.started) return;
        this.started = true;
        const active = await this.promptToggle.start();
        if (!this.started) {
            this.promptToggle.stop();
            return;
        }
        this.onStatus?.('interaction', active ? '生成可切换' : '原生');
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.promptToggle.stop();
    }
}
