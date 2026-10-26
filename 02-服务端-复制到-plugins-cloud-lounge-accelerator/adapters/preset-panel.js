import { cancelIdle, requestIdle } from '../utils/feature-detection.js';

const PATCH_MARK = Symbol.for('cloud-lounge-accelerator.prompt-manager-v2');

export class PresetPanelAdapter {
    constructor() {
        this.prototype = null;
        this.original = null;
        this.pending = new WeakMap();
        this.handles = new Set();
    }

    async start() {
        if (this.prototype) return true;
        try {
            const { PromptManager } = await import('../../../../PromptManager.js');
            const prototype = PromptManager?.prototype;
            if (!prototype?.render) return false;
            if (prototype.render[PATCH_MARK]) return true;
            this.prototype = prototype;
            this.original = prototype.render;
            const adapter = this;
            function renderVisibleFirst(afterTryGenerate = true) {
                if (afterTryGenerate !== true) return adapter.original.call(this, afterTryGenerate);
                adapter.original.call(this, false);
                const previous = adapter.pending.get(this);
                if (previous) cancelIdle(previous);
                const handle = requestIdle(() => {
                    adapter.pending.delete(this);
                    adapter.handles.delete(handle);
                    if (document.hidden) return;
                    adapter.original.call(this, true);
                }, 900);
                adapter.pending.set(this, handle);
                adapter.handles.add(handle);
                return undefined;
            }
            renderVisibleFirst[PATCH_MARK] = true;
            prototype.render = renderVisibleFirst;
            return true;
        } catch (error) {
            console.debug('[Cloud Lounge Accelerator] 预设面板适配不可用，保留酒馆原生流程', error);
            return false;
        }
    }

    stop() {
        if (this.prototype && this.original && this.prototype.render?.[PATCH_MARK]) {
            this.prototype.render = this.original;
        }
        this.prototype = null;
        this.original = null;
        for (const handle of this.handles) cancelIdle(handle);
        this.handles.clear();
        this.pending = new WeakMap();
    }
}
