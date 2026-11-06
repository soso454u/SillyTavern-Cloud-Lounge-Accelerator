// Convenience tools have independent preferences and do not inherit the three
// performance switches. Serialize startup; disabling cancels imports at once.
export class MiniFeatures {
    constructor({ modules, regexUiAdapter }) {
        Object.assign(this, { modules, regexUiAdapter }); this.queue = Promise.resolve(); this.generation = 0;
    }
    apply(settings) {
        const previous = this.desired;
        if (previous && (previous.presetEntryActions !== settings.presetEntryActions || previous.presetTokenPreview !== settings.presetTokenPreview)) {
            this.modules.presetTokenPreview?.stop(); this.modules.presetEntryActions?.stop();
        }
        const desired = this.desired = { ...settings }, generation = ++this.generation;
        this.stopped = false;
        this.regexUiAdapter.setCollectionsEnabled(desired.regexCollections !== false);
        for (const [key, module] of Object.entries(this.modules)) if (desired[key] === false) module.stop();
        const current = () => !this.stopped && this.generation === generation;
        const run = async () => {
            if (!current()) return;
            for (const [key, module] of Object.entries(this.modules)) {
                if (!current()) return;
                if (desired[key] === false) continue;
                await module.start();
                if (!current() && (this.stopped || this.desired[key] === false)) module.stop();
            }
            if (!current()) return;
            if (desired.chatOptimization || desired.regexCollections !== false) await this.regexUiAdapter.start();
            else this.regexUiAdapter.stop();
            if (!current() && (this.stopped || (!this.desired.chatOptimization && this.desired.regexCollections === false))) this.regexUiAdapter.stop();
        };
        this.queue = this.queue.then(run, run);
        return this.queue;
    }
    stop() {
        this.stopped = true; this.generation++;
        for (const module of Object.values(this.modules).reverse()) module.stop();
        this.regexUiAdapter.stop();
    }
}
