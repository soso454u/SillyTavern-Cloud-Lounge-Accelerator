const TOGGLE_SELECTOR = '.prompt-manager-toggle-action';
const ROW_SELECTOR = '[data-pm-identifier]';
const LOG_PREFIX = '[Cloud Lounge Accelerator]';

export class PromptToggleAdapter {
    constructor({ isGenerating = () => false, eventSource, eventTypes }) {
        this.isGenerating = isGenerating;
        this.eventSource = eventSource;
        this.eventTypes = eventTypes;
        this.openai = null;
        this.started = false;
        this.pendingManagers = new Set();
        this.flushTimer = null;
        this.onClick = this.onClick.bind(this);
        this.onGenerationFinished = this.onGenerationFinished.bind(this);
    }

    async start() {
        if (this.started) return true;
        try {
            this.openai = await import('../../../../openai.js');
        } catch (error) {
            console.debug(LOG_PREFIX, '生成期间预设开关适配不可用', error);
            return false;
        }
        this.started = true;
        document.addEventListener('click', this.onClick, true);
        for (const name of [this.eventTypes?.GENERATION_STOPPED, this.eventTypes?.GENERATION_ENDED]) {
            if (name) this.eventSource?.on?.(name, this.onGenerationFinished);
        }
        return true;
    }

    getManagerForRow(row) {
        const manager = this.openai?.promptManager;
        if (!manager || !row || !manager.listElement?.contains?.(row)) return null;
        return manager;
    }

    updateRow(row, toggle, manager, enabled) {
        const prefix = String(manager.configuration?.prefix || '');
        row.classList.toggle(`${prefix}prompt_manager_prompt_disabled`, !enabled);
        toggle.classList.toggle('fa-toggle-on', enabled);
        toggle.classList.toggle('fa-toggle-off', !enabled);
        toggle.setAttribute('aria-pressed', String(enabled));
    }

    onClick(event) {
        if (!this.started || !this.isGenerating?.()) return;
        const toggle = event.target instanceof Element ? event.target.closest(TOGGLE_SELECTOR) : null;
        const row = toggle?.closest(ROW_SELECTOR);
        const manager = this.getManagerForRow(row);
        const promptId = row?.dataset?.pmIdentifier;
        const entry = manager && promptId
            ? manager.getPromptOrderEntry?.(manager.activeCharacter, promptId)
            : null;
        if (!toggle || !row || !manager || !entry || typeof manager.saveServiceSettings !== 'function') return;

        event.preventDefault();
        event.stopImmediatePropagation();

        const previous = Boolean(entry.enabled);
        const enabled = !previous;
        entry.enabled = enabled;
        const counts = manager.tokenHandler?.getCounts?.();
        if (counts) counts[promptId] = null;
        this.updateRow(row, toggle, manager, enabled);
        this.pendingManagers.add(manager);
        this.queueFlush();

        try {
            const saving = manager.saveServiceSettings();
            Promise.resolve(saving).catch(error => {
                if (entry.enabled === enabled) {
                    entry.enabled = previous;
                    this.updateRow(row, toggle, manager, previous);
                }
                console.error(LOG_PREFIX, '生成期间预设开关保存失败', error);
                globalThis.toastr?.error?.('预设开关保存失败，已恢复原状态', '云酒馆加速器');
            });
        } catch (error) {
            entry.enabled = previous;
            this.updateRow(row, toggle, manager, previous);
            console.error(LOG_PREFIX, '生成期间预设开关保存失败', error);
            globalThis.toastr?.error?.('预设开关保存失败，已恢复原状态', '云酒馆加速器');
        }
    }

    onGenerationFinished() {
        this.queueFlush(40);
    }

    queueFlush(delay = 80) {
        clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => this.flushWhenUnlocked(), delay);
    }

    flushWhenUnlocked() {
        this.flushTimer = null;
        if (!this.started || !this.pendingManagers.size) return;
        if (this.isGenerating?.()) {
            this.queueFlush(80);
            return;
        }
        const managers = [...this.pendingManagers];
        this.pendingManagers.clear();
        requestAnimationFrame(() => {
            if (!this.started) return;
            for (const manager of managers) {
                if (typeof manager.renderDebounced === 'function') manager.renderDebounced();
                else manager.render?.(true);
            }
        });
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        document.removeEventListener('click', this.onClick, true);
        for (const name of [this.eventTypes?.GENERATION_STOPPED, this.eventTypes?.GENERATION_ENDED]) {
            if (name) this.eventSource?.removeListener?.(name, this.onGenerationFinished);
        }
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
        this.pendingManagers.clear();
        this.openai = null;
    }
}
