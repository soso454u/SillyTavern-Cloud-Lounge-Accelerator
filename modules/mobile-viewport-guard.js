const KEYBOARD_CLASS = 'cla-chat-keyboard';
const KEYBOARD_SHIFT_PROPERTY = '--cla-keyboard-shift';

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
        this.frame = null;
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
        const inset = this.engaged ? getVisualViewportInset(this.window) : null;
        if (!this.engaged || inset === null) {
            this.clearViewportState();
            return;
        }
        const shift = inset > 0 ? -inset : 0;
        this.document.body.style?.setProperty?.(KEYBOARD_SHIFT_PROPERTY, `${shift}px`);
        this.document.body.classList?.add?.(KEYBOARD_CLASS);
    }

    clearViewportState() {
        this.document?.body?.classList?.remove?.(KEYBOARD_CLASS);
        this.document?.body?.style?.removeProperty?.(KEYBOARD_SHIFT_PROPERTY);
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
        this.clearTimer(this.blurTimer);
        this.blurTimer = null;
        this.clearViewportState();
    }
}
