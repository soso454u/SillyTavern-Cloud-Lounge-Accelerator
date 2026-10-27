const ROW = '[data-pm-identifier]';
const OWN = '[data-cla-preset-action]';
const MARK = Symbol('cla-preset-entry-render');

// Use the native editor and settings writer. Drafts do not enter the preset
// until Save; all context checks use the actual preset arrays, not its label.
export class PresetEntryActions {
    constructor({ documentRef = globalThis.document, loadApi = async () => {
        const [openai, { Popup }] = await Promise.all([import('../../../../openai.js'), import('../../../../popup.js')]);
        return { manager: openai.promptManager, confirm: message => {
            const content = documentRef.createElement('p');
            content.textContent = message;
            // A header makes the native helper interpolate text as HTML.
            // Passing no header preserves this safe DOM node and its text.
            return Popup.show.confirm(null, content);
        } };
    }, isGenerating = () => false } = {}) {
        this.document = documentRef;
        this.loadApi = loadApi;
        this.isGenerating = isGenerating;
        this.started = false;
        this.generation = 0;
        this.nodes = new Set();
        this.pending = null;
        this.busy = false;
        this.onClick = this.onClick.bind(this);
        this.onKey = this.onKey.bind(this);
        this.closeMenu = this.closeMenu.bind(this);
    }

    async start() {
        if (this.started) return true;
        const generation = ++this.generation;
        try {
            const api = await this.loadApi();
            if (generation !== this.generation) return false;
            const manager = api.manager;
            const required = ['renderPromptManagerListItems', 'getPromptById', 'getPromptOrderForCharacter',
                'loadPromptIntoEditForm', 'updatePromptWithPromptEditForm', 'saveServiceSettings', 'getUuidv4',
                'clearEditForm', 'clearInspectForm', 'showPopup', 'hidePopup', 'render'];
            if (!required.every(key => typeof manager?.[key] === 'function')) return false;
            this.manager = manager;
            this.confirm = api.confirm;
            this.originalRender = manager.renderPromptManagerListItems;
            const originalRender = this.originalRender;
            const adapter = this;
            const wrapped = async function (...args) {
                const result = await originalRender.apply(this, args);
                if (adapter.started) adapter.decorate();
                return result;
            };
            wrapped[MARK] = true;
            manager.renderPromptManagerListItems = wrapped;
            this.wrappedRender = wrapped;
            this.started = true;
            this.document.addEventListener('click', this.onClick, true);
            this.document.addEventListener('keydown', this.onKey, true);
            this.document.addEventListener('scroll', this.closeMenu, true);
            this.document.defaultView?.addEventListener('resize', this.closeMenu);
            this.decorate();
            return true;
        } catch (error) {
            console.debug('[Cloud Lounge Accelerator] 预设条目工具不可用', error);
            this.stop();
            return false;
        }
    }

    context() {
        const m = this.manager;
        const settings = m?.serviceSettings;
        const character = m?.activeCharacter;
        const holder = settings?.prompt_order?.find(item => String(item.character_id) === String(character?.id));
        if (!character || !Array.isArray(settings?.prompts) || !Array.isArray(holder?.order)) return null;
        return { settings, prompts: settings.prompts, orders: settings.prompt_order, holder, order: holder.order, characterId: String(character.id) };
    }

    current(context) {
        const now = this.context();
        return this.started && !!context && !!now && now.settings === context.settings
            && now.prompts === context.prompts && now.orders === context.orders
            && now.holder === context.holder && now.order === context.order && now.characterId === context.characterId;
    }

    button(label, action) {
        const button = this.document.createElement('button');
        button.type = 'button';
        button.className = 'menu_button';
        button.textContent = label;
        button.dataset.claPresetAction = action;
        return button;
    }

    decorate() {
        this.closeMenu();
        for (const node of this.nodes) if (!node.isConnected) this.nodes.delete(node);
        const list = this.manager?.listElement;
        if (!list?.isConnected) return;
        const context = this.context();
        for (const row of list.querySelectorAll(ROW)) {
            let button = row.querySelector(OWN);
            if (!button) {
                const controls = row.querySelector('.prompt_manager_prompt_controls');
                if (!controls) continue;
                button = this.button('⋯', 'menu');
                button.classList.add('cla-preset-entry-more');
                button.title = '条目操作：插入、复制、移出或删除';
                button.setAttribute('aria-label', button.title);
                button.setAttribute('aria-haspopup', 'menu');
                button.setAttribute('aria-expanded', 'false');
                controls.prepend(button);
                this.nodes.add(button);
            }
            button.disabled = !context || this.busy;
            button.claContext = context;
        }
    }

    openMenu(button, id) {
        const context = button.claContext;
        if (!this.current(context) || this.busy) return;
        const prompt = this.manager.getPromptById(id);
        if (!prompt) return;
        const menu = this.document.createElement('div');
        menu.className = 'cla-preset-entry-menu';
        menu.setAttribute('role', 'menu');
        for (const [action, label] of [['before', '在上方新建'], ['after', '在下方新建'], ['copy', '复制到下方'], ['remove', '移出当前列表'], ['delete', '永久删除条目']]) {
            const item = this.button(label, action);
            item.setAttribute('role', 'menuitem');
            item.claContext = context;
            item.dataset.claPromptId = id;
            if (action === 'copy') item.disabled = !!prompt.marker;
            if (action === 'remove' || action === 'delete') {
                item.disabled = prompt.marker === true || prompt.system_prompt !== false || !this.manager.isPromptDeletionAllowed?.(prompt);
                if (item.disabled) item.title = '酒馆内置条目受保护';
            }
            menu.append(item);
        }
        this.document.body.append(menu);
        this.menu = menu;
        this.menuButton = button;
        button.setAttribute('aria-expanded', 'true');
        const rect = button.getBoundingClientRect();
        const viewport = this.document.documentElement;
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        menu.style.left = `${Math.max(8, Math.min(rect.right - width, viewport.clientWidth - width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, viewport.clientHeight - height - 8))}px`;
        menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    }

    closeMenu() {
        this.menuButton?.setAttribute('aria-expanded', 'false');
        this.menu?.remove();
        this.menu = null;
        this.menuButton = null;
    }

    onKey(event) {
        if (event.key === 'Escape' && this.menu) {
            const button = this.menuButton;
            this.closeMenu();
            button?.focus({ preventScroll: true });
            event.stopPropagation();
        }
    }

    onClick(event) {
        const target = event.target?.closest?.('button, [id], .prompt-manager-edit-action');
        const save = event.target?.closest?.(`[id="${this.manager.configuration.prefix}prompt_manager_popup_entry_form_save"]`);
        if (save && this.pending && save.dataset.pmPrompt === this.pending.prompt.identifier) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!this.busy) void this.saveDraft();
            return;
        }
        const button = event.target?.closest?.(OWN);
        if (!button) {
            this.closeMenu();
            // The native editor owns all ordinary edits, creation and closing.
            if (target && (target.matches?.('.prompt-manager-edit-action') || /prompt_manager_(popup.*(close|reset)|footer)/.test(target.id))) this.pending = null;
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (button.disabled || this.busy) return;
        const action = button.dataset.claPresetAction;
        const id = button.dataset.claPromptId || button.closest(ROW)?.dataset.pmIdentifier;
        const context = button.claContext;
        const wasOpen = this.menuButton === button;
        this.closeMenu();
        if (!this.current(context)) return;
        if (action === 'menu') { if (!wasOpen) this.openMenu(button, id); return; }
        if (action === 'remove' || action === 'delete') void this.deleteEntry(context, id, action === 'delete');
        else this.openDraft(context, id, action);
    }

    openDraft(context, id, action) {
        if (!this.current(context) || this.busy || this.isGenerating()) {
            globalThis.toastr?.info?.('请先等待生成结束再编辑条目', '云酒馆加速器');
            return;
        }
        const source = id ? this.manager.getPromptById(id) : null;
        if (id && (!source || !context.order.some(item => item.identifier === id))) return;
        if (action === 'copy' && source.marker) return;
        const prompt = action === 'copy' ? structuredClone(source) : { name: '新条目', role: 'system', content: '' };
        Object.assign(prompt, { identifier: this.manager.getUuidv4(), system_prompt: false, marker: false, enabled: false });
        if (action === 'copy') prompt.name = `${source.name || '条目'}（副本）`;
        this.manager.clearEditForm();
        this.manager.clearInspectForm();
        this.manager.loadPromptIntoEditForm(prompt);
        this.pending = { context, prompt, anchor: id, before: action === 'before' };
        this.manager.showPopup();
    }

    async write(changes) {
        // Replace only arrays involved in this operation, and roll back only
        // our untouched replacements if the native writer rejects the save.
        for (const change of changes) {
            change.previous = change.owner[change.key];
            change.expected = [...change.next];
            change.owner[change.key] = change.next;
        }
        try { await this.manager.saveServiceSettings(); }
        catch (error) {
            for (const { owner, key, previous, next, expected } of changes) {
                if (owner[key] === next && next.length === expected.length && next.every((item, i) => item === expected[i])) owner[key] = previous;
            }
            throw error;
        }
    }

    async saveDraft() {
        const draft = this.pending;
        if (!draft || this.busy) return;
        if (!this.current(draft.context) || this.isGenerating()) {
            globalThis.toastr?.warning?.('预设已切换或正在生成，请返回原预设后重新新建；当前草稿未提交', '云酒馆加速器');
            return;
        }
        const prompt = structuredClone(draft.prompt);
        this.manager.updatePromptWithPromptEditForm(prompt);
        if (!String(prompt.name || '').trim()) {
            globalThis.toastr?.warning?.('请填写条目名称', '云酒馆加速器');
            return;
        }
        const { context, anchor, before } = draft;
        const index = anchor ? context.order.findIndex(item => item.identifier === anchor) : context.order.length;
        if (index < 0 || context.prompts.some(item => item.identifier === prompt.identifier)) return;
        const order = [...context.order];
        order.splice(index + (anchor && !before ? 1 : 0), 0, { identifier: prompt.identifier, enabled: false });
        this.busy = true;
        this.decorate();
        try {
            await this.write([{ owner: context.settings, key: 'prompts', next: [...context.prompts, prompt] }, { owner: context.holder, key: 'order', next: order }]);
            if (this.pending === draft) {
                this.pending = null;
                const button = this.document.getElementById(`${this.manager.configuration.prefix}prompt_manager_popup_entry_form_save`);
                const now = this.context();
                if (this.started && now?.holder === context.holder && now?.order === order
                    && now?.prompts.includes(prompt) && button?.dataset.pmPrompt === prompt.identifier) {
                    const latest = structuredClone(draft.prompt);
                    this.manager.updatePromptWithPromptEditForm(latest);
                    if (JSON.stringify(latest) === JSON.stringify(prompt)) {
                        this.manager.hidePopup();
                        this.manager.clearEditForm();
                    }
                }
            }
            if (this.started && this.context()?.settings === context.settings && this.context()?.prompts.includes(prompt)) this.manager.render(false);
        } catch (error) {
            console.error('[Cloud Lounge Accelerator] 新建预设条目保存失败', error);
            globalThis.toastr?.error?.('保存失败，编辑框中的草稿已保留，请重试', '云酒馆加速器');
        } finally { this.busy = false; if (this.started) this.decorate(); }
    }

    async deleteEntry(context, id, permanent) {
        if (!this.current(context) || this.busy || this.isGenerating()) return;
        const prompt = this.manager.getPromptById(id);
        if (!prompt || prompt.marker || prompt.system_prompt !== false || !this.manager.isPromptDeletionAllowed?.(prompt)) return;
        this.busy = true;
        this.decorate();
        try {
            const message = permanent
                ? `永久删除“${prompt.name}”？将从本预设的条目库及所有引用列表移除，无法从可用条目中重新添加。`
                : `将“${prompt.name}”移出当前列表？内容保留在可用条目中，可通过原生下拉框重新添加。`;
            if (!await this.confirm(message) || !this.current(context) || this.isGenerating()
                || this.manager.getPromptById(id) !== prompt) return;
            const holders = permanent ? context.orders : [context.holder];
            const changes = holders.filter(holder => holder.order?.some(item => item.identifier === id))
                .map(holder => ({ owner: holder, key: 'order', next: holder.order.filter(item => item.identifier !== id) }));
            if (permanent) changes.push({ owner: context.settings, key: 'prompts', next: context.prompts.filter(item => item !== prompt) });
            await this.write(changes);
            if (this.started && this.context()?.settings === context.settings && this.context()?.orders === context.orders) {
                const save = this.document.getElementById(`${this.manager.configuration.prefix}prompt_manager_popup_entry_form_save`);
                if (save?.dataset.pmPrompt === id && this.context()?.holder === context.holder) {
                    this.manager.hidePopup();
                    this.manager.clearEditForm();
                }
                this.manager.render(false);
            }
        } catch (error) {
            console.error('[Cloud Lounge Accelerator] 删除预设条目保存失败', error);
            globalThis.toastr?.error?.('条目保存失败，请检查当前列表后重试', '云酒馆加速器');
        } finally { this.busy = false; if (this.started) this.decorate(); }
    }

    stop() {
        ++this.generation;
        this.started = false;
        this.closeMenu();
        this.document?.removeEventListener('click', this.onClick, true);
        this.document?.removeEventListener('keydown', this.onKey, true);
        this.document?.removeEventListener('scroll', this.closeMenu, true);
        this.document?.defaultView?.removeEventListener('resize', this.closeMenu);
        if (this.manager && this.wrappedRender && this.manager.renderPromptManagerListItems === this.wrappedRender) this.manager.renderPromptManagerListItems = this.originalRender;
        // Do not let a canceled plugin draft fall through to native creation.
        const save = this.document?.getElementById(`${this.manager?.configuration?.prefix}prompt_manager_popup_entry_form_save`);
        if (this.pending && save?.dataset.pmPrompt === this.pending.prompt.identifier) {
            this.manager.hidePopup();
            this.manager.clearEditForm();
        }
        this.pending = null;
        for (const node of this.nodes) node.remove();
        this.nodes.clear();
    }
}
