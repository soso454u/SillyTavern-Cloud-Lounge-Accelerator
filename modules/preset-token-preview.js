import { SentPromptTotal } from './sent-prompt-total.js';

// Preview the edited prompt using the native asynchronous model tokenizer.
// Row previews fill only native placeholders and never replace native counts.
const NATIVE_CONTEXT_IDS = new Set([
    'chatHistory', 'dialogueExamples', 'worldInfoBefore', 'worldInfoAfter',
    'charDescription', 'charPersonality', 'scenario', 'personaDescription',
]);
const RAW_TOKENS = 'data-cla-preset-raw-tokens';

function canPreview(prompt) {
    return Boolean(prompt?.identifier && !prompt.marker && !NATIVE_CONTEXT_IDS.has(prompt.identifier));
}
export class PresetTokenPreview {
    constructor({ documentRef = globalThis.document, delay = 300, sentOptions, loadApi = async () => {
        const [openai, tokenizer] = await Promise.all([import('../../../../openai.js'), import('../../../../tokenizers.js')]);
        return { manager: openai.promptManager, count: tokenizer.countTokensOpenAIAsync, tokenizerModel: tokenizer.getTokenizerModel,
            model: () => JSON.stringify([tokenizer.getTokenizerModel?.(), openai.getChatCompletionModel?.(), openai.oai_settings?.chat_completion_source]) };
    } } = {}) {
        Object.assign(this, { document: documentRef, delay, loadApi, sentOptions });
        this.started = false; this.generation = 0; this.revision = 0;
        this.tracked = new WeakMap(); this.cache = new Map(); this.wrappers = []; this.previewCells = new Set();
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
                this.draft = canPreview(prompt) && !this.field('prompt')?.disabled
                    ? { id: prompt.identifier, scope: this.scope() } : null;
                this.badge?.remove();
                this.badge = null;
                if (this.draft) {
                    this.track(this.draft.id);
                    this.ensureBadge();
                    if (this.badge) this.badge.textContent = '草稿：计数中…';
                }
                this.schedule();
                return result;
            });
            this.wrap('clearEditForm', (original, args) => {
                const draft = this.draft;
                const scope = this.scope();
                // The insert/copy tool saves a new prompt by appending it in
                // a replacement array. A preset switch must not inherit IDs.
                if (draft?.scope && scope?.length === draft.scope.length + 1
                    && draft.scope.every((prompt, index) => scope[index] === prompt)
                    && scope.at(-1)?.identifier === draft.id && canPreview(scope.at(-1))) {
                    this.track(draft.id);
                }
                this.draft = null; this.badge?.remove(); this.badge = null;
                const result = original(...args);
                this.schedule(); return result;
            });
            if (this.sentOptions) {
                this.sent = new SentPromptTotal({ ...this.sentOptions, manager, model: this.model, tokenizerModel: api.tokenizerModel });
                this.sent.start();
            }
            this.wrap('renderPromptManagerListItems', async (original, args) => {
                const result = await original(...args);
                this.sent?.render();
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
        const manager = this.manager, previous = manager[key], generation = this.generation;
        const wrapped = (...args) => this.started && this.generation === generation ? handler(previous.bind(manager), args) : previous.apply(manager, args);
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
        this.sent?.render();
        // At most one tokenizer request is in flight. New input supersedes it.
        if (this.running) { this.queued = true; return; }
        this.running = true;
        const generation = this.generation, revision = this.revision, scope = this.scope(), model = this.model();
        const valid = () => this.started && this.generation === generation && this.revision === revision
            && this.scope() === scope && this.model() === model;
        try {
            for (const cell of this.previewCells) {
                if (!cell.isConnected || cell.getAttribute('data-pm-tokens') !== '-') {
                    cell.removeAttribute(RAW_TOKENS);
                    this.previewCells.delete(cell);
                }
            }
            const draftId = this.draft?.scope === scope ? this.draft?.id : null;
            const ids = new Set([...(draftId ? [draftId] : []), ...(this.tracked.get(scope) || [])]);
            for (const id of ids) {
                if (!valid()) break;
                const prompt = this.manager.getPromptById(id);
                const draft = draftId === id && this.field('save')?.dataset.pmPrompt === id && !this.field('prompt')?.disabled;
                if (prompt ? !canPreview(prompt) : !draft) continue;
                const cell = this.rowPlaceholder(id);
                if (!draft && !cell) continue;
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
                // Recheck after awaiting tokenization: a native render may
                // have replaced the row or supplied an authoritative count.
                const placeholder = this.rowPlaceholder(id);
                if (placeholder) {
                    placeholder.setAttribute(RAW_TOKENS, String(count));
                    this.previewCells.add(placeholder);
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

    rowPlaceholder(id) {
        const row = [...(this.manager.listElement?.children || [])].find(element => element.dataset.pmIdentifier === id);
        if (!row?.querySelector('.prompt-manager-edit-action')
            || row.classList.contains(`${this.manager.configuration.prefix}prompt_manager_marker`)) return null;
        const cell = row.querySelector(':scope > .prompt_manager_prompt_tokens');
        return cell?.getAttribute('data-pm-tokens') === '-' ? cell : null;
    }

    stop() {
        this.started = false; this.generation++; this.revision++;
        this.sent?.stop(); this.sent = null;
        clearTimeout(this.timer); this.timer = null;
        for (const type of ['input', 'change']) this.document?.removeEventListener(type, this.onInput);
        this.document?.removeEventListener('compositionend', this.onComposition);
        for (const { key, previous, wrapped } of this.wrappers.reverse()) if (this.manager[key] === wrapped) this.manager[key] = previous;
        this.wrappers = [];
        this.badge?.remove(); this.badge = null; this.draft = null;
        for (const cell of this.previewCells) cell.removeAttribute(RAW_TOKENS);
        this.previewCells.clear(); this.cache.clear(); this.tracked = new WeakMap();
    }
}
