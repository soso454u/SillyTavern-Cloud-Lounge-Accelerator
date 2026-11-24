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
        return name && this.host.manager?.listElement?.contains(row) && row.getClientRects().length > 0 ? name : null;
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
        const name = this.name(event.target);
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
            const rows = [...this.host.manager.listElement.querySelectorAll(ROW)].filter(row => row.getClientRects().length > 0)
                .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
            const first = rows.findIndex(row => row.dataset.pmIdentifier === this.anchor), last = rows.findIndex(row => row.dataset.pmIdentifier === id);
            if (first >= 0 && last >= 0) for (const row of rows.slice(Math.min(first, last), Math.max(first, last) + 1)) this.selected.add(row.dataset.pmIdentifier);
        } else if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
        if (!this.selected.size) { this.exit(); return; }
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
    }
    enter(context = this.host.context()) {
        if (!context) return false;
        if (!this.mode || !this.current()) this.selected.clear();
        this.mode = true; this.context = context; this.scopeKey = this.scope(); return true;
    }
    startGroup(context, id) {
        if (this.mode && this.selected.size) {
            if (id) this.selected.add(id);
            this.host.groups.run(() => this.host.groups.createGroup(new Set(this.selected)).then(done => { if (done) this.exit(); }));
            return;
        }
        if (!this.enter(context)) return;
        this.selected.add(id); this.anchor = id; this.render();
        globalThis.toastr?.info?.('再点选分组的最后一个条目，然后在它的「⋯」最下面点「用已选新建分组」', '新建分组');
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
