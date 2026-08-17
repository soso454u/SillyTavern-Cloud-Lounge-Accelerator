const TOGGLE_SELECTOR = '.prompt-manager-toggle-action';
const ROW_SELECTOR = '[data-pm-identifier]';
const LOG_PREFIX = '[Cloud Lounge Accelerator]';
const TOUCH_CLICK_SUPPRESS_MS = 900;

export class PromptToggleAdapter {
    constructor({ isGenerating = () => false, eventSource, eventTypes }) {
        this.isGenerating = isGenerating;
        this.eventSource = eventSource;
        this.eventTypes = eventTypes;
        this.openai = null;
        this.started = false;
        this.pendingManagers = new Set();
        this.flushTimer = null;
        this.suppressClickUntil = 0;
        this.suppressedToggle = null;
        this.onPointerUp = this.onPointerUp.bind(this);
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
        document.addEventListener('pointerup', this.onPointerUp, true);
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

    getToggle(event) {
        return event.target instanceof Element ? event.target.closest(TOGGLE_SELECTOR) : null;
    }

    updateRow(row, toggle, manager, enabled, { invalidateTokens = true } = {}) {
        const prefix = String(manager.configuration?.prefix || '');
        row.classList.toggle(`${prefix}prompt_manager_prompt_disabled`, !enabled);
        toggle.classList.toggle('fa-toggle-on', enabled);
        toggle.classList.toggle('fa-toggle-off', !enabled);
        toggle.setAttribute('aria-pressed', String(enabled));
        const tokens = row.querySelector?.('.prompt_manager_prompt_tokens');
        if (tokens && invalidateTokens) {
            tokens.dataset.pmTokens = '-';
            tokens.textContent = '-';
        }
    }

    onPointerUp(event) {
        if (!this.started) return;
        if (event.pointerType === 'mouse' || event.isPrimary === false) return;
        if (typeof event.button === 'number' && event.button !== 0) return;
        const toggle = this.getToggle(event);
        if (!toggle || !this.toggleEntry(event, toggle)) return;
        this.suppressedToggle = toggle;
        this.suppressClickUntil = Date.now() + TOUCH_CLICK_SUPPRESS_MS;
    }

    onClick(event) {
        const toggle = this.getToggle(event);
        if (!toggle) return;
        if (toggle === this.suppressedToggle && Date.now() < this.suppressClickUntil) {
            if (event.cancelable) event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (!this.started) return;
        this.toggleEntry(event, toggle);
    }

    toggleEntry(event, toggle) {
        const row = toggle?.closest(ROW_SELECTOR);
        const manager = this.getManagerForRow(row);
        const promptId = row?.dataset?.pmIdentifier;
        const entry = manager && promptId
            ? manager.getPromptOrderEntry?.(manager.activeCharacter, promptId)
            : null;
        if (!row || !manager || !entry || typeof manager.saveServiceSettings !== 'function') return false;

        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();

        const previous = Boolean(entry.enabled);
        const enabled = !previous;
        const tokenElement = row.querySelector?.('.prompt_manager_prompt_tokens');
        const tokenSnapshot = tokenElement ? {
            html: tokenElement.innerHTML,
            text: tokenElement.textContent,
            value: tokenElement.dataset?.pmTokens,
        } : null;
        const rollback = () => {
            if (entry.enabled !== enabled) return;
            entry.enabled = previous;
            this.updateRow(row, toggle, manager, previous, { invalidateTokens: false });
            if (!tokenElement || !tokenSnapshot) return;
            if (typeof tokenSnapshot.html === 'string') tokenElement.innerHTML = tokenSnapshot.html;
            else tokenElement.textContent = tokenSnapshot.text;
            if (tokenSnapshot.value === undefined) delete tokenElement.dataset.pmTokens;
            else tokenElement.dataset.pmTokens = tokenSnapshot.value;
        };
        entry.enabled = enabled;
        const counts = manager.tokenHandler?.getCounts?.();
        if (counts) counts[promptId] = null;
        this.updateRow(row, toggle, manager, enabled);
        if (this.isGenerating?.()) {
            this.pendingManagers.add(manager);
            this.queueFlush();
        }

        try {
            const saving = manager.saveServiceSettings();
            Promise.resolve(saving).catch(error => {
                rollback();
                console.error(LOG_PREFIX, '预设开关保存失败', error);
                globalThis.toastr?.error?.('预设开关保存失败，已恢复原状态', '云酒馆加速器');
            });
        } catch (error) {
            rollback();
            console.error(LOG_PREFIX, '预设开关保存失败', error);
            globalThis.toastr?.error?.('预设开关保存失败，已恢复原状态', '云酒馆加速器');
        }
        return true;
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
        document.removeEventListener('pointerup', this.onPointerUp, true);
        document.removeEventListener('click', this.onClick, true);
        for (const name of [this.eventTypes?.GENERATION_STOPPED, this.eventTypes?.GENERATION_ENDED]) {
            if (name) this.eventSource?.removeListener?.(name, this.onGenerationFinished);
        }
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
        this.pendingManagers.clear();
        this.suppressClickUntil = 0;
        this.suppressedToggle = null;
        this.openai = null;
    }
}
