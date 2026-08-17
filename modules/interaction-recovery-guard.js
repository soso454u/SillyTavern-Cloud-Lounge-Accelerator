const LOG_PREFIX = '[Cloud Lounge Accelerator]';
const CLOSING_GRACE_MS = 900;
const ORPHAN_LOADER_GRACE_MS = 1200;
const EXPLICIT_BLOCKER_GRACE_MS = 450;
const HIDDEN_DIALOG_GRACE_MS = 900;
const LEGACY_OVERLAY_GRACE_MS = 700;
const LEGACY_OVERLAY_SELECTOR = '#shadow_popup, #shadow_character_popup, #shadow_select_chat_popup';
const LEGACY_OVERLAY_CONTENT = new Map([
    ['shadow_popup', '#dialogue_popup'],
    ['shadow_character_popup', '#character_popup'],
    ['shadow_select_chat_popup', '#select_chat_popup'],
]);

function isPointInside(rect, x, y) {
    return Boolean(rect)
        && Number.isFinite(x)
        && Number.isFinite(y)
        && x >= rect.left
        && x <= rect.right
        && y >= rect.top
        && y <= rect.bottom;
}

export function describeInteractionBlocker(element) {
    const dialog = element?.closest?.('dialog.popup[open]');
    if (!dialog) return null;
    if (dialog.hasAttribute?.('closing')) return 'dialog.popup[closing]';
    if (dialog.querySelector?.('#loader')) return 'dialog.popup[loader]';
    return 'dialog.popup[open]';
}

export function detectInteractionEnvironment(navigatorRef = globalThis.navigator) {
    const userAgent = String(navigatorRef?.userAgent || '');
    let browser = 'Browser';
    if (/Edg\//i.test(userAgent)) browser = 'Edge';
    else if (/Firefox|FxiOS/i.test(userAgent)) browser = 'Firefox';
    else if (/CriOS|Chrome/i.test(userAgent)) browser = 'Chrome';
    else if (/Safari/i.test(userAgent)) browser = 'Safari';
    const device = Number(navigatorRef?.maxTouchPoints || 0) > 0 ? 'Touch' : 'Desktop';
    return `${browser} · ${device}`;
}

export function isControlActionable(control, {
    windowRef = globalThis.window,
} = {}) {
    if (!control?.isConnected || control.disabled || control.readOnly) return false;
    if (control.inert || control.closest?.('[inert]')) return false;
    const rect = control.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    try {
        const style = windowRef?.getComputedStyle?.(control);
        if (style && (
            style.display === 'none'
            || style.visibility === 'hidden'
            || style.pointerEvents === 'none'
        )) return false;
    } catch {
        return false;
    }
    return true;
}

function isElementRendered(element, windowRef) {
    if (!element?.isConnected) return false;
    for (let current = element; current; current = current.parentElement) {
        try {
            const style = windowRef?.getComputedStyle?.(current);
            if (style && (
                style.display === 'none'
                || style.visibility === 'hidden'
                || Number.parseFloat(style.opacity) <= 0.01
            )) return false;
        } catch {
            return true;
        }
    }
    const rect = element.getBoundingClientRect?.();
    return !rect || (rect.width > 1 && rect.height > 1);
}

export function isDialogVisuallyHidden(dialog, { windowRef = globalThis.window } = {}) {
    if (!dialog?.hasAttribute?.('open')) return false;
    try {
        const style = windowRef?.getComputedStyle?.(dialog);
        if (style && (
            style.display === 'none'
            || style.visibility === 'hidden'
            || style.pointerEvents === 'none'
            || Number.parseFloat(style.opacity) <= 0.01
        )) return true;
    } catch {
        return false;
    }
    const rect = dialog.getBoundingClientRect?.();
    return Boolean(rect && (rect.width <= 1 || rect.height <= 1));
}

export function getStaleLegacyOverlay(element, {
    documentRef = globalThis.document,
    windowRef = globalThis.window,
} = {}) {
    const overlay = element?.closest?.(LEGACY_OVERLAY_SELECTOR);
    if (!overlay?.isConnected) return null;
    try {
        const style = windowRef?.getComputedStyle?.(overlay);
        if (style && (
            style.display === 'none'
            || style.visibility === 'hidden'
            || style.pointerEvents === 'none'
        )) return null;
    } catch {
        return null;
    }
    const contentSelector = LEGACY_OVERLAY_CONTENT.get(String(overlay.id || ''));
    const content = contentSelector ? documentRef?.querySelector?.(contentSelector) : null;
    return isElementRendered(content, windowRef) ? null : overlay;
}

export class InteractionRecoveryGuard {
    constructor({
        documentRef = globalThis.document,
        windowRef = globalThis.window,
        navigatorRef = globalThis.navigator,
        mutationObserver = globalThis.MutationObserver,
        importActionLoader = () => import('../../../../action-loader.js'),
        onRecovered = null,
        now = () => Date.now(),
        setTimer = globalThis.setTimeout,
        clearTimer = globalThis.clearTimeout,
        scheduleMicrotask = callback => globalThis.queueMicrotask?.(callback) ?? Promise.resolve().then(callback),
        requestFrame = callback => globalThis.requestAnimationFrame?.(callback) ?? setTimer(callback, 16),
        cancelFrame = handle => globalThis.cancelAnimationFrame?.(handle) ?? clearTimer(handle),
    } = {}) {
        this.document = documentRef;
        this.window = windowRef;
        this.navigator = navigatorRef;
        this.MutationObserver = mutationObserver;
        this.importActionLoader = importActionLoader;
        this.onRecovered = onRecovered;
        this.now = now;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.scheduleMicrotask = scheduleMicrotask;
        this.requestFrame = requestFrame;
        this.cancelFrame = cancelFrame;
        this.bodyObserver = null;
        this.dialogObservers = new Map();
        this.dialogTimers = new Map();
        this.legacyOverlayObservers = new Map();
        this.legacyOverlayTimers = new Map();
        this.closingSince = new WeakMap();
        this.hiddenSince = new WeakMap();
        this.knownLoaderDialogs = new WeakSet();
        this.scanHandle = null;
        this.recoveryCount = 0;
        this.started = false;

        this.onBodyMutations = this.onBodyMutations.bind(this);
        this.onPointerEnd = this.onPointerEnd.bind(this);
        this.onPageVisible = this.onPageVisible.bind(this);
    }

    start() {
        if (this.started) return true;
        if (!this.document?.body) return false;
        this.started = true;
        this.document.addEventListener('pointerup', this.onPointerEnd, true);
        this.document.addEventListener('visibilitychange', this.onPageVisible);
        this.window?.addEventListener?.('pageshow', this.onPageVisible);

        if (typeof this.MutationObserver === 'function') {
            this.bodyObserver = new this.MutationObserver(this.onBodyMutations);
            this.bodyObserver.observe(this.document.body, { subtree: true, childList: true });
        }
        this.scanDialogs();
        return true;
    }

    onBodyMutations(mutations) {
        const relevant = mutations.some(mutation => (
            [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])].some(node => (
                node?.matches?.(`dialog.popup, ${LEGACY_OVERLAY_SELECTOR}`)
                || node?.querySelector?.(`dialog.popup, ${LEGACY_OVERLAY_SELECTOR}`)
            ))
        ));
        if (relevant) this.scheduleScan();
    }

    onDialogMutations(dialog, mutations) {
        for (const mutation of mutations || []) {
            if (mutation.type === 'attributes' && mutation.attributeName === 'closing') {
                if (dialog.hasAttribute?.('closing')) this.closingSince.set(dialog, this.now());
                else this.closingSince.delete(dialog);
            }
            if (mutation.type === 'childList') {
                const loaderAdded = [...(mutation.addedNodes || [])].some(node => (
                    node?.id === 'loader' || node?.querySelector?.('#loader')
                ));
                if (loaderAdded) this.knownLoaderDialogs.add(dialog);
            }
        }
        this.scheduleScan();
    }

    scheduleScan() {
        if (!this.started || this.scanHandle !== null) return;
        this.scanHandle = this.requestFrame(() => {
            this.scanHandle = null;
            this.scanDialogs();
        });
    }

    syncDialogObservers(dialogs) {
        if (typeof this.MutationObserver !== 'function') return;
        const present = new Set(dialogs);
        for (const [dialog, observers] of this.dialogObservers) {
            if (!present.has(dialog) || !dialog.isConnected) {
                for (const observer of observers) observer.disconnect?.();
                this.dialogObservers.delete(dialog);
            }
        }
        for (const dialog of dialogs) {
            if (this.dialogObservers.has(dialog)) continue;
            const stateObserver = new this.MutationObserver(mutations => this.onDialogMutations(dialog, mutations));
            stateObserver.observe(dialog, {
                attributes: true,
                attributeFilter: ['open', 'closing', 'class', 'style'],
            });
            const contentObserver = new this.MutationObserver(mutations => this.onDialogMutations(dialog, mutations));
            contentObserver.observe(dialog, {
                subtree: true,
                childList: true,
            });
            this.dialogObservers.set(dialog, [stateObserver, contentObserver]);
        }
    }

    syncLegacyOverlayObservers() {
        if (typeof this.MutationObserver !== 'function') return;
        const overlays = this.document.querySelectorAll?.(LEGACY_OVERLAY_SELECTOR) || [];
        const present = new Set(overlays);
        for (const [overlay, observer] of this.legacyOverlayObservers) {
            if (!present.has(overlay) || !overlay.isConnected) {
                observer.disconnect?.();
                this.legacyOverlayObservers.delete(overlay);
                this.cancelLegacyOverlayTimer(overlay);
            }
        }
        for (const overlay of overlays) {
            if (this.legacyOverlayObservers.has(overlay)) continue;
            const observer = new this.MutationObserver(() => this.scheduleLegacyOverlayRecovery(overlay));
            observer.observe(overlay, {
                attributes: true,
                attributeFilter: ['class', 'style'],
            });
            this.legacyOverlayObservers.set(overlay, observer);
            this.scheduleLegacyOverlayRecovery(overlay);
        }
    }

    scanDialogs() {
        if (!this.started) return;
        const dialogs = this.document.querySelectorAll?.('dialog.popup') || [];
        this.syncDialogObservers(dialogs);
        this.syncLegacyOverlayObservers();
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
                this.closingSince.delete(dialog);
                this.hiddenSince.delete(dialog);
                continue;
            }
            if (dialog.hasAttribute?.('closing')) {
                if (!this.closingSince.has(dialog)) this.closingSince.set(dialog, this.now());
                this.scheduleDialogRecovery(dialog, 'closing', CLOSING_GRACE_MS);
            } else if (this.knownLoaderDialogs.has(dialog) && !loaderPresent) {
                this.closingSince.delete(dialog);
                this.hiddenSince.delete(dialog);
                this.scheduleDialogRecovery(dialog, 'orphan-loader', ORPHAN_LOADER_GRACE_MS);
            } else if (isDialogVisuallyHidden(dialog, { windowRef: this.window })) {
                this.closingSince.delete(dialog);
                if (!this.hiddenSince.has(dialog)) this.hiddenSince.set(dialog, this.now());
                this.scheduleDialogRecovery(dialog, 'hidden-dialog', HIDDEN_DIALOG_GRACE_MS);
            } else {
                this.closingSince.delete(dialog);
                this.hiddenSince.delete(dialog);
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

    scheduleLegacyOverlayRecovery(overlay) {
        this.cancelLegacyOverlayTimer(overlay);
        if (!this.started) return;
        const stale = getStaleLegacyOverlay(overlay, { documentRef: this.document, windowRef: this.window });
        if (stale !== overlay) return;
        const timer = this.setTimer(() => {
            this.legacyOverlayTimers.delete(overlay);
            this.recoverLegacyOverlay(overlay);
        }, LEGACY_OVERLAY_GRACE_MS);
        this.legacyOverlayTimers.set(overlay, timer);
    }

    cancelLegacyOverlayTimer(overlay) {
        const timer = this.legacyOverlayTimers.get(overlay);
        if (timer === undefined) return;
        this.clearTimer(timer);
        this.legacyOverlayTimers.delete(overlay);
    }

    async hasActiveBlockingLoader() {
        try {
            const module = await this.importActionLoader();
            return Boolean(module.loader?.active?.().some(handle => handle?.isActive && handle?.isBlocking));
        } catch (error) {
            console.debug(LOG_PREFIX, '无法核对加载遮罩状态', error);
            return true;
        }
    }

    async recoverDialog(dialog, reason) {
        if (!['closing', 'orphan-loader', 'hidden-dialog'].includes(reason)) return false;
        if (!this.started || !dialog?.isConnected || !dialog.hasAttribute?.('open')) return false;
        if (typeof dialog.close !== 'function') return false;
        if (reason === 'closing' && !dialog.hasAttribute?.('closing')) return false;
        if (reason === 'hidden-dialog' && !isDialogVisuallyHidden(dialog, { windowRef: this.window })) return false;
        if (reason === 'orphan-loader') {
            if (!this.knownLoaderDialogs.has(dialog) || dialog.querySelector?.('#loader')) return false;
            if (await this.hasActiveBlockingLoader()) return false;
            if (!this.started || !dialog.isConnected || !dialog.hasAttribute?.('open')) return false;
        }

        const blockerLabel = reason === 'orphan-loader'
            ? 'dialog.popup[loader-orphan]'
            : (reason === 'hidden-dialog' ? 'dialog.popup[open][hidden]' : describeInteractionBlocker(dialog));
        try {
            dialog.close();
            dialog.removeAttribute?.('closing');
            this.cancelDialogTimer(dialog);
            this.closingSince.delete(dialog);
            this.hiddenSince.delete(dialog);
            const recoveryReason = reason === 'closing'
                ? '残留关闭弹窗'
                : (reason === 'hidden-dialog' ? '不可见弹窗' : '残留加载遮罩');
            this.notifyRecovered(recoveryReason, blockerLabel);
            return true;
        } catch (error) {
            console.debug(LOG_PREFIX, '交互阻塞层自愈失败', error);
            return false;
        }
    }

    getStaleBlocker(event) {
        const hit = this.document.elementFromPoint?.(event.clientX, event.clientY) || event.target;
        const overlay = getStaleLegacyOverlay(hit, { documentRef: this.document, windowRef: this.window });
        if (overlay) return { overlay, reason: 'legacy-overlay' };
        const dialog = hit?.closest?.('dialog.popup[open]') || event.target?.closest?.('dialog.popup[open]');
        if (!dialog) return null;
        if (dialog.hasAttribute?.('closing')) {
            const since = this.closingSince.get(dialog);
            if (Number.isFinite(since) && this.now() - since >= EXPLICIT_BLOCKER_GRACE_MS) {
                return { dialog, reason: 'closing' };
            }
        }
        if (this.knownLoaderDialogs.has(dialog) && !dialog.querySelector?.('#loader')) {
            return { dialog, reason: 'orphan-loader' };
        }
        if (isDialogVisuallyHidden(dialog, { windowRef: this.window })) {
            const since = this.hiddenSince.get(dialog);
            if (Number.isFinite(since) && this.now() - since >= EXPLICIT_BLOCKER_GRACE_MS) {
                return { dialog, reason: 'hidden-dialog' };
            }
        }
        return null;
    }

    recoverLegacyOverlay(overlay) {
        if (!this.started || !overlay?.isConnected || !overlay.style) return false;
        const stale = getStaleLegacyOverlay(overlay, { documentRef: this.document, windowRef: this.window });
        if (stale !== overlay) return false;
        overlay.style.display = 'none';
        this.cancelLegacyOverlayTimer(overlay);
        this.notifyRecovered('残留页面遮罩', `#${overlay.id}`);
        return true;
    }

    async onPointerEnd(event) {
        if (!this.started || event.type !== 'pointerup' || event.button > 0) return;
        const textarea = this.document.querySelector?.('#send_textarea');
        const textareaActionable = isControlActionable(textarea, { windowRef: this.window });
        const textareaRect = textarea?.getBoundingClientRect?.();
        const textareaIntent = textareaActionable && isPointInside(textareaRect, event.clientX, event.clientY);

        const direct = event.target === textarea || event.target?.closest?.('#send_textarea') === textarea;
        if (direct) {
            if (!textareaActionable) return;
            this.scheduleMicrotask(() => {
                if (!this.started || this.document.activeElement === textarea) return;
                const legitimateModal = this.document.querySelector?.('dialog.popup[open]:not([closing])');
                if (legitimateModal || !isControlActionable(textarea, { windowRef: this.window })) return;
                textarea.focus?.({ preventScroll: true });
                if (this.document.activeElement === textarea) this.notifyRecovered('输入焦点', null);
            });
            return;
        }

        const blocker = this.getStaleBlocker(event);
        if (!blocker) return;
        const recovered = blocker.overlay
            ? this.recoverLegacyOverlay(blocker.overlay)
            : await this.recoverDialog(blocker.dialog, blocker.reason);
        if (!recovered || !this.started || !textareaIntent) return;
        this.requestFrame(() => {
            if (isControlActionable(textarea, { windowRef: this.window })) {
                textarea.focus?.({ preventScroll: true });
            }
        });
    }

    onPageVisible() {
        if (this.document.visibilityState && this.document.visibilityState !== 'visible') return;
        this.scheduleScan();
    }

    notifyRecovered(reason, blocker) {
        this.recoveryCount += 1;
        const diagnostic = {
            reason,
            blocker: typeof blocker === 'string' ? blocker : describeInteractionBlocker(blocker),
            count: this.recoveryCount,
            environment: detectInteractionEnvironment(this.navigator),
        };
        console.info(LOG_PREFIX, '全平台交互自愈', diagnostic);
        this.onRecovered?.(diagnostic);
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.document.removeEventListener('pointerup', this.onPointerEnd, true);
        this.document.removeEventListener('visibilitychange', this.onPageVisible);
        this.window?.removeEventListener?.('pageshow', this.onPageVisible);
        this.bodyObserver?.disconnect?.();
        this.bodyObserver = null;
        for (const observers of this.dialogObservers.values()) {
            for (const observer of observers) observer.disconnect?.();
        }
        this.dialogObservers.clear();
        for (const observer of this.legacyOverlayObservers.values()) observer.disconnect?.();
        this.legacyOverlayObservers.clear();
        if (this.scanHandle !== null) this.cancelFrame(this.scanHandle);
        this.scanHandle = null;
        for (const { timer } of this.dialogTimers.values()) this.clearTimer(timer);
        this.dialogTimers.clear();
        for (const timer of this.legacyOverlayTimers.values()) this.clearTimer(timer);
        this.legacyOverlayTimers.clear();
        this.closingSince = new WeakMap();
        this.hiddenSince = new WeakMap();
        this.knownLoaderDialogs = new WeakSet();
        this.recoveryCount = 0;
    }
}
