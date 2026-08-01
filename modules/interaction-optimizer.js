export class InteractionOptimizer {
    constructor({ onStatus = null } = {}) {
        this.onStatus = onStatus;
        this.started = false;
    }

    async start() {
        if (this.started) return;
        this.started = true;
        this.onStatus?.('interaction', '原生');
    }

    stop() {
        if (!this.started) return;
        this.started = false;
    }
}
