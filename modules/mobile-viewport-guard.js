const KEYBOARD_CLASS = 'cla-chat-keyboard';
const KEYBOARD_INSET_PROPERTY = '--cla-keyboard-inset';
const BOTTOM_ANCHOR_TOLERANCE = 64;

export function getVisualViewportBottom(windowRef = globalThis.window) {
    const viewport = windowRef?.visualViewport;
    if (!viewport) return null;
    const bottom = Number(viewport.offsetTop || 0) + Number(viewport.height || 0);
    if (!Number.isFinite(bottom) || bottom <= 0) return null;
    const layoutHeight = Math.max(
        Number(windowRef?.innerHeight || 0),
        Number(windowRef?.document?.documentElement?.clientHeight || 0),
    );
    return Math.round(layoutHeight > 0 ? Math.min(bottom, layoutHeight) : bottom);
}

export function getVisualViewportInset(windowRef = globalThis.window) {
    const bottom = getVisualViewportBottom(windowRef);
    if (bottom === null) return null;
    const layoutHeight = Math.max(
        Number(windowRef?.innerHeight || 0),
        Number(windowRef?.document?.documentElement?.clientHeight || 0),
    );
    return Math.max(0, Math.round(layoutHeight - bottom));
}

export class MobileViewportGuard {
    constructor({
        documentRef = globalThis.document,
        windowRef = globalThis.window,
        navigatorRef = globalThis.navigator,
        matchMediaRef = globalThis.matchMedia,
        setTimer = globalThis.setTimeout,
        clearTimer = globalThis.clearTimeout,
        requestFrame = callback => globalThis.requestAnimationFrame?.(callback) ?? setTimer(callback, 16),
        cancelFrame = handle => globalThis.cancelAnimationFrame?.(handle) ?? clearTimer(handle),
    } = {}) {
        this.document = documentRef;
        this.window = windowRef;
        this.navigator = navigatorRef;
        this.matchMedia = matchMediaRef;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.requestFrame = requestFrame;
        this.cancelFrame = cancelFrame;
        this.started = false;
        this.engaged = false;
        this.appliedInset = 0;
        this.frame = null;
        this.bottomFrame = null;
        this.blurTimer = null;
        this.onViewportChange = this.onViewportChange.bind(this);
        this.onFocusChange = this.onFocusChange.bind(this);
    }

    isTouchEnvironment() {
        try {
            return Number(this.navigator?.maxTouchPoints || 0) > 0
                || Boolean(this.matchMedia?.('(pointer: coarse)')?.matches);
        } catch {
            return Number(this.navigator?.maxTouchPoints || 0) > 0;
        }
    }

    start() {
        if (this.started) return true;
        if (!this.document?.body || !this.window?.visualViewport || !this.isTouchEnvironment()) return false;
        this.started = true;
        this.document.addEventListener('focusin', this.onFocusChange, true);
        this.document.addEventListener('focusout', this.onFocusChange, true);
        this.window.visualViewport.addEventListener('resize', this.onViewportChange);
        this.window.visualViewport.addEventListener('scroll', this.onViewportChange);
        this.window.addEventListener?.('orientationchange', this.onViewportChange);
        this.sync();
        return true;
    }

    onFocusChange(event) {
        this.clearTimer(this.blurTimer);
        this.blurTimer = null;
        if (event?.type === 'focusout') {
            this.blurTimer = this.setTimer(() => {
                this.blurTimer = null;
                this.engaged = false;
                this.scheduleSync();
            }, 450);
            return;
        }
        const textarea = this.document.querySelector?.('#send_textarea');
        this.engaged = event?.target === textarea || this.document.activeElement === textarea;
        this.scheduleSync();
    }

    onViewportChange() {
        this.scheduleSync();
    }

    scheduleSync() {
        if (!this.started || this.frame !== null) return;
        this.frame = this.requestFrame(() => {
            this.frame = null;
            this.sync();
        });
    }

    sync() {
        if (!this.started) return;
        const textarea = this.document.querySelector?.('#send_textarea');
        const focused = textarea && this.document.activeElement === textarea;
        if (focused) this.engaged = true;
        const viewportBottom = this.engaged ? getVisualViewportBottom(this.window) : null;
        const sheld = this.document.querySelector?.('#sheld');
        const sheldRect = sheld?.getBoundingClientRect?.();
        if (!this.engaged || viewportBottom === null || !Number.isFinite(sheldRect?.bottom)) {
            this.clearViewportState();
            return;
        }

        // Measure only the part of SillyTavern's layout that is actually hidden.
        // Browsers honoring interactive-widget=resizes-content already shorten
        // #sheld; applying the full visualViewport inset again would double-lift
        // the input form and leave the large gaps seen on iOS.
        const naturalBottom = Number(sheldRect.bottom) + this.appliedInset;
        const measuredInset = Math.max(0, Math.round(naturalBottom - viewportBottom));
        const inset = measuredInset <= 2 ? 0 : measuredInset;
        const chat = this.document.querySelector?.('#chat');
        const preserveBottom = this.isNearChatBottom(chat);

        this.appliedInset = inset;
        this.document.body.style?.setProperty?.(KEYBOARD_INSET_PROPERTY, `${inset}px`);
        this.document.body.classList?.add?.(KEYBOARD_CLASS);
        if (preserveBottom) this.anchorChatBottom(chat);
    }

    isNearChatBottom(chat) {
        const scrollHeight = Number(chat?.scrollHeight);
        const scrollTop = Number(chat?.scrollTop);
        const clientHeight = Number(chat?.clientHeight);
        if (![scrollHeight, scrollTop, clientHeight].every(Number.isFinite)) return false;
        return scrollHeight - scrollTop - clientHeight <= BOTTOM_ANCHOR_TOLERANCE;
    }

    anchorChatBottom(chat) {
        if (!chat) return;
        if (this.bottomFrame !== null) this.cancelFrame(this.bottomFrame);
        this.bottomFrame = this.requestFrame(() => {
            this.bottomFrame = null;
            if (!this.started || !this.engaged) return;
            chat.scrollTo?.(0, chat.scrollHeight);
            if (typeof chat.scrollTo !== 'function') chat.scrollTop = chat.scrollHeight;
        });
    }

    clearViewportState() {
        this.appliedInset = 0;
        this.document?.body?.classList?.remove?.(KEYBOARD_CLASS);
        this.document?.body?.style?.removeProperty?.(KEYBOARD_INSET_PROPERTY);
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.engaged = false;
        this.document.removeEventListener('focusin', this.onFocusChange, true);
        this.document.removeEventListener('focusout', this.onFocusChange, true);
        this.window.visualViewport?.removeEventListener?.('resize', this.onViewportChange);
        this.window.visualViewport?.removeEventListener?.('scroll', this.onViewportChange);
        this.window.removeEventListener?.('orientationchange', this.onViewportChange);
        if (this.frame !== null) this.cancelFrame(this.frame);
        this.frame = null;
        if (this.bottomFrame !== null) this.cancelFrame(this.bottomFrame);
        this.bottomFrame = null;
        this.clearTimer(this.blurTimer);
        this.blurTimer = null;
        this.clearViewportState();
    }
}
