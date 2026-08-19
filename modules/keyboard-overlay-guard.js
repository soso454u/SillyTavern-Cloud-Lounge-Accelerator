const KEYBOARD_CLASS = 'cla-keyboard-overlay';
const KEYBOARD_SHIFT_PROPERTY = '--cla-keyboard-shift';
const CLOSE_STABLE_MS = 120;
const CLOSE_FALLBACK_MS = 2000;

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

export function calculateKeyboardLift({ formBottom, viewportBottom, appliedLift = 0, tolerance = 2 } = {}) {
    const values = [formBottom, viewportBottom, appliedLift].map(Number);
    if (!values.every(Number.isFinite)) return 0;
    // getBoundingClientRect() includes our current translate. Add it back before
    // measuring so repeated viewport events cannot compound the lift.
    const naturalBottom = values[0] + Math.max(0, values[2]);
    const lift = Math.max(0, Math.round(naturalBottom - values[1]));
    return lift <= tolerance ? 0 : lift;
}

export class KeyboardOverlayGuard {
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
        this.closing = false;
        this.appliedLift = 0;
        this.frame = null;
        this.closeStableTimer = null;
        this.closeFallbackTimer = null;
        this.onFocusChange = this.onFocusChange.bind(this);
        this.onViewportChange = this.onViewportChange.bind(this);
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
        const textarea = this.document.querySelector?.('#send_textarea');
        this.clearTimer(this.closeStableTimer);
        this.closeStableTimer = null;
        this.clearTimer(this.closeFallbackTimer);
        this.closeFallbackTimer = null;

        if (event?.type === 'focusin') {
            if (event.target !== textarea) {
                this.engaged = false;
                this.closing = false;
                this.clearShift();
                return;
            }
            this.engaged = true;
            this.closing = false;
            this.scheduleSync();
            return;
        }

        if (event?.target !== textarea && !this.engaged) return;
        this.closing = true;
        this.closeFallbackTimer = this.setTimer(() => {
            this.closeFallbackTimer = null;
            if (this.document.activeElement === textarea) return;
            this.engaged = false;
            this.closing = false;
            this.clearShift();
        }, CLOSE_FALLBACK_MS);
        this.scheduleSync();
    }

    onViewportChange() {
        if (this.engaged || this.closing) this.scheduleSync();
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
        if (!this.engaged) {
            this.clearShift();
            return;
        }

        const form = this.document.querySelector?.('#form_sheld');
        const formBottom = Number(form?.getBoundingClientRect?.().bottom);
        const viewportBottom = getVisualViewportBottom(this.window);
        if (!form || !Number.isFinite(formBottom) || viewportBottom === null) {
            this.clearShift();
            return;
        }

        const lift = calculateKeyboardLift({
            formBottom,
            viewportBottom,
            appliedLift: this.appliedLift,
        });
        this.applyLift(lift);
        if (this.closing && lift === 0) this.finishCloseWhenStable(textarea);
        else if (lift > 0 && this.closeStableTimer !== null) {
            this.clearTimer(this.closeStableTimer);
            this.closeStableTimer = null;
        }
    }

    applyLift(lift) {
        if (lift <= 0) {
            this.clearShift();
            return;
        }
        if (lift === this.appliedLift && this.document.body.classList?.contains?.(KEYBOARD_CLASS)) return;
        this.appliedLift = lift;
        this.document.body.style?.setProperty?.(KEYBOARD_SHIFT_PROPERTY, `${-lift}px`);
        this.document.body.classList?.add?.(KEYBOARD_CLASS);
    }

    finishCloseWhenStable(textarea) {
        if (this.closeStableTimer !== null) return;
        this.closeStableTimer = this.setTimer(() => {
            this.closeStableTimer = null;
            if (!this.started || !this.closing) return;
            if (this.document.activeElement === textarea) {
                this.engaged = true;
                this.closing = false;
                return;
            }
            this.clearTimer(this.closeFallbackTimer);
            this.closeFallbackTimer = null;
            this.engaged = false;
            this.closing = false;
            this.clearShift();
        }, CLOSE_STABLE_MS);
    }

    clearShift() {
        this.appliedLift = 0;
        this.document?.body?.classList?.remove?.(KEYBOARD_CLASS);
        this.document?.body?.style?.removeProperty?.(KEYBOARD_SHIFT_PROPERTY);
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.engaged = false;
        this.closing = false;
        this.document.removeEventListener('focusin', this.onFocusChange, true);
        this.document.removeEventListener('focusout', this.onFocusChange, true);
        this.window.visualViewport?.removeEventListener?.('resize', this.onViewportChange);
        this.window.visualViewport?.removeEventListener?.('scroll', this.onViewportChange);
        this.window.removeEventListener?.('orientationchange', this.onViewportChange);
        if (this.frame !== null) this.cancelFrame(this.frame);
        this.frame = null;
        this.clearTimer(this.closeStableTimer);
        this.closeStableTimer = null;
        this.clearTimer(this.closeFallbackTimer);
        this.closeFallbackTimer = null;
        this.clearShift();
    }
}
