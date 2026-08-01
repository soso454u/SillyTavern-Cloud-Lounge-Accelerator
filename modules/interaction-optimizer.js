import { DrawerAnimationAdapter } from '../adapters/drawer-animation.js';
import { PresetPanelAdapter } from '../adapters/preset-panel.js';
import { createPresetDragAdapter } from '../adapters/preset-drag.js';
import { createRegexDragAdapter } from '../adapters/regex-drag.js';
import { createWorldInfoDragAdapter } from '../adapters/worldinfo-drag.js';

export class InteractionOptimizer {
    constructor({ onStatus = null } = {}) {
        this.onStatus = onStatus;
        this.presetPanel = new PresetPanelAdapter();
        this.adapters = [
            createPresetDragAdapter(),
            createRegexDragAdapter(),
            createWorldInfoDragAdapter(),
            new DrawerAnimationAdapter(),
        ];
        this.started = false;
        this.generation = 0;
    }

    async start() {
        if (this.started) return;
        this.started = true;
        const generation = ++this.generation;
        const panelPatched = await this.presetPanel.start();
        if (!this.started || generation !== this.generation) {
            this.presetPanel.stop();
            return;
        }
        const dragResults = this.adapters.map(adapter => adapter.start());
        const active = panelPatched || dragResults.some(Boolean);
        this.onStatus?.('interaction', active ? '正常' : '兼容模式');
        document.body?.classList.add('cla-interaction-optimized');
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.generation += 1;
        this.presetPanel.stop();
        this.adapters.forEach(adapter => adapter.stop());
        document.body?.classList.remove('cla-interaction-optimized');
    }
}
