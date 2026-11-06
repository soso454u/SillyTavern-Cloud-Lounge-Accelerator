// Preview the edited prompt using the native asynchronous model tokenizer.
// Row previews never alter the native context budget/count cache or save drafts.
export class PresetTokenPreview {
    constructor({ documentRef = globalThis.document, delay = 300, loadApi = async () => {
        const [openai, tokenizer] = await Promise.all([import('../../../../openai.js'), import('../../../../tokenizers.js')]);
        return { manager: openai.promptManager, count: tokenizer.countTokensOpenAIAsync,
            model: () => JSON.stringify([tokenizer.getTokenizerModel?.(), openai.getChatCompletionModel?.(), openai.oai_settings?.chat_completion_source]) };
    } } = {}) {
        Object.assign(this, { document: documentRef, delay, loadApi });
        this.started = false; this.generation = 0; this.revision = 0;
        this.tracked = new WeakMap(); this.cache = new Map(); this.wrappers = [];
        this.onInput = event => {
            if (event.isComposing) return;
            if (this.isField(event.target)) this.schedule();
        };
        this.onComposition = event => { if (this.isField(event.target)) this.schedule(); };
    }

    async start() {
        if (this.started) return false;
        const generation = ++this.generation;
        try {
            const api = await this.loadApi();
            if (generation !== this.generation) return false;
            const manager = api.manager;
            if (!manager || typeof api.count !== 'function'
                || !['loadPromptIntoEditForm', 'clearEditForm', 'renderPromptManagerListItems'].every(key => typeof manager[key] === 'function')) return false;
            Object.assign(this, { manager, count: api.count, model: api.model || (() => '') });
            this.started = true;
            this.wrap('loadPromptIntoEditForm', (original, args) => {
                const result = original(...args);
                const prompt = args[0];
                this.draft = prompt && !prompt.marker ? { id: prompt.identifier, scope: this.scope() } : null;
                if (this.draft) {
                    this.lastEdited = this.draft.id; this.track(this.draft.id);
                    this.ensureBadge();
                    if (this.badge) this.badge.textContent = '草稿：计数中…';
                    this.schedule();
                }
                return result;
            });
            this.wrap('clearEditForm', (original, args) => {
                this.revision++; this.draft = null; this.badge?.remove(); this.badge = null;
                const result = original(...args);
                this.schedule(); return result;
            });
            this.wrap('renderPromptManagerListItems', async (original, args) => {
                const result = await original(...args);
                if (this.lastEdited && this.manager.getPromptById(this.lastEdited)) this.track(this.lastEdited);
                this.schedule(); return result;
            });
            for (const type of ['input', 'change']) this.document.addEventListener(type, this.onInput);
            this.document.addEventListener('compositionend', this.onComposition);
            return true;
        } catch (error) {
            console.debug('[Cloud Lounge Accelerator] 预设实时 token 不可用', error);
            this.stop(); return false;
        }
    }

    wrap(key, handler) {
        const manager = this.manager, previous = manager[key];
        const wrapped = (...args) => this.started ? handler(previous.bind(manager), args) : previous.apply(manager, args);
        manager[key] = wrapped; this.wrappers.push({ key, previous, wrapped });
    }

    scope() { return this.manager?.serviceSettings?.prompts; }
    track(id) {
        const scope = this.scope();
        if (!scope || !id) return;
        if (!this.tracked.has(scope)) this.tracked.set(scope, new Set());
        this.tracked.get(scope).add(id);
    }
    isField(target) {
        const prefix = this.manager?.configuration?.prefix;
        return target?.id?.startsWith(`${prefix}prompt_manager_popup_entry_form_`)
            || ['openai_model', 'chat_completion_source', 'custom_model_id'].includes(target?.id)
            || /^model_.+_select$/.test(target?.id || '');
    }
    field(name) { return this.document.getElementById(`${this.manager.configuration.prefix}prompt_manager_popup_entry_form_${name}`); }

    ensureBadge() {
        const field = this.field('prompt');
        if (!this.badge?.isConnected && field) {
            this.badge = this.document.createElement('small');
            this.badge.className = 'cla-preset-token-preview';
            this.badge.setAttribute('role', 'status'); this.badge.setAttribute('aria-live', 'polite');
            field.after(this.badge);
        }
    }

    schedule() {
        this.revision++;
        clearTimeout(this.timer);
        if (this.started) this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, this.delay);
    }

    async refresh() {
        if (!this.started) return;
        // At most one tokenizer request is in flight. New input supersedes it.
        if (this.running) { this.queued = true; return; }
        this.running = true;
        const generation = this.generation, revision = this.revision, scope = this.scope(), model = this.model();
        const valid = () => this.started && this.generation === generation && this.revision === revision
            && this.scope() === scope && this.model() === model;
        try {
            for (const cell of this.originalCells?.keys() || []) if (!cell.isConnected) this.originalCells.delete(cell);
            const ids = this.tracked.get(scope) || [];
            for (const id of ids) {
                if (!valid()) break;
                const prompt = this.manager.getPromptById(id);
                const draft = this.draft?.id === id && this.draft.scope === scope && this.field('save')?.dataset.pmPrompt === id;
                if (!prompt && !draft) continue;
                if (prompt?.marker) continue;
                const content = draft ? this.field('prompt')?.value ?? '' : prompt.content ?? '';
                const role = draft ? this.field('role')?.value || 'system' : prompt.role || 'system';
                // Macro expansion can execute setvar/custom macros. Count raw
                // editor text only; never run prompt macros just for a preview.
                const prepared = { role, content };
                const key = JSON.stringify([model, prepared.role, prepared.content]);
                let count = this.cache.get(key);
                if (count === undefined) {
                    count = prepared.content ? await this.count({ role: prepared.role, content: prepared.content }) : 0;
                    if (!Number.isFinite(count) || count < 0) throw new Error('token count unavailable');
                    if (valid()) {
                        this.cache.set(key, count);
                        if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
                    }
                }
                if (!valid()) break;
                const row = [...(this.manager.listElement?.querySelectorAll('[data-pm-identifier]') || [])]
                    .find(element => element.dataset.pmIdentifier === id);
                const cell = row?.querySelector('.prompt_manager_prompt_tokens');
                if (cell) {
                    const original = this.originalCells ??= new Map();
                    if (!original.has(cell)) original.set(cell, { html: cell.innerHTML, tokens: cell.getAttribute('data-pm-tokens'), title: cell.getAttribute('title') });
                    cell.textContent = String(count); cell.dataset.pmTokens = String(count);
                    cell.title = `当前模型的条目${draft ? '草稿' : '原文'} token 数；宏展开及实际上下文以酒馆统计为准`;
                }
                if (draft) {
                    this.ensureBadge();
                    if (this.badge) this.badge.textContent = `草稿：${count} tokens`;
                }
            }
        } catch {
            if (valid() && this.badge) this.badge.textContent = 'token 计数暂不可用';
        } finally {
            this.running = false;
            if (this.queued && this.started) { this.queued = false; this.schedule(); }
        }
    }

    stop() {
        this.started = false; this.generation++; this.revision++;
        clearTimeout(this.timer); this.timer = null;
        for (const type of ['input', 'change']) this.document?.removeEventListener(type, this.onInput);
        this.document?.removeEventListener('compositionend', this.onComposition);
        for (const { key, previous, wrapped } of this.wrappers.reverse()) if (this.manager[key] === wrapped) this.manager[key] = previous;
        this.wrappers = [];
        this.badge?.remove(); this.badge = null; this.draft = null;
        for (const [cell, previous] of this.originalCells || []) if (cell.isConnected) {
            cell.innerHTML = previous.html;
            for (const [name, value] of [['data-pm-tokens', previous.tokens], ['title', previous.title]]) {
                if (value === null) cell.removeAttribute(name); else cell.setAttribute(name, value);
            }
        }
        this.originalCells?.clear(); this.cache.clear(); this.tracked = new WeakMap();
    }
}
