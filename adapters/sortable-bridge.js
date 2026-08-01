import { PointerDragEngine } from '../utils/drag-engine.js';
import { hasPointerDragSupport } from '../utils/feature-detection.js';

export class SortableBridge {
    constructor({ lists, itemSelector, handleSelector = '.drag-handle', label, onCommit = null }) {
        this.lists = lists;
        this.itemSelector = itemSelector;
        this.handleSelector = handleSelector;
        this.label = label;
        this.onCommit = onCommit;
        this.records = new Map();
        this.observer = null;
        this.timer = null;
    }

    start() {
        if (this.observer || !hasPointerDragSupport()) return false;
        this.observer = new MutationObserver(() => this.queueReconcile());
        this.observer.observe(document.body, { childList: true, subtree: true });
        this.reconcile();
        return true;
    }

    queueReconcile() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.reconcile(), 120);
    }

    reconcile() {
        for (const [list, record] of this.records) {
            if (!list.isConnected) {
                record.engine.destroy();
                this.records.delete(list);
            }
        }
        const jquery = globalThis.jQuery || globalThis.$;
        if (!jquery?.fn?.sortable) return;
        for (const list of document.querySelectorAll(this.lists)) {
            const nativeInstance = jquery(list).sortable('instance');
            const existing = this.records.get(list);
            if (existing?.nativeInstance === nativeInstance) continue;
            if (existing) {
                existing.engine.destroy();
                if (existing.nativeInstance?.options) existing.nativeInstance.options.disabled = false;
                this.records.delete(list);
            }
            if (!nativeInstance) continue;
            const callbacks = {
                update: nativeInstance.options?.update,
                stop: nativeInstance.options?.stop,
            };
            nativeInstance.options.disabled = true;
            const engine = new PointerDragEngine({
                list,
                itemSelector: this.itemSelector,
                handleSelector: this.handleSelector,
                label: this.label,
                onCommit: async ({ item }) => {
                    if (this.onCommit) {
                        await this.onCommit({ list, item, jquery, nativeInstance });
                        return;
                    }
                    const event = new CustomEvent('cla-sort-commit', { bubbles: true });
                    const ui = { item: jquery(item), helper: jquery(item), placeholder: jquery() };
                    if (typeof callbacks.update === 'function') await callbacks.update.call(list, event, ui);
                    if (typeof callbacks.stop === 'function') await callbacks.stop.call(list, event, ui);
                },
            });
            this.records.set(list, { engine, nativeInstance });
        }
    }

    stop() {
        this.observer?.disconnect();
        this.observer = null;
        clearTimeout(this.timer);
        this.timer = null;
        for (const [, record] of this.records) {
            record.engine.destroy();
            if (record.nativeInstance?.options) record.nativeInstance.options.disabled = false;
        }
        this.records.clear();
    }
}
