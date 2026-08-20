const KEYBOARD_CLASS = 'cla-keyboard-overlay';
const KEYBOARD_CLOSING_CLASS = 'cla-keyboard-closing';
const KEYBOARD_SHIFT_PROPERTY = '--cla-keyboard-shift';
const CLOSE_RELEASE_DELAY_MS = 160;
const CLOSE_RELEASE_DURATION_MS = 80;
const CLOSE_SNAP_MIN_PX = 48;
const CLOSE_SNAP_MAX_PX = 96;

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

export function getCloseSnapThreshold(formHeight) {
    const height = Number(formHeight);
    const relativeThreshold = Number.isFinite(height) ? Math.round(height * 0.25) : CLOSE_SNAP_MIN_PX;
    return Math.min(CLOSE_SNAP_MAX_PX, Math.max(CLOSE_SNAP_MIN_PX, relativeThreshold));
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
        this.releasing = false;
        this.appliedLift = 0;
        this.frame = null;
        this.closeReleaseTimer = null;
        this.releaseCleanupTimer = null;
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

        if (event?.type === 'focusin') {
            this.cancelClosingRelease();
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
        this.scheduleClosingRelease(textarea);
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
        if (focused) {
            this.cancelClosingRelease();
            this.engaged = true;
            this.closing = false;
        }
        if (!this.engaged) {
            this.clearShift();
            return;
        }
        if (this.releasing) return;

        const form = this.document.querySelector?.('#form_sheld');
        const formRect = form?.getBoundingClientRect?.();
        const formBottom = Number(formRect?.bottom);
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
        if (!this.closing && this.appliedLift > 0 && lift < this.appliedLift) {
            // iOS may keep the textarea focused when the keyboard is dismissed
            // from its own UI. A falling measured lift is still a close signal.
            this.closing = true;
            this.scheduleClosingRelease(textarea);
        }
        if (this.closing && lift <= getCloseSnapThreshold(formRect?.height)) {
            this.beginClosingRelease(form, textarea);
            return;
        }
        this.applyLift(form, lift);
    }

    applyLift(form, lift) {
        if (!form) return;
        if (lift <= 0) {
            this.clearShift();
            return;
        }
        if (lift === this.appliedLift && form.classList?.contains?.(KEYBOARD_CLASS)) return;
        this.appliedLift = lift;
        form.classList?.remove?.(KEYBOARD_CLOSING_CLASS);
        form.style?.setProperty?.(KEYBOARD_SHIFT_PROPERTY, `${-lift}px`);
        form.classList?.add?.(KEYBOARD_CLASS);
    }

    scheduleClosingRelease(textarea) {
        if (this.closeReleaseTimer !== null || this.releasing) return;
        this.closeReleaseTimer = this.setTimer(() => {
            this.closeReleaseTimer = null;
            if (!this.started || !this.closing) return;
            this.beginClosingRelease(this.document.querySelector?.('#form_sheld'), textarea);
        }, CLOSE_RELEASE_DELAY_MS);
    }

    beginClosingRelease(form, textarea) {
        if (!form || this.releasing) return;
        this.clearTimer(this.closeReleaseTimer);
        this.closeReleaseTimer = null;
        this.releasing = true;
        this.appliedLift = 0;
        form.classList?.add?.(KEYBOARD_CLASS, KEYBOARD_CLOSING_CLASS);
        form.style?.setProperty?.(KEYBOARD_SHIFT_PROPERTY, '0px');
        this.releaseCleanupTimer = this.setTimer(() => {
            this.releaseCleanupTimer = null;
            if (!this.started || !this.releasing) return;
            this.releasing = false;
            this.closing = false;
            this.engaged = this.document.activeElement === textarea;
            this.clearShift();
        }, CLOSE_RELEASE_DURATION_MS);
    }

    cancelClosingRelease() {
        this.clearTimer(this.closeReleaseTimer);
        this.closeReleaseTimer = null;
        this.clearTimer(this.releaseCleanupTimer);
        this.releaseCleanupTimer = null;
        this.releasing = false;
    }

    clearShift() {
        this.appliedLift = 0;
        const form = this.document?.querySelector?.('#form_sheld');
        form?.classList?.remove?.(KEYBOARD_CLASS, KEYBOARD_CLOSING_CLASS);
        form?.style?.removeProperty?.(KEYBOARD_SHIFT_PROPERTY);
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.engaged = false;
        this.closing = false;
        this.releasing = false;
        this.document.removeEventListener('focusin', this.onFocusChange, true);
        this.document.removeEventListener('focusout', this.onFocusChange, true);
        this.window.visualViewport?.removeEventListener?.('resize', this.onViewportChange);
        this.window.visualViewport?.removeEventListener?.('scroll', this.onViewportChange);
        this.window.removeEventListener?.('orientationchange', this.onViewportChange);
        if (this.frame !== null) this.cancelFrame(this.frame);
        this.frame = null;
        this.cancelClosingRelease();
        this.clearShift();
    }
}
