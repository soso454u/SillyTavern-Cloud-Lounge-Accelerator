// Mouse: drag across names. Touch/pen: hold still before sweeping, leaving
// ordinary touch scrolling native until the hold is armed.
export class PressSweepSelection {
    constructor({ root, nameSelector, rowSelector, getRows, isSelected, setSelected, valid = () => true,
        context = () => null, onStart = () => {}, onChange = () => {}, holdMs = 420 }) {
        Object.assign(this, { root, nameSelector, rowSelector, getRows, isSelected, setSelected, valid, context, onStart, onChange, holdMs });
        this.down = this.down.bind(this); this.move = this.move.bind(this); this.end = this.end.bind(this);
        this.touchMove = event => { if (this.gesture?.active && event.cancelable) event.preventDefault(); };
        this.click = event => {
            const name = event.target.closest?.(this.nameSelector);
            if (!name) return;
            if (performance.now() < (this.suppressUntil || 0)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
            const row = name.closest(this.rowSelector);
            if (!row || !this.valid(row)) return;
            event.preventDefault(); event.stopImmediatePropagation();
            this.onStart(row); this.setSelected(row, !this.isSelected(row), event.shiftKey); this.onChange();
        };
        this.contextMenu = event => { if (event.target.closest?.(this.nameSelector)) event.preventDefault(); };
        this.blur = () => this.cancel();
        this.lost = event => { if (this.gesture?.pointer === event.pointerId) this.cancel(); };
        this.key = event => { if (event.key === 'Escape' && this.gesture) { event.preventDefault(); event.stopImmediatePropagation(); this.cancel(); } };
        root.addEventListener('pointerdown', this.down, true); root.addEventListener('click', this.click, true);
        root.addEventListener('contextmenu', this.contextMenu, true);
        document.addEventListener('pointermove', this.move, { capture: true, passive: false });
        document.addEventListener('pointerup', this.end, true); document.addEventListener('pointercancel', this.end, true);
        document.addEventListener('lostpointercapture', this.lost, true);
        document.addEventListener('keydown', this.key, true); globalThis.addEventListener?.('blur', this.blur);
    }
    down(event) {
        if (event.button > 0 || event.isPrimary === false || this.gesture) return;
        const name = event.target.closest?.(this.nameSelector), row = name?.closest(this.rowSelector);
        if (!row || row.hidden || !this.valid(row)) return;
        const gesture = this.gesture = { pointer: event.pointerId, name, row, rows: this.getRows(row), context: this.context(row),
            startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false,
            selected: !this.isSelected(row), visited: new Map(), index: -1, mouse: event.pointerType === 'mouse' };
        if (gesture.mouse) event.preventDefault();
        else {
            // Keep blocking touch listeners out of normal chat/page scrolling.
            // Install only for a gesture that actually started on a name.
            document.addEventListener('touchmove', this.touchMove, { capture: true, passive: false });
            this.timer = setTimeout(() => this.arm(gesture), this.holdMs);
        }
    }
    arm(gesture) {
        clearTimeout(this.timer); this.timer = null;
        if (this.gesture !== gesture || !this.current(gesture)) { this.cancel(false); return; }
        gesture.active = true; gesture.index = gesture.rows.indexOf(gesture.row);
        this.onStart(gesture.row); this.paint(gesture.row);
        gesture.name.setPointerCapture?.(gesture.pointer);
        for (let parent = gesture.row.parentElement; parent; parent = parent.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) { gesture.scroller = parent; break; }
        }
        gesture.scroller ||= document.scrollingElement;
        this.root.classList?.add('cla-sweep-selecting');
    }
    current(gesture) {
        return gesture.name.isConnected && this.valid(gesture.row) && this.context(gesture.row) === gesture.context;
    }
    paint(row) {
        const gesture = this.gesture;
        const index = gesture.rows.indexOf(row);
        if (index < 0 || row.hidden) return;
        let changed = false;
        for (const item of gesture.rows.slice(Math.min(gesture.index < 0 ? index : gesture.index, index), Math.max(gesture.index, index) + 1)) {
            if (item.hidden || gesture.visited.has(item)) continue;
            gesture.visited.set(item, this.isSelected(item)); this.setSelected(item, gesture.selected, false);
            changed = true;
        }
        gesture.index = index; if (changed) this.onChange();
    }
    move(event) {
        const gesture = this.gesture;
        if (!gesture || event.pointerId !== gesture.pointer) return;
        if (!this.current(gesture)) { this.cancel(false); return; }
        gesture.x = event.clientX; gesture.y = event.clientY;
        if (!gesture.active) {
            if (Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) < 8) return;
            if (!gesture.mouse) { this.cancel(false); this.suppressUntil = performance.now() + 400; return; }
            this.arm(gesture);
        }
        if (!this.gesture?.active) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const row = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(this.rowSelector);
        if (row) this.paint(row);
        this.queueScroll();
    }
    queueScroll() {
        if (this.frame != null) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = null;
            const gesture = this.gesture;
            if (!gesture?.active || !this.current(gesture)) return;
            const scroller = gesture.scroller;
            if (!scroller) return;
            const bounds = scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
            const speed = gesture.y < bounds.top + 28 ? -10 : gesture.y > bounds.bottom - 28 ? 10 : 0;
            if (!speed) return;
            const previous = scroller.scrollTop; scroller.scrollTop += speed;
            if (previous === scroller.scrollTop) return;
            const row = document.elementFromPoint(gesture.x, gesture.y)?.closest?.(this.rowSelector);
            if (row) this.paint(row);
            this.queueScroll();
        });
    }
    end(event) {
        const gesture = this.gesture;
        if (!gesture || event.pointerId !== gesture.pointer) return;
        if (gesture.active) {
            event.preventDefault(); event.stopImmediatePropagation();
            this.cancel(event.type === 'pointercancel');
        } else this.cancel(false);
    }
    cancel(restore = true) {
        document.removeEventListener('touchmove', this.touchMove, true);
        if (this.frame != null) cancelAnimationFrame(this.frame);
        this.frame = null;
        clearTimeout(this.timer); this.timer = null;
        const gesture = this.gesture; this.gesture = null;
        if (gesture?.active) {
            if (restore) for (const [row, selected] of gesture.visited) if (row.isConnected) this.setSelected(row, selected, false);
            this.onChange(); this.suppressUntil = performance.now() + 350;
        }
        this.root.classList?.remove('cla-sweep-selecting');
        if (gesture?.name.hasPointerCapture?.(gesture.pointer)) gesture.name.releasePointerCapture(gesture.pointer);
    }
    destroy() {
        this.cancel(); this.root.removeEventListener('pointerdown', this.down, true); this.root.removeEventListener('click', this.click, true);
        this.root.removeEventListener('contextmenu', this.contextMenu, true);
        document.removeEventListener('pointermove', this.move, true); document.removeEventListener('pointerup', this.end, true);
        document.removeEventListener('pointercancel', this.end, true); document.removeEventListener('lostpointercapture', this.lost, true);
        document.removeEventListener('touchmove', this.touchMove, true); document.removeEventListener('keydown', this.key, true);
        globalThis.removeEventListener?.('blur', this.blur);
    }
}
