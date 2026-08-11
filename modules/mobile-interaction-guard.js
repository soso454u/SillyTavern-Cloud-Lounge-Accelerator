const LOG_PREFIX = '[Cloud Lounge Accelerator]';
const CLOSING_GRACE_MS = 900;
const ORPHAN_LOADER_GRACE_MS = 1200;

export function isTouchEnvironment({ navigatorRef = globalThis.navigator, matchMedia = globalThis.matchMedia } = {}) {
    if (Number(navigatorRef?.maxTouchPoints || 0) > 0) return true;
    try {
        return Boolean(matchMedia?.('(pointer: coarse)')?.matches);
    } catch {
        return false;
    }
}

export function getDialogRecoveryReason({
    open = false,
    closing = false,
    knownLoader = false,
    loaderPresent = false,
    activeBlockingLoader = false,
    quickReplyExecuting = false,
    quickReplyMinimized = false,
    quickReplyHidden = false,
    backdropTap = false,
} = {}) {
    if (!open) return null;
    if (closing) return 'closing';
    if (knownLoader && !loaderPresent && !activeBlockingLoader) return 'orphan-loader';
    if (
        backdropTap
        && (
            (quickReplyExecuting && quickReplyMinimized)
            || quickReplyHidden
        )
    ) return 'quick-reply';
    return null;
}

export class MobileInteractionGuard {
    constructor({
        documentRef = globalThis.document,
        windowRef = globalThis.window,
        navigatorRef = globalThis.navigator,
        matchMedia = globalThis.matchMedia,
        mutationObserver = globalThis.MutationObserver,
        importActionLoader = () => import('../../../../action-loader.js'),
        onRecovered = null,
        setTimer = globalThis.setTimeout,
        clearTimer = globalThis.clearTimeout,
    } = {}) {
        this.document = documentRef;
        this.window = windowRef;
        this.navigator = navigatorRef;
        this.matchMedia = matchMedia;
        this.MutationObserver = mutationObserver;
        this.importActionLoader = importActionLoader;
        this.onRecovered = onRecovered;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.observer = null;
        this.dialogTimers = new Map();
        this.knownLoaderDialogs = new WeakSet();
        this.scanTimer = null;
        this.started = false;

        this.onMutations = this.onMutations.bind(this);
        this.onPointerEnd = this.onPointerEnd.bind(this);
        this.onPageVisible = this.onPageVisible.bind(this);
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
        this.document.addEventListener('visibilitychange', this.onPageVisible);
        this.window?.addEventListener?.('pageshow', this.onPageVisible);

        if (typeof this.MutationObserver === 'function') {
            this.observer = new this.MutationObserver(this.onMutations);
            this.observer.observe(this.document.body, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ['open', 'closing', 'class'],
            });
        }

        this.scanDialogs();
        return true;
    }

    onMutations(mutations) {
        const relevant = mutations.some(mutation => {
            const target = mutation.target;
            if (target?.matches?.('dialog.popup, #loader, #qr--modalEditor')) return true;
            if (target?.closest?.('dialog.popup')) return true;
            return [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])].some(node => (
                node?.matches?.('dialog.popup, #loader, #qr--modalEditor')
                || node?.querySelector?.('dialog.popup, #loader, #qr--modalEditor')
            ));
        });
        if (relevant) this.scheduleScan();
    }

    scheduleScan() {
        if (!this.started || this.scanTimer !== null) return;
        this.scanTimer = this.setTimer(() => {
            this.scanTimer = null;
            this.scanDialogs();
        }, 0);
    }

    scanDialogs() {
        if (!this.started) return;
        const dialogs = this.document.querySelectorAll?.('dialog.popup') || [];
        const present = new Set(dialogs);

        for (const [dialog] of this.dialogTimers) {
            if (!present.has(dialog) || !dialog.isConnected || !dialog.hasAttribute?.('open')) {
                this.cancelDialogTimer(dialog);
            }
        }

        for (const dialog of dialogs) {
            const loaderPresent = Boolean(dialog.querySelector?.('#loader'));
            if (loaderPresent) this.knownLoaderDialogs.add(dialog);
            if (!dialog.hasAttribute?.('open')) {
                this.cancelDialogTimer(dialog);
                continue;
            }
            if (dialog.hasAttribute?.('closing')) {
                this.scheduleDialogRecovery(dialog, 'closing', CLOSING_GRACE_MS);
            } else if (this.knownLoaderDialogs.has(dialog) && !loaderPresent) {
                this.scheduleDialogRecovery(dialog, 'orphan-loader', ORPHAN_LOADER_GRACE_MS);
            } else {
                this.cancelDialogTimer(dialog);
            }
        }
    }

    scheduleDialogRecovery(dialog, reason, delay) {
        const current = this.dialogTimers.get(dialog);
        if (current?.reason === reason) return;
        this.cancelDialogTimer(dialog);
        const timer = this.setTimer(() => {
            this.dialogTimers.delete(dialog);
            void this.recoverDialog(dialog, reason);
        }, delay);
        this.dialogTimers.set(dialog, { timer, reason });
    }

    cancelDialogTimer(dialog) {
        const pending = this.dialogTimers.get(dialog);
        if (!pending) return;
        this.clearTimer(pending.timer);
        this.dialogTimers.delete(dialog);
    }

    async hasActiveBlockingLoader() {
        try {
            const module = await this.importActionLoader();
            return Boolean(module.loader?.active?.().some(handle => (
                handle?.isActive && handle?.isBlocking
            )));
        } catch (error) {
            console.debug(LOG_PREFIX, '无法核对加载遮罩状态', error);
            return true;
        }
    }

    async recoverDialog(dialog, expectedReason, { backdropTap = false } = {}) {
        if (!this.started || !dialog?.isConnected) return false;

        const quickReply = dialog.querySelector?.('#qr--modalEditor');
        const state = {
            open: dialog.hasAttribute?.('open'),
            closing: dialog.hasAttribute?.('closing'),
            knownLoader: this.knownLoaderDialogs.has(dialog),
            loaderPresent: Boolean(dialog.querySelector?.('#loader')),
            activeBlockingLoader: false,
            quickReplyExecuting: Boolean(quickReply?.classList?.contains('qr--isExecuting')),
            quickReplyMinimized: Boolean(quickReply?.classList?.contains('qr--minimized')),
            quickReplyHidden: Boolean(dialog.classList?.contains('qr--hide')),
            backdropTap,
        };

        if (expectedReason === 'orphan-loader') {
            state.activeBlockingLoader = await this.hasActiveBlockingLoader();
            if (!this.started || !dialog.isConnected) return false;
        }

        const reason = getDialogRecoveryReason(state);
        if (reason !== expectedReason) return false;

        if (reason === 'quick-reply') {
            dialog.classList?.remove('qr--hide');
            quickReply.classList?.remove('qr--minimized');
            dialog.querySelector?.('#qr--modal-maximize')?.click?.();
            this.notifyRecovered('检测到后台快捷回复仍在运行，已展开控制窗口', reason);
            return true;
        }

        try {
            dialog.close?.();
            dialog.removeAttribute?.('closing');
            this.notifyRecovered('已自动解除 Safari 残留的透明遮罩', reason);
            return true;
        } catch (error) {
            console.debug(LOG_PREFIX, '透明遮罩自愈失败', error);
            return false;
        }
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
        let reason = null;
        if (dialog.hasAttribute?.('closing')) reason = 'closing';
        else if (
            (quickReply?.classList?.contains('qr--isExecuting')
                && quickReply.classList.contains('qr--minimized'))
            || (quickReply && dialog.classList?.contains('qr--hide'))
        ) reason = 'quick-reply';

        if (!reason) return;
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation?.();
        this.cancelDialogTimer(dialog);
        void this.recoverDialog(dialog, reason, { backdropTap: true });
    }

    onPageVisible() {
        if (this.document.visibilityState && this.document.visibilityState !== 'visible') return;
        this.scheduleScan();
    }

    notifyRecovered(message, reason) {
        console.info(LOG_PREFIX, message, reason);
        globalThis.toastr?.info?.(message, '云酒馆加速器', { timeOut: 2600 });
        this.onRecovered?.(reason);
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.document.removeEventListener('pointerup', this.onPointerEnd, true);
        this.document.removeEventListener('pointercancel', this.onPointerEnd, true);
        this.document.removeEventListener('visibilitychange', this.onPageVisible);
        this.window?.removeEventListener?.('pageshow', this.onPageVisible);
        this.observer?.disconnect?.();
        this.observer = null;
        if (this.scanTimer !== null) this.clearTimer(this.scanTimer);
        this.scanTimer = null;
        for (const { timer } of this.dialogTimers.values()) this.clearTimer(timer);
        this.dialogTimers.clear();
        this.knownLoaderDialogs = new WeakSet();
    }
}
