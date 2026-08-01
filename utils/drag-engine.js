const INTERACTIVE_SELECTOR = 'input, textarea, select, option, button, a, [contenteditable="true"]';

export function calculateInsertionIndex(rects, pointerY, draggedIndex = -1) {
    const entries = (Array.isArray(rects) ? rects : [])
        .map((rect, index) => ({ rect, index }))
        .filter(item => item.index !== draggedIndex);
    const match = entries.find(item => pointerY < item.rect.top + item.rect.height / 2);
    return match ? match.index : rects.length;
}

export class PointerDragEngine {
    constructor({ list, itemSelector, handleSelector = null, onCommit, label = '列表条目' }) {
        this.list = list;
        this.itemSelector = itemSelector;
        this.handleSelector = handleSelector;
        this.onCommit = onCommit;
        this.label = label;
        this.drag = null;
        this.frame = null;
        this.onPointerDown = this.onPointerDown.bind(this);
        list.addEventListener('pointerdown', this.onPointerDown, true);
        list.dataset.claDragOptimized = '1';
    }

    get items() {
        return [...this.list.children].filter(element => element.matches?.(this.itemSelector));
    }

    onPointerDown(event) {
        if (event.button !== 0 || !event.isPrimary || this.drag) return;
        const target = event.target instanceof Element ? event.target : null;
        const item = target?.closest(this.itemSelector);
        if (!item || item.parentElement !== this.list) return;
        if (this.handleSelector && !target.closest(this.handleSelector)) return;
        if (!this.handleSelector && target.closest(INTERACTIVE_SELECTOR)) return;

        const rect = item.getBoundingClientRect();
        const ghost = item.cloneNode(true);
        ghost.className = `${ghost.className || ''} cla-drag-ghost`;
        ghost.setAttribute('aria-hidden', 'true');
        Object.assign(ghost.style, {
            position: 'fixed',
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${Math.min(rect.height, 160)}px`,
            margin: '0',
            pointerEvents: 'none',
            zIndex: '2147483646',
        });
        const indicator = document.createElement('div');
        indicator.className = 'cla-drop-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        document.body.append(ghost, indicator);
        item.classList.add('cla-drag-source');

        this.drag = {
            pointerId: event.pointerId,
            item,
            ghost,
            indicator,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            x: event.clientX,
            y: event.clientY,
            originalIndex: this.items.indexOf(item),
            originalNextSibling: item.nextSibling,
            targetIndex: this.items.indexOf(item),
        };
        item.setPointerCapture?.(event.pointerId);
        this.onPointerMove = this.onPointerMove.bind(this);
        this.onPointerUp = this.onPointerUp.bind(this);
        this.onPointerCancel = this.onPointerCancel.bind(this);
        document.addEventListener('pointermove', this.onPointerMove, true);
        document.addEventListener('pointerup', this.onPointerUp, true);
        document.addEventListener('pointercancel', this.onPointerCancel, true);
        event.preventDefault();
        event.stopImmediatePropagation();
        this.queuePaint();
    }

    onPointerMove(event) {
        if (!this.drag || event.pointerId !== this.drag.pointerId) return;
        this.drag.x = event.clientX;
        this.drag.y = event.clientY;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.queuePaint();
    }

    queuePaint() {
        if (this.frame !== null) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = null;
            if (!this.drag) return;
            const { ghost, indicator, x, y, offsetX, offsetY, originalIndex } = this.drag;
            ghost.style.transform = `translate3d(${x - offsetX - Number.parseFloat(ghost.style.left)}px, ${y - offsetY - Number.parseFloat(ghost.style.top)}px, 0)`;
            const items = this.items;
            const rects = items.map(item => item.getBoundingClientRect());
            const targetIndex = calculateInsertionIndex(rects, y, originalIndex);
            this.drag.targetIndex = targetIndex;
            const reference = items[targetIndex] || null;
            const listRect = this.list.getBoundingClientRect();
            const top = reference ? reference.getBoundingClientRect().top : listRect.bottom;
            Object.assign(indicator.style, {
                position: 'fixed',
                left: `${listRect.left}px`,
                top: `${top - 1}px`,
                width: `${listRect.width}px`,
            });
        });
    }

    async onPointerUp(event) {
        if (!this.drag || event.pointerId !== this.drag.pointerId) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const state = this.drag;
        const items = this.items;
        const withoutDragged = items.filter(item => item !== state.item);
        const normalizedIndex = Math.min(withoutDragged.length, Math.max(0,
            state.targetIndex > state.originalIndex ? state.targetIndex - 1 : state.targetIndex,
        ));
        const reference = withoutDragged[normalizedIndex] || null;
        this.finish();
        if (normalizedIndex === state.originalIndex) return;
        this.list.insertBefore(state.item, reference);
        try {
            await this.onCommit?.({
                list: this.list,
                item: state.item,
                fromIndex: state.originalIndex,
                toIndex: normalizedIndex,
            });
        } catch (error) {
            const originalReference = state.originalNextSibling?.parentElement === this.list
                ? state.originalNextSibling
                : null;
            this.list.insertBefore(state.item, originalReference);
            console.error(`[Cloud Lounge Accelerator] ${this.label}顺序保存失败`, error);
            globalThis.toastr?.error?.(`${this.label}顺序保存失败，已恢复原顺序`, '云酒馆加速器');
        }
    }

    onPointerCancel(event) {
        if (this.drag && event.pointerId === this.drag.pointerId) this.finish();
    }

    finish() {
        if (!this.drag) return;
        if (this.frame !== null) cancelAnimationFrame(this.frame);
        this.frame = null;
        this.drag.item.classList.remove('cla-drag-source');
        this.drag.ghost.remove();
        this.drag.indicator.remove();
        document.removeEventListener('pointermove', this.onPointerMove, true);
        document.removeEventListener('pointerup', this.onPointerUp, true);
        document.removeEventListener('pointercancel', this.onPointerCancel, true);
        this.drag = null;
    }

    destroy() {
        this.finish();
        this.list.removeEventListener('pointerdown', this.onPointerDown, true);
        delete this.list.dataset.claDragOptimized;
    }
}
