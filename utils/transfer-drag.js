// Only drag handles take pointer capture. The lists keep their normal touch scroll.
export class TransferDrag {
    constructor({ root, getZones, valid, getIds, onDrop }) {
        Object.assign(this, { root, getZones, valid, getIds, onDrop });
        this.onDown = this.onDown.bind(this);
        this.onMove = this.onMove.bind(this);
        this.onUp = this.onUp.bind(this);
        this.onCancel = this.onCancel.bind(this);
        this.onBlur = () => this.cancel();
        this.onKey = event => {
            if (event.key === 'Escape' && this.drag) {
                event.preventDefault();
                event.stopImmediatePropagation();
                this.cancel();
            }
        };
        this.onClick = event => {
            if (event.target.closest?.('[data-cla-transfer-drag]')) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        };
        root.addEventListener('pointerdown', this.onDown);
        root.addEventListener('click', this.onClick, true);
    }

    onDown(event) {
        const handle = event.target.closest?.('[data-cla-transfer-drag]');
        if (!handle || handle.disabled || this.drag || event.button !== 0 || !event.isPrimary || !this.valid()) return;
        const side = handle.dataset.claTransferSide;
        const ids = this.getIds(handle.dataset.claTransferDrag, handle);
        const zones = this.getZones(side);
        if (!ids.length || !zones.length) return;
        event.preventDefault();
        event.stopPropagation();
        this.drag = { handle, ids, side, zones, pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false };
        handle.setPointerCapture?.(event.pointerId);
        globalThis.addEventListener?.('blur', this.onBlur);
        this.listen(document.addEventListener);
    }

    listen(method) {
        for (const [type, handler] of [
            ['pointermove', this.onMove], ['pointerup', this.onUp], ['pointercancel', this.onCancel],
            ['lostpointercapture', this.onCancel], ['keydown', this.onKey],
        ]) method.call(document, type, handler, true);
    }

    findDrop(x, y) {
        const hit = document.elementFromPoint(x, y);
        const list = hit?.closest('.cla-transfer-list');
        const zone = this.drag.zones.find(zone => zone.list === list);
        if (!zone) return null;
        if (!zone.rows) return { zone, row: null, position: null };
        const row = hit.closest('[data-cla-transfer-order-anchor]');
        if (row && row.parentElement === list) {
            const rect = row.getBoundingClientRect();
            const before = y < rect.top + rect.height / 2;
            return { zone, row, position: { anchorId: row.dataset.claTransferId, before } };
        }
        // Between rows, find the next visible anchor without measuring the entire list.
        let left = 0;
        let right = zone.rows.length;
        while (left < right) {
            const middle = Math.floor((left + right) / 2);
            const rect = zone.rows[middle].getBoundingClientRect();
            if (y < rect.top + rect.height / 2) right = middle;
            else left = middle + 1;
        }
        const anchor = zone.rows[left] ?? zone.rows.at(-1);
        if (!anchor) return { zone, row: null, position: { edge: 'end' } };
        return { zone, row: anchor, position: { anchorId: anchor.dataset.claTransferId, before: left < zone.rows.length } };
    }

    markDrop(drop) {
        const previous = this.drop;
        if (previous?.zone === drop?.zone && previous?.row === drop?.row
            && previous?.position?.before === drop?.position?.before) return;
        previous?.zone.list.classList.remove('cla-transfer-drop-active');
        previous?.row?.classList.remove('cla-transfer-insert-before', 'cla-transfer-insert-after');
        this.drop = drop;
        drop?.zone.list.classList.add('cla-transfer-drop-active');
        if (drop?.row) drop.row.classList.add(drop.position.before ? 'cla-transfer-insert-before' : 'cla-transfer-insert-after');
    }

    onMove(event) {
        const drag = this.drag;
        if (!drag || event.pointerId !== drag.pointer) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!this.valid() || !drag.handle.isConnected) { this.cancel(); return; }
        if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
        if (!drag.active) {
            drag.active = true;
            this.ghost = document.createElement('div');
            this.ghost.className = 'cla-transfer-drag-ghost';
            this.ghost.setAttribute('aria-hidden', 'true');
            this.root.append(this.ghost);
            this.root.classList.add('cla-transfer-dragging');
        }
        drag.point = { x: event.clientX, y: event.clientY };
        this.queuePaint();
    }

    queuePaint() {
        if (this.frame !== undefined) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = undefined;
            this.paintDrag();
        });
    }

    paintDrag() {
        const drag = this.drag;
        if (!drag || !this.valid() || !drag.handle.isConnected) { this.cancel(); return; }
        const { x, y } = drag.point;
        let drop = this.findDrop(x, y);
        if (drop) {
            const list = drop.zone.list;
            const rect = list.getBoundingClientRect();
            const before = list.scrollTop;
            if (y < rect.top + 30) list.scrollTop -= 18;
            else if (y > rect.bottom - 30) list.scrollTop += 18;
            if (before !== list.scrollTop) {
                drop = this.findDrop(x, y);
                this.queuePaint();
            }
        }
        this.markDrop(drop);
        const action = drop?.zone.side === drag.side ? ' · 调整顺序'
            : drop?.zone.side === 'source' ? ' · 插入左侧' : drop ? ' · 插入右侧' : '';
        const text = `${drag.ids.length} 项${action}`;
        if (this.ghost.textContent !== text) this.ghost.textContent = text;
        const origin = this.root.getBoundingClientRect();
        this.ghost.style.left = `${Math.max(0, Math.min(x - origin.left + 10, this.root.clientWidth - this.ghost.offsetWidth))}px`;
        this.ghost.style.top = `${Math.max(0, Math.min(y - origin.top + 10, this.root.clientHeight - this.ghost.offsetHeight))}px`;
    }

    onUp(event) {
        const drag = this.drag;
        if (!drag || event.pointerId !== drag.pointer) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const drop = drag.active && this.valid() && drag.handle.isConnected && this.findDrop(event.clientX, event.clientY);
        this.cancel();
        if (drop) this.onDrop({ ids: drag.ids, side: drag.side, targetSide: drop.zone.side, position: drop.position });
    }

    onCancel(event) {
        if (this.drag && event.pointerId === this.drag.pointer) this.cancel();
    }

    cancel() {
        const drag = this.drag;
        if (!drag) return;
        this.drag = null;
        if (this.frame !== undefined) cancelAnimationFrame(this.frame);
        this.frame = undefined;
        this.ghost?.remove();
        this.ghost = null;
        this.markDrop(null);
        this.root.classList.remove('cla-transfer-dragging');
        globalThis.removeEventListener?.('blur', this.onBlur);
        this.listen(document.removeEventListener);
        if (drag.handle.hasPointerCapture?.(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
    }

    destroy() {
        this.cancel();
        this.root.removeEventListener('pointerdown', this.onDown);
        this.root.removeEventListener('click', this.onClick, true);
    }
}
