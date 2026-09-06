import { detectRenderProfile, matchesMedia } from '../utils/device-profile.js';

export { detectRenderProfile };

const TRANSITION_CLASSES = ['cla-ui-opening', 'cla-ui-closing'];
const TRANSITION_DURATIONS_MS = Object.freeze({
    desktop: Object.freeze({ opening: 160, closing: 130 }),
    balanced: Object.freeze({ opening: 90, closing: 70 }),
    webkit: Object.freeze({ opening: 80, closing: 60 }),
});

export class UiRenderOptimizer {
    constructor({
        documentRef = globalThis.document,
        windowRef = globalThis.window,
        navigatorRef = globalThis.navigator,
        matchMedia = globalThis.matchMedia,
        setTimer = globalThis.setTimeout,
        clearTimer = globalThis.clearTimeout,
    } = {}) {
        this.document = documentRef;
        this.window = windowRef;
        this.navigator = navigatorRef;
        this.matchMedia = matchMedia;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.profile = null;
        this.pending = new Map();
        this.started = false;
        this.onClick = this.onClick.bind(this);
        this.onPageVisible = this.onPageVisible.bind(this);
    }

    start() {
        if (this.started) return this.profile;
        this.profile = detectRenderProfile({
            userAgent: this.navigator?.userAgent,
            platform: this.navigator?.platform,
            maxTouchPoints: this.navigator?.maxTouchPoints,
            coarsePointer: matchesMedia('(pointer: coarse)', this.matchMedia),
        });
        if (!this.profile || !this.document?.body) return null;

        this.started = true;
        this.document.body.classList?.add('cla-fast-ui');
        this.document.body.classList?.add(`cla-ui-${this.profile}`);
        // SillyTavern raises navbar drawers above character details and other
        // panels. Keep that native stacking rule on mobile as well as desktop.
        this.document.addEventListener('click', this.onClick, true);
        this.document.addEventListener('visibilitychange', this.onPageVisible);
        this.window?.addEventListener?.('pageshow', this.onPageVisible);
        return this.profile;
    }

    onClick(event) {
        const target = event.target;
        const toggle = target?.closest?.('#top-settings-holder .drawer-toggle, #top-settings-holder .drawer-icon');
        const drawer = toggle?.closest?.('.drawer');
        const content = drawer?.querySelector?.(':scope > .drawer-content');
        if (!content) return;

        const opening = !content.classList?.contains('openDrawer');
        if (opening) {
            const opened = this.document.querySelectorAll?.('#top-settings-holder .drawer-content.openDrawer') || [];
            for (const current of opened) {
                if (current !== content) this.markTransition(current, 'closing');
            }
        }
        this.markTransition(content, opening ? 'opening' : 'closing');
    }

    markTransition(content, phase) {
        if (!this.started || !content?.classList) return;
        this.clearTransition(content);
        content.classList.remove(...TRANSITION_CLASSES);
        content.classList.add(`cla-ui-${phase}`);

        const duration = TRANSITION_DURATIONS_MS[this.profile]?.[phase]
            ?? TRANSITION_DURATIONS_MS.desktop[phase];
        // Cleanup must not wait for an animation frame that Safari can suspend
        // during keyboard/selection UI or when returning from the background.
        const timer = this.setTimer(() => this.clearTransition(content), duration + 64);
        this.pending.set(content, timer);
    }

    clearTransition(content) {
        const timer = this.pending.get(content);
        if (timer !== undefined) this.clearTimer(timer);
        this.pending.delete(content);
        content?.classList?.remove(...TRANSITION_CLASSES);
    }

    onPageVisible() {
        if (this.document.visibilityState && this.document.visibilityState !== 'visible') return;
        for (const content of [...this.pending.keys()]) this.clearTransition(content);
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.document.removeEventListener('click', this.onClick, true);
        this.document.removeEventListener('visibilitychange', this.onPageVisible);
        this.window?.removeEventListener?.('pageshow', this.onPageVisible);
        for (const content of [...this.pending.keys()]) this.clearTransition(content);
        this.document.body?.classList?.remove(
            'cla-fast-ui',
            'cla-ui-desktop',
            'cla-ui-balanced',
            'cla-ui-webkit',
        );
        this.profile = null;
    }
}
