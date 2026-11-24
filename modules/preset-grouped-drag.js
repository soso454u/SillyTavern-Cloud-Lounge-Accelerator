const ROW = '[data-pm-identifier][class*="prompt_manager_prompt_draggable"]';
const FOLDER = '.cla-preset-folder';
const COMPANION = 'cla-preset-drag-companion';
const MOVE_EVENTS = ['pointermove', 'mousemove', 'touchmove'];
const END_EVENTS = ['pointerup', 'mouseup', 'touchend', 'touchcancel', 'pointercancel'];

// Keep SillyTavern's jQuery UI helper, placeholder, touch handling and update
// callback. Only adapt which nodes are measured and which rows move as a block.
export class PresetGroupedDrag {
    constructor(groups, list) {
        this.groups = groups; this.list = list; this.doc = groups.host.document;
        this.jquery = globalThis.jQuery || globalThis.$;
        this.down = this.down.bind(this); this.cancel = this.cancel.bind(this);
        this.key = event => { if (event.key === 'Escape' && this.state) { event.preventDefault(); this.cancel(); } };
        this.click = event => {
            if (Date.now() < (this.suppressUntil || 0)) { event.preventDefault(); event.stopImmediatePropagation(); }
        };
        this.move = event => {
            const gesture = this.folderGesture, point = event.touches?.[0] || event;
            if (gesture && Math.hypot(point.clientX - gesture.x, point.clientY - gesture.y) >= 8) {
                gesture.moved = true; this.suppressUntil = Date.now() + 500;
            }
        };
        this.end = () => {
            if (this.folderGesture?.moved) this.suppressUntil = Date.now() + 500;
            this.folderGesture = null;
        };
        for (const type of ['pointerdown', 'mousedown', 'touchstart']) list.addEventListener(type, this.down, { capture: true, passive: true });
        for (const type of MOVE_EVENTS) this.doc.addEventListener(type, this.move, { capture: true, passive: true });
        for (const type of END_EVENTS) this.doc.addEventListener(type, this.end, { capture: true, passive: true });
        list.addEventListener('click', this.click, true);
        this.doc.addEventListener('pointercancel', this.cancel, true); this.doc.addEventListener('keydown', this.key, true);
        this.doc.defaultView.addEventListener('blur', this.cancel); this.reconcile();
    }
    nativeRows() {
        const original = this.original.items;
        return typeof original === 'function' ? original.call(this.list, null, { options: this.original }) : this.jquery(this.list).find(original);
    }
    reconcile() {
        const instance = this.groups.sortable(this.list);
        if (!instance?.options || instance.dragging) return;
        if (this.instance !== instance) {
            this.restore(); this.instance = instance; this.original = {}; this.applied = {}; this.pointerOptions = {};
        }
        for (const key of ['items', 'handle', 'delay', 'distance', 'cancel', 'axis', 'tolerance', 'placeholder', 'forcePlaceholderSize', 'revert', 'start', 'change', 'update', 'stop']) {
            if (!(key in this.original) || (instance.options[key] !== this.applied[key] && instance.options[key] !== this.pointerOptions[key])) this.original[key] = instance.options[key];
        }
        const controller = this;
        this.applied = {
            // toArray passes options: return every REAL row, including folded
            // rows. Synthetic folder headers must never enter prompt_order.
            items(event, ui) {
                if (ui?.options) return controller.nativeRows().not('.ui-sortable-placeholder, .ui-sortable-helper');
                return controller.jquery(controller.list.children).filter(`${ROW}, ${FOLDER}`)
                    .filter(function () { return !this.classList.contains(COMPANION) && this.getClientRects().length > 0; });
            },
            handle: '.drag-handle, .cla-preset-folder-drag-handle', delay: 0, distance: 4,
            cancel: this.original.cancel, axis: 'y', tolerance: 'pointer',
            placeholder: 'cla-preset-native-placeholder', forcePlaceholderSize: true, revert: false,
            start(event, ui) { controller.start(event, ui); return controller.original.start?.call(this, event, ui); },
            change(event, ui) { controller.change(ui); return controller.original.change?.call(this, event, ui); },
            update(event, ui) { return controller.update(this, event, ui); },
            stop(event, ui) { controller.stop(); return controller.original.stop?.call(this, event, ui); },
        };
        instance.option(this.applied);
    }
    down(event) {
        if (this.state?.active || event.button > 0 || event.isPrimary === false) return;
        if (event.target?.closest?.('.drag-handle, .cla-preset-folder-drag-handle')) this.groups.foldMotion?.finish();
        this.suppressUntil = 0; this.reconcile();
        const header = event.target?.closest?.('.cla-preset-fold-header');
        const point = event.touches?.[0] || event;
        this.folderGesture = header ? { x: point.clientX, y: point.clientY, moved: false } : null;
        const instance = this.instance;
        if (!instance?.options || this.groups.rawOrder) return;
        const row = event.target?.closest?.('.drag-handle')?.closest(ROW);
        const allowed = !this.groups.host.busy && !this.groups.query && this.groups.filter === 'all';
        const folder = header && event.target.closest('.cla-preset-folder-drag-handle') && this.groups.folderNodes.get(header.dataset.claPresetGroup);
        // Run after the global guard, before native mouse/Touch Punch handlers.
        this.pointerOptions = { handle: this.applied.handle, delay: folder ? 250 : 0, distance: 4,
            cancel: !allowed ? '*' : folder ? '.cla-preset-fold-icon' : this.original.cancel };
        instance.option(this.pointerOptions);
        if (!allowed || (!folder && row?.parentElement !== this.list)) return;
        const context = this.groups.context(); if (!this.groups.valid(context)) return;
        const selection = this.groups.host.selection;
        const ids = folder ? new Set(folder.ids) : selection?.mode && selection.selected.has(row.dataset.pmIdentifier)
            ? new Set(selection.selected) : new Set([row.dataset.pmIdentifier]);
        const source = folder ? folder.element : row;
        const block = [...this.list.children].filter(node => node === source || ids.has(node.dataset.pmIdentifier)
            || (folder && this.groups.folderNodes.get(node.dataset.claPresetGroup || node.dataset.claPresetEnd)?.ids.every(id => ids.has(id))));
        this.state = { source, ids, block, context, folder: !!folder, active: false };
    }
    start(event, ui) {
        const state = this.state;
        if (!state || !this.groups.valid(state.context)) { this.cancelling = true; return; }
        state.active = true; state.order = [...this.list.children]; state.source = ui.item[0];
        this.list.classList.add('cla-preset-drag-active');
        for (const node of state.block) if (node !== state.source) node.classList.add(COMPANION);
        this.instance.items = this.instance.items.filter(item => !item.item[0].classList.contains(COMPANION));
        this.instance.refreshPositions();
        if (state.ids.size > 1) {
            state.badge = this.doc.createElement('span'); state.badge.className = 'cla-preset-drag-count';
            state.badge.textContent = `${state.ids.size} 条一起移动`; ui.helper[0].append(state.badge);
        }
    }
    change(ui) {
        const previous = ui.placeholder[0]?.previousElementSibling;
        const folder = previous && this.groups.folderNodes.get(previous.dataset.claPresetGroup);
        if (!folder?.folded || this.state?.ids.has(folder.ids[0])) return;
        // Below a folded header means after its ENTIRE hidden range.
        const last = [...this.list.querySelectorAll(ROW)].find(row => row.dataset.pmIdentifier === folder.ids.at(-1));
        if (last) last.after(ui.placeholder[0]);
    }
    update(owner, event, ui) {
        const state = this.state;
        if (!state || this.cancelling || !this.groups.valid(state.context)) return;
        let next = ui.item[0].nextSibling;
        while (next && state.block.includes(next)) next = next.nextSibling;
        const fragment = this.doc.createDocumentFragment();
        for (const node of state.block) fragment.append(node);
        this.list.insertBefore(fragment, next); state.updated = true;
        // Native update schedules the debounced save. Observe failure without
        // making drop wait for the SETTINGS_UPDATED promise.
        const host = this.groups.host, manager = host.manager, save = manager.saveServiceSettings;
        let expected;
        const observeSave = (...args) => {
            const pending = save.apply(manager, args);
            Promise.resolve(pending).catch(error => {
                const now = host.context();
                if (now?.settings === state.context.settings && now.characterId === state.context.characterId && now.order === expected) {
                    now.holder.order = state.context.order;
                    for (const node of state.order) if (node.parentElement === this.list) this.list.append(node);
                    host.decorate();
                }
                this.groups.run(() => { throw error; });
            });
            return pending;
        };
        manager.saveServiceSettings = observeSave;
        try { return this.original.update?.call(owner, event, ui); }
        finally {
            expected = host.context()?.order;
            if (manager.saveServiceSettings === observeSave) manager.saveServiceSettings = save;
        }
    }
    stop() {
        const state = this.state; if (!state) return;
        this.suppressUntil = state.active ? Date.now() + 500 : 0;
        for (const node of state.block) node.classList.remove(COMPANION);
        state.badge?.remove(); this.list.classList.remove('cla-preset-drag-active'); this.state = null;
        if (!this.cancelling) this.groups.host.decorate();
    }
    cancel() {
        if (!this.state) return;
        this.cancelling = true;
        try { if (this.instance?.dragging) this.instance.cancel(); this.stop(); }
        finally { this.cancelling = false; }
    }
    finish() { this.cancel(); }
    restore() {
        if (!this.instance?.options || !this.original) return;
        const restore = {};
        for (const [key, value] of Object.entries(this.original)) if (this.instance.options[key] === this.applied[key]
            || this.instance.options[key] === this.pointerOptions[key]) restore[key] = value;
        this.instance.option(restore);
    }
    destroy() {
        this.cancel(); this.restore();
        this.folderGesture = null;
        for (const type of ['pointerdown', 'mousedown', 'touchstart']) this.list.removeEventListener(type, this.down, true);
        for (const type of MOVE_EVENTS) this.doc.removeEventListener(type, this.move, true);
        for (const type of END_EVENTS) this.doc.removeEventListener(type, this.end, true);
        this.list.removeEventListener('click', this.click, true);
        this.doc.removeEventListener('pointercancel', this.cancel, true); this.doc.removeEventListener('keydown', this.key, true);
        this.doc.defaultView.removeEventListener('blur', this.cancel);
    }
}
