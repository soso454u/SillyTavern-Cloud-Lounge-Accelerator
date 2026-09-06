import { isIosWebKitTouch } from '../utils/device-profile.js';

export { isIosWebKitTouch };

// Remove only our retired keyboard overlay state. The browser and SillyTavern
// own layout, scrolling, focus, selection, and the soft keyboard lifecycle.
export function restoreNativeInputLayout(documentRef = globalThis.document) {
    const form = documentRef?.querySelector?.('#form_sheld');
    for (const element of [form, documentRef?.body]) {
        element?.classList?.remove?.('cla-keyboard-overlay', 'cla-keyboard-closing');
        element?.style?.removeProperty?.('--cla-keyboard-shift');
    }
}

const REVEAL_DELAYS_MS = Object.freeze([80, 220, 420, 700]);
const FINAL_REVEAL_DELAY_MS = REVEAL_DELAYS_MS.at(-1);

export function isBelowVisualViewport(element, windowRef = globalThis.window, tolerance = 4) {
    const viewport = windowRef?.visualViewport;
    const rect = element?.getBoundingClientRect?.();
    const viewportTop = Number(viewport?.offsetTop || 0);
    const viewportHeight = Number(viewport?.height || 0);
    const bottom = Number(rect?.bottom);
    if (!Number.isFinite(bottom) || !Number.isFinite(viewportTop)
        || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return false;
    return bottom > viewportTop + viewportHeight - tolerance;
}

export class InputRevealGuard {
    constructor({
        documentRef = globalThis.document,
        windowRef = globalThis.window,
        navigatorRef = globalThis.navigator,
        matchMediaRef = globalThis.matchMedia,
        setTimer = globalThis.setTimeout,
        clearTimer = globalThis.clearTimeout,
    } = {}) {
        this.document = documentRef;
        this.window = windowRef;
        this.navigator = navigatorRef;
        this.matchMedia = matchMediaRef;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.timers = new Set();
        this.started = false;
        this.focusGeneration = 0;
        this.onFocusIn = this.onFocusIn.bind(this);
        this.onFocusOut = this.onFocusOut.bind(this);
        this.onViewportChange = this.onViewportChange.bind(this);
    }

    start() {
        if (this.started) return true;
        if (!this.document?.body || !this.window?.visualViewport || !isIosWebKitTouch({
            navigatorRef: this.navigator,
            matchMediaRef: this.matchMedia,
        })) return false;
        this.started = true;
        this.document.addEventListener('focusin', this.onFocusIn, true);
        this.document.addEventListener('focusout', this.onFocusOut, true);
        this.window.visualViewport.addEventListener('resize', this.onViewportChange);
        this.window.visualViewport.addEventListener('scroll', this.onViewportChange);
        return true;
    }

    getTextarea() {
        return this.document.querySelector?.('#send_textarea');
    }

    hasChatFocus(textarea = this.getTextarea()) {
        return Boolean(this.started && textarea && this.document.activeElement === textarea);
    }

    onFocusIn(event) {
        const textarea = this.getTextarea();
        if (event?.target !== textarea) return;
        this.cancelChecks();
        const generation = ++this.focusGeneration;
        for (const delay of REVEAL_DELAYS_MS) {
            const timer = this.setTimer(() => {
                this.timers.delete(timer);
                if (generation !== this.focusGeneration) return;
                // The final check also nudges Safari when third-party keyboards
                // have not reported their reduced visual viewport yet.
                this.revealIfNeeded(delay === FINAL_REVEAL_DELAY_MS);
            }, delay);
            this.timers.add(timer);
        }
    }

    onFocusOut(event) {
        if (event?.target !== this.getTextarea()) return;
        this.focusGeneration += 1;
        this.cancelChecks();
    }

    onViewportChange() {
        this.revealIfNeeded(false);
    }

    revealIfNeeded(force = false) {
        const textarea = this.getTextarea();
        if (!this.hasChatFocus(textarea)) return false;
        if (!force && !isBelowVisualViewport(textarea, this.window)) return false;
        if (typeof textarea.scrollIntoView !== 'function') return false;
        try {
            textarea.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
            return true;
        } catch {
            return false;
        }
    }

    cancelChecks() {
        for (const timer of this.timers) this.clearTimer(timer);
        this.timers.clear();
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.focusGeneration += 1;
        this.cancelChecks();
        this.document.removeEventListener('focusin', this.onFocusIn, true);
        this.document.removeEventListener('focusout', this.onFocusOut, true);
        this.window.visualViewport?.removeEventListener?.('resize', this.onViewportChange);
        this.window.visualViewport?.removeEventListener?.('scroll', this.onViewportChange);
        restoreNativeInputLayout(this.document);
    }
}
