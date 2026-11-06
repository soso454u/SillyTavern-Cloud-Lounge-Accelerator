// Cross-pane dragging uses pointer events for mouse, pen and touch. Only the
// dedicated handle takes capture; normal list gestures retain vertical scroll.
export class TransferDrag {
    constructor({ root, dropzone, valid, getIds, onDrop }) {
        Object.assign(this, { root, dropzone, valid, getIds, onDrop });
        this.onDown = this.onDown.bind(this); this.onMove = this.onMove.bind(this);
        this.onUp = this.onUp.bind(this); this.onCancel = this.onCancel.bind(this);
        this.onBlur = () => this.cancel();
        this.onKey = event => {
            if (event.key === 'Escape' && this.drag) {
                event.preventDefault(); event.stopImmediatePropagation(); this.cancel();
            }
        };
        this.onClick = event => {
            if (event.target.closest?.('[data-cla-transfer-drag]')) { event.preventDefault(); event.stopImmediatePropagation(); }
        };
        root.addEventListener('pointerdown', this.onDown);
        root.addEventListener('click', this.onClick, true);
    }

    onDown(event) {
        const handle = event.target.closest?.('[data-cla-transfer-drag]');
        if (!handle || handle.disabled || this.drag || event.button !== 0 || !event.isPrimary || !this.valid()) return;
        const ids = this.getIds(handle.dataset.claTransferDrag, handle);
        if (!ids.length) return;
        event.preventDefault(); event.stopPropagation();
        this.drag = { handle, ids, pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false };
        handle.setPointerCapture?.(event.pointerId);
        globalThis.addEventListener?.('blur', this.onBlur);
        for (const [type, fn] of [['pointermove', this.onMove], ['pointerup', this.onUp], ['pointercancel', this.onCancel], ['lostpointercapture', this.onCancel], ['keydown', this.onKey]]) document.addEventListener(type, fn, true);
    }

    inside(x, y) {
        const rect = this.dropzone.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    onMove(event) {
        const drag = this.drag;
        if (!drag || event.pointerId !== drag.pointer) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (!this.valid() || !drag.handle.isConnected) { this.cancel(); return; }
        if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
        if (!drag.active) {
            drag.active = true;
            this.ghost = document.createElement('div'); this.ghost.className = 'cla-transfer-drag-ghost';
            this.ghost.textContent = `${drag.ids.length} 项 → 右侧目标`; this.ghost.setAttribute('aria-hidden', 'true');
            this.root.append(this.ghost); this.root.classList.add('cla-transfer-dragging');
        }
        const origin = this.root.getBoundingClientRect();
        this.ghost.style.left = `${Math.max(0, Math.min(event.clientX - origin.left + 10, this.root.clientWidth - this.ghost.offsetWidth))}px`;
        this.ghost.style.top = `${Math.max(0, Math.min(event.clientY - origin.top + 10, this.root.clientHeight - this.ghost.offsetHeight))}px`;
        const inside = this.inside(event.clientX, event.clientY);
        this.dropzone.classList.toggle('cla-transfer-drop-active', inside);
        this.dropzone.setAttribute('data-cla-drag-count', String(drag.ids.length));
        const list = event.clientX < this.dropzone.getBoundingClientRect().left
            ? this.root.querySelector('.cla-transfer-source-list') : this.root.querySelector('.cla-transfer-target-list');
        if (list) {
            const rect = list.getBoundingClientRect();
            if (event.clientY < rect.top + 30) list.scrollTop -= 18;
            if (event.clientY > rect.bottom - 30) list.scrollTop += 18;
        }
    }

    onUp(event) {
        const drag = this.drag;
        if (!drag || event.pointerId !== drag.pointer) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const accepted = drag.active && this.valid() && this.inside(event.clientX, event.clientY);
        this.cancel();
        if (accepted) this.onDrop(drag.ids);
    }
    onCancel(event) { if (this.drag && event.pointerId === this.drag.pointer) this.cancel(); }
    cancel() {
        const drag = this.drag; this.drag = null;
        this.ghost?.remove(); this.ghost = null;
        this.root.classList.remove('cla-transfer-dragging');
        this.dropzone.classList.remove('cla-transfer-drop-active');
        this.dropzone.removeAttribute('data-cla-drag-count');
        globalThis.removeEventListener?.('blur', this.onBlur);
        for (const [type, fn] of [['pointermove', this.onMove], ['pointerup', this.onUp], ['pointercancel', this.onCancel], ['lostpointercapture', this.onCancel], ['keydown', this.onKey]]) document.removeEventListener(type, fn, true);
        if (drag?.handle.hasPointerCapture?.(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
    }
    destroy() {
        this.cancel(); this.root.removeEventListener('pointerdown', this.onDown);
        this.root.removeEventListener('click', this.onClick, true);
    }
}
