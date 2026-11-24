// Grouped rows stay in place until drop. Hit-test only the row/header under the
// pointer, rather than asking native sortable to measure/reflow every hidden row.
export class PresetGroupedDrag {
    constructor(groups, list) {
        this.groups = groups; this.list = list;
        this.doc = groups.host.document; this.win = this.doc.defaultView;
        this.down = this.down.bind(this); this.move = this.move.bind(this); this.up = this.up.bind(this);
        this.cancel = event => { if (event.type !== 'pointercancel' || event.pointerId === this.state?.pointer) this.finish(); };
        this.contextMenu = event => { if (this.state) event.preventDefault(); };
        this.key = event => { if (event.key === 'Escape') { event.preventDefault(); this.finish(); } };
        this.block = event => {
            if (this.state?.active || this.handle(event.target)) {
                if (event.cancelable) event.preventDefault();
                event.stopImmediatePropagation();
            }
        };
        this.click = event => {
            if (Date.now() < (this.suppressUntil || 0)) {
                event.preventDefault(); event.stopImmediatePropagation();
            }
        };
        list.addEventListener('pointerdown', this.down, true);
        list.addEventListener('click', this.click, true);
        list.addEventListener('contextmenu', this.contextMenu);
        for (const type of ['mousedown', 'touchstart']) list.addEventListener(type, this.block, { capture: true, passive: false });
    }
    handle(target) {
        if (this.groups.rawOrder) return null;
        const handle = target?.closest?.('.drag-handle');
        const row = handle?.closest('[data-pm-identifier][class*="prompt_manager_prompt_draggable"]');
        return row?.parentElement === this.list ? row : null;
    }
    down(event) {
        this.suppressUntil = 0;
        if (event.button > 0 || event.isPrimary === false || this.groups.rawOrder) return;
        const row = this.handle(event.target);
        const header = event.target?.closest?.('.cla-preset-fold-header');
        if (!row && (!header || event.target.closest('.cla-preset-fold-icon'))) return;
        if (this.groups.host.busy || this.groups.query || this.groups.filter !== 'all') return;
        const folder = header && this.groups.folderNodes.get(header.dataset.claPresetGroup);
        const selection = this.groups.host.selection;
        const ids = row ? (selection?.mode && selection.selected.has(row.dataset.pmIdentifier)
            ? new Set(selection.selected) : new Set([row.dataset.pmIdentifier])) : new Set(folder?.ids);
        const context = this.groups.context();
        if (!ids.size || !this.groups.valid(context)) return;
        const options = row ? this.groups.sortable(this.list)?.options : null;
        this.finish();
        this.state = { ids, context, source: row || folder.element, folder: !row, x: event.clientX, y: event.clientY,
            startX: event.clientX, startY: event.clientY, pointer: event.pointerId, ready: false, active: false,
            distance: row ? Math.max(10, Number(options?.distance) || 0) : 10 };
        for (const [type, fn] of [['pointermove', this.move], ['pointerup', this.up], ['pointercancel', this.cancel], ['touchmove', this.block]]) {
            this.doc.addEventListener(type, fn, { capture: true, passive: false });
        }
        this.win.addEventListener('blur', this.cancel);
        this.doc.addEventListener('keydown', this.key, true);
        // Let a folder swipe scroll until the hold activates. Row handles already
        // opt out of touch scrolling; suppress compatibility mouse sorting too.
        if (row) { event.preventDefault(); event.stopImmediatePropagation(); }
        this.timer = this.win.setTimeout(() => {
            if (!this.state) return;
            this.state.ready = true;
            if (this.state.folder || this.moved()) this.activate();
        }, row ? Math.max(150, Number(options?.delay) || 0) : 400);
    }
    moved() { return Math.hypot(this.state.x - this.state.startX, this.state.y - this.state.startY) >= this.state.distance; }
    activate() {
        const state = this.state;
        if (!state?.source.isConnected || !this.groups.valid(state.context)) { this.finish(); return; }
        state.active = true;
        state.source.classList.add('cla-preset-folder-dragging');
        this.list.classList.add('cla-preset-drag-active');
        const line = this.doc.createElement('div'); line.className = 'cla-preset-drop-line'; line.hidden = true;
        line.setAttribute('aria-hidden', 'true'); this.doc.body.append(line); state.line = line;
        for (let node = this.list; node; node = node.parentElement) {
            if (node.scrollHeight > node.clientHeight && /auto|scroll|overlay/.test(this.win.getComputedStyle(node).overflowY)) { state.scroller = node; break; }
        }
        state.scroller ||= this.doc.scrollingElement;
        this.queue();
    }
    move(event) {
        const state = this.state;
        if (!state || state.pointer !== event.pointerId) return;
        state.x = event.clientX; state.y = event.clientY;
        if (!state.active) {
            if (!this.moved()) return;
            if (state.folder) { this.finish(); return; }
            if (state.ready) this.activate();
        }
        if (this.state?.active) { event.preventDefault(); event.stopImmediatePropagation(); this.queue(); }
    }
    targetAt(x, y) {
        const state = this.state;
        const node = this.doc.elementFromPoint(x, y)?.closest?.('[data-pm-identifier], .cla-preset-folder');
        if (!node || node.parentElement !== this.list || node === state.source) return null;
        const rect = node.getBoundingClientRect(), above = y < rect.top + rect.height / 2;
        let id = node.dataset.pmIdentifier, before = above;
        if (!id) {
            const folder = this.groups.folderNodes.get(node.dataset.claPresetGroup);
            if (!folder) return null;
            before = above || !folder.folded;
            id = before ? folder.ids[0] : folder.ids.at(-1);
        }
        if (!id || state.ids.has(id)) return null;
        return { rect, above: before, target: before ? { before: id } : { after: id } };
    }
    queue() {
        if (this.frame != null) return;
        this.frame = this.win.requestAnimationFrame(time => { this.frame = null; this.paint(time); });
    }
    paint(time) {
        const state = this.state;
        if (!state?.active) return;
        if (!state.source.isConnected || this.groups.list !== this.list) { this.finish(); return; }
        const hit = state.hit = this.targetAt(state.x, state.y);
        const scroller = state.scroller;
        const sr = scroller === this.doc.scrollingElement ? { top: 0, bottom: this.win.innerHeight, left: 0, right: this.win.innerWidth } : scroller?.getBoundingClientRect();
        const direction = sr && state.x >= sr.left && state.x <= sr.right && state.y >= sr.top && state.y <= sr.bottom
            ? (state.y < sr.top + 40 ? -1 : state.y > sr.bottom - 40 ? 1 : 0) : 0;
        // Read geometry first; only then write the indicator and scroll position.
        state.line.hidden = !hit;
        if (hit) Object.assign(state.line.style, { left: `${hit.rect.left}px`, width: `${hit.rect.width}px`,
            transform: `translateY(${(hit.above ? hit.rect.top : hit.rect.bottom) - 2}px)` });
        const previous = scroller?.scrollTop;
        if (direction) scroller.scrollTop += direction * 600 * Math.min(32, state.lastTime == null ? 16 : time - state.lastTime) / 1000;
        state.lastTime = time;
        if (direction && scroller.scrollTop !== previous) this.queue();
    }
    up(event) {
        const state = this.state;
        if (!state || state.pointer !== event.pointerId) return;
        // A release can precede the queued paint; use the final pointer position.
        const hit = state.active && this.groups.valid(state.context) ? this.targetAt(event.clientX, event.clientY) : null;
        this.finish();
        if (!state.active) return;
        event.preventDefault(); event.stopImmediatePropagation(); this.suppressUntil = Date.now() + 500;
        if (hit) this.groups.run(async () => {
            if (await this.groups.moveEntries(state.ids, hit.target)) this.groups.host.selection?.exit();
        });
    }
    finish() {
        this.win.clearTimeout(this.timer); this.timer = null;
        if (this.frame != null) this.win.cancelAnimationFrame(this.frame);
        this.frame = null;
        this.state?.line?.remove(); this.state?.source.classList.remove('cla-preset-folder-dragging');
        this.list.classList.remove('cla-preset-drag-active'); this.state = null;
        for (const [type, fn] of [['pointermove', this.move], ['pointerup', this.up], ['pointercancel', this.cancel], ['touchmove', this.block]]) this.doc.removeEventListener(type, fn, true);
        this.win.removeEventListener('blur', this.cancel);
        this.doc.removeEventListener('keydown', this.key, true);
    }
    destroy() {
        this.finish();
        this.list.removeEventListener('pointerdown', this.down, true); this.list.removeEventListener('click', this.click, true);
        this.list.removeEventListener('contextmenu', this.contextMenu);
        for (const type of ['mousedown', 'touchstart']) this.list.removeEventListener(type, this.block, true);
    }
}
