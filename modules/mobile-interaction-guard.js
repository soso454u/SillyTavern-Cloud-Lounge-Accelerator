const LOG_PREFIX = '[Cloud Lounge Accelerator]';

export function isTouchEnvironment({ navigatorRef = globalThis.navigator, matchMedia = globalThis.matchMedia } = {}) {
    if (Number(navigatorRef?.maxTouchPoints || 0) > 0) return true;
    try {
        return Boolean(matchMedia?.('(pointer: coarse)')?.matches);
    } catch {
        return false;
    }
}

export function getQuickReplyRecoveryReason({
    open = false,
    quickReplyExecuting = false,
    quickReplyMinimized = false,
    quickReplyHidden = false,
    backdropTap = false,
} = {}) {
    if (!open || !backdropTap) return null;
    if ((quickReplyExecuting && quickReplyMinimized) || quickReplyHidden) return 'quick-reply';
    return null;
}

export class MobileInteractionGuard {
    constructor({
        documentRef = globalThis.document,
        navigatorRef = globalThis.navigator,
        matchMedia = globalThis.matchMedia,
        onRecovered = null,
    } = {}) {
        this.document = documentRef;
        this.navigator = navigatorRef;
        this.matchMedia = matchMedia;
        this.onRecovered = onRecovered;
        this.started = false;

        this.onPointerEnd = this.onPointerEnd.bind(this);
    }

    start() {
        if (this.started) return true;
        if (!this.document?.body || !isTouchEnvironment({
            navigatorRef: this.navigator,
            matchMedia: this.matchMedia,
        })) return false;

        this.started = true;
        this.document.addEventListener('pointerup', this.onPointerEnd, true);
        this.document.addEventListener('pointercancel', this.onPointerEnd, true);
        return true;
    }

    onPointerEnd(event) {
        const target = event.target;
        if (
            Number.isFinite(event.pointerId)
            && target?.hasPointerCapture?.(event.pointerId)
        ) {
            try {
                target.releasePointerCapture(event.pointerId);
            } catch {
                // Safari may already have released it even when it reports capture.
            }
        }

        if (event.type !== 'pointerup' || event.pointerType === 'mouse') return;
        const dialog = target?.matches?.('dialog.popup[open]') ? target : null;
        if (!dialog) return;

        const quickReply = dialog.querySelector?.('#qr--modalEditor');
        const reason = getQuickReplyRecoveryReason({
            open: dialog.hasAttribute?.('open'),
            quickReplyExecuting: Boolean(quickReply?.classList?.contains('qr--isExecuting')),
            quickReplyMinimized: Boolean(quickReply?.classList?.contains('qr--minimized')),
            quickReplyHidden: Boolean(dialog.classList?.contains('qr--hide')),
            backdropTap: true,
        });
        if (!reason) return;

        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation?.();
        dialog.classList?.remove('qr--hide');
        quickReply.classList?.remove('qr--minimized');
        dialog.querySelector?.('#qr--modal-maximize')?.click?.();
        this.notifyRecovered(reason);
    }

    notifyRecovered(reason) {
        const message = '检测到后台快捷回复仍在运行，已展开控制窗口';
        console.info(LOG_PREFIX, message, reason);
        globalThis.toastr?.info?.(message, '云酒馆加速器', { timeOut: 2600 });
        this.onRecovered?.({ reason: '快捷回复窗口', blocker: 'dialog.popup', count: 1 });
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.document.removeEventListener('pointerup', this.onPointerEnd, true);
        this.document.removeEventListener('pointercancel', this.onPointerEnd, true);
    }
}
