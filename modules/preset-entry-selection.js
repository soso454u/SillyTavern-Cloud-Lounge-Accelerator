const NAME = '.completion_prompt_manager_prompt_name';
const ROW = '[data-pm-identifier]';

// A stationary hold enters selection; ordinary taps and scrolling remain native.
export class PresetEntrySelection {
    constructor({ host, holdMs = 500 }) {
        this.host = host; this.holdMs = holdMs; this.selected = new Set(); this.marked = new Set();
        this.down = this.down.bind(this); this.move = this.move.bind(this); this.end = this.end.bind(this); this.click = this.click.bind(this);
        this.key = event => { if (event.key === 'Escape' && (this.mode || this.gesture)) { event.preventDefault(); this.exit(); } };
        this.contextMenu = event => {
            const name = this.name(event.target);
            if (!name) return;
            event.preventDefault();
            if (this.suppressClick && Date.now() < (this.suppressUntil || 0)) return;
            if (this.gesture?.active || this.host.busy) return;
            const context = this.host.context(); if (!context) return;
            this.cancelHold(); this.mode = true; this.context = context; this.scopeKey = this.scope();
            this.selected.add(name.closest(ROW).dataset.pmIdentifier); this.render();
        };
        this.touchMove = event => { if (this.gesture?.active && event.cancelable) event.preventDefault(); };
        this.blur = () => this.cancelHold();
    }
    start() {
        if (this.started) return;
        this.started = true;
        const doc = this.host.document;
        for (const [type, listener] of [['pointerdown', this.down], ['click', this.click], ['keydown', this.key], ['contextmenu', this.contextMenu]]) doc.addEventListener(type, listener, true);
        doc.defaultView?.addEventListener('blur', this.blur);
    }
    name(target) {
        if (target?.closest?.('button, input, select, .prompt_manager_prompt_controls, .drag-handle')) return null;
        const row = target?.closest?.(ROW), name = row?.querySelector(NAME);
        return name && this.host.manager?.listElement?.contains(row) && !row.classList.contains('cla-preset-group-hidden') ? name : null;
    }
    scope() { return this.host.groups.context()?.key || this.host.context()?.prompts; }
    current(context = this.context) { return this.host.current(context) && this.scope() === this.scopeKey; }
    down(event) {
        // A new physical gesture is allowed immediately. Only the compatibility
        // click from the completed hold/scroll is suppressed, even if layout moved.
        this.suppressClick = false;
        if (event.button > 0 || event.isPrimary === false || this.host.busy) return;
        const name = this.name(event.target);
        if (!name) return;
        this.cancelHold();
        const context = this.host.context();
        if (!context) return;
        const doc = this.host.document;
        const gesture = this.gesture = { name, row: name.closest(ROW), pointer: event.pointerId, context, scope: this.scope(), x: event.clientX, y: event.clientY, active: false };
        this.timer = setTimeout(() => {
            if (this.gesture !== gesture || !gesture.name.isConnected || !this.host.current(context) || this.scope() !== gesture.scope) { this.cancelHold(); return; }
            if (this.mode && !this.current()) this.selected.clear();
            this.mode = true; this.context = context; this.scopeKey = gesture.scope;
            this.selected.add(gesture.row.dataset.pmIdentifier); this.anchor = gesture.row.dataset.pmIdentifier;
            gesture.active = true; this.suppressName = gesture.name; this.suppressClick = true; this.suppressUntil = Date.now() + 800;
            doc.getSelection?.()?.removeAllRanges();
            gesture.name.setPointerCapture?.(gesture.pointer);
            this.render();
        }, this.holdMs);
        doc.addEventListener('pointermove', this.move, { capture: true, passive: false });
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) doc.addEventListener(type, this.end, true);
        doc.addEventListener('touchmove', this.touchMove, { capture: true, passive: false });
    }
    move(event) {
        const gesture = this.gesture;
        if (!gesture || gesture.pointer !== event.pointerId) return;
        if (!this.host.current(gesture.context) || this.scope() !== gesture.scope) { this.cancelHold(); return; }
        if (gesture.active) { event.preventDefault(); return; }
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) { this.suppressName = gesture.name; this.suppressClick = true; this.suppressUntil = Date.now() + 400; this.cancelHold(); }
    }
    end(event) {
        if (event.pointerId !== this.gesture?.pointer) return;
        const active = this.gesture.active;
        if (active) { event.preventDefault(); this.suppressUntil = Date.now() + 450; }
        this.cancelHold();
    }
    cancelHold() {
        clearTimeout(this.timer); this.timer = null;
        const doc = this.host.document, gesture = this.gesture; this.gesture = null;
        doc.removeEventListener('pointermove', this.move, true);
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) doc.removeEventListener(type, this.end, true);
        doc.removeEventListener('touchmove', this.touchMove, true);
        if (gesture?.name.hasPointerCapture?.(gesture.pointer)) gesture.name.releasePointerCapture(gesture.pointer);
    }
    click(event) {
        if (this.suppressClick && Date.now() < (this.suppressUntil || 0)) {
            this.suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); return;
        }
        const row = event.target?.closest?.(ROW);
        const name = this.mode && row && this.host.manager?.listElement?.contains(row) ? row.querySelector(NAME) : this.name(event.target);
        if (!name) return;
        if (!this.mode) {
            if (!event.ctrlKey && !event.metaKey) return;
            const context = this.host.context(); if (!context) return;
            this.mode = true; this.context = context; this.scopeKey = this.scope();
        }
        if (!this.current()) { this.exit(); return; }
        event.preventDefault(); event.stopImmediatePropagation();
        if (this.host.busy) return;
        const id = name.closest(ROW).dataset.pmIdentifier;
        if (event.shiftKey && this.anchor) {
            const rows = [...this.host.manager.listElement.querySelectorAll(ROW)].filter(row => !row.classList.contains('cla-preset-group-hidden'))
                .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
            const first = rows.findIndex(row => row.dataset.pmIdentifier === this.anchor), last = rows.findIndex(row => row.dataset.pmIdentifier === id);
            if (first >= 0 && last >= 0) for (const row of rows.slice(Math.min(first, last), Math.max(first, last) + 1)) this.selected.add(row.dataset.pmIdentifier);
        } else if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
        this.anchor = id; this.render();
    }
    render() {
        const list = this.host.manager?.listElement;
        if (this.mode && (!this.current() || !list?.isConnected)) { this.exit(); return; }
        for (const row of this.marked) { row.classList.remove('cla-preset-entry-selected'); row.removeAttribute('aria-selected'); }
        this.marked.clear();
        this.toolbar?.remove(); this.toolbar = null;
        this.list?.classList.remove('cla-preset-selecting'); this.list = list;
        if (!this.mode || !list?.isConnected) return;
        const known = new Set(this.context.order.map(item => item.identifier));
        for (const id of this.selected) if (!known.has(id)) this.selected.delete(id);
        list.classList.add('cla-preset-selecting');
        for (const row of list.querySelectorAll(ROW)) if (this.selected.has(row.dataset.pmIdentifier)) {
            row.classList.add('cla-preset-entry-selected'); row.setAttribute('aria-selected', 'true'); this.marked.add(row);
        }
        const ui = this.host.groups, toolbar = this.toolbar = ui.node('div', '', 'cla-preset-bulk-toolbar');
        toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '预设条目批量编辑');
        toolbar.append(ui.node('small', `已选 ${this.selected.size} 项`));
        for (const [label, action] of [['批量移动', button => this.openGroups(button)], ['启用', () => void this.update('enable')],
            ['禁用', () => void this.update('disable')], ['取消', () => this.exit()]]) {
            let button; button = ui.button(label, () => action(button));
            button.disabled = label !== '取消' && (this.host.busy || this.selected.size === 0); toolbar.append(button);
        }
        list.before(toolbar);
    }
    openGroups(button) {
        if (!this.current() || this.host.busy || !this.selected.size) return;
        const context = this.host.groups.context();
        if (!context) return;
        this.host.closeMenu();
        const menu = this.host.groups.node('div', '', 'cla-preset-entry-menu'); menu.setAttribute('role', 'menu');
        this.host.groups.assignmentMenu(menu, context, [...this.selected], () => this.exit());
        this.host.showMenu(menu, button);
    }
    async update(action) {
        const context = this.context;
        if (!this.current(context) || this.host.busy || !this.selected.size) return;
        const manager = this.host.manager, selected = new Set(this.selected);
        const allowed = new Set(context.prompts.filter(prompt => selected.has(prompt.identifier) && (action === 'remove'
            ? !prompt.marker && prompt.system_prompt === false && manager.isPromptDeletionAllowed?.(prompt)
            : manager.isPromptToggleAllowed?.(prompt))).map(prompt => prompt.identifier));
        if (!allowed.size) { globalThis.toastr?.info?.('所选条目受酒馆保护，无法执行此操作', '预设批量编辑'); return; }
        if (action === 'remove' && this.host.isGenerating()) { globalThis.toastr?.info?.('请等待生成结束再移出条目', '预设批量编辑'); return; }
        this.host.busy = true; this.render();
        try {
            if (action === 'remove' && !await this.host.confirm(`将 ${allowed.size} 个条目移出当前列表？条目内容保留在可用条目中。`)) return;
            if (!this.current(context) || (action === 'remove' && this.host.isGenerating())) return;
            const order = action === 'remove' ? context.order.filter(item => !allowed.has(item.identifier))
                : context.order.map(item => allowed.has(item.identifier) ? { ...item, enabled: action === 'enable' } : item);
            if (order.length === context.order.length && order.every((item, index) => item === context.order[index] || item.enabled === context.order[index].enabled)) return;
            await this.host.write([{ owner: context.holder, key: 'order', next: order }]);
            this.exit();
            if (this.host.started && this.host.context()?.holder === context.holder && this.host.context()?.order === order) {
                const counts = manager.tokenHandler?.getCounts?.();
                if (counts) for (const id of allowed) counts[id] = null;
                if (action === 'remove') manager.render(false); else manager.render();
            }
            if (allowed.size < selected.size) globalThis.toastr?.info?.('已跳过受保护的条目', '预设批量编辑');
        } catch (error) {
            console.error('[Cloud Lounge Accelerator] 预设批量保存失败', error);
            globalThis.toastr?.error?.('保存失败，选择已保留，请重试', '预设批量编辑');
        } finally { this.host.busy = false; if (this.host.started) this.render(); }
    }
    exit() {
        this.cancelHold(); this.mode = false; this.context = null; this.selected.clear(); this.anchor = null;
        this.render();
    }
    stop() {
        this.started = false; this.exit();
        const doc = this.host.document;
        for (const [type, listener] of [['pointerdown', this.down], ['click', this.click], ['keydown', this.key], ['contextmenu', this.contextMenu]]) doc.removeEventListener(type, listener, true);
        doc.defaultView?.removeEventListener('blur', this.blur);
    }
}
