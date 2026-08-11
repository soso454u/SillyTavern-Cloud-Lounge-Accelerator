const TRANSITION_CLASSES = ['cla-ui-opening', 'cla-ui-closing'];

export function detectMobileRenderProfile({
    userAgent = globalThis.navigator?.userAgent || '',
    platform = globalThis.navigator?.platform || '',
    maxTouchPoints = globalThis.navigator?.maxTouchPoints || 0,
    coarsePointer = false,
} = {}) {
    const touch = Number(maxTouchPoints) > 0 || coarsePointer === true;
    if (!touch) return null;
    const webkitMobile = !/Android/i.test(userAgent) && (
        /iPad|iPhone|iPod/i.test(userAgent)
        || (platform === 'MacIntel' && Number(maxTouchPoints) > 1)
    );
    return webkitMobile ? 'webkit' : 'balanced';
}

export class UiRenderOptimizer {
    constructor({
        documentRef = globalThis.document,
        windowRef = globalThis.window,
        navigatorRef = globalThis.navigator,
        matchMedia = globalThis.matchMedia,
        setTimer = globalThis.setTimeout,
        clearTimer = globalThis.clearTimeout,
        requestFrame = callback => globalThis.requestAnimationFrame?.(callback) ?? setTimer(callback, 16),
        cancelFrame = handle => globalThis.cancelAnimationFrame?.(handle) ?? clearTimer(handle),
    } = {}) {
        this.document = documentRef;
        this.window = windowRef;
        this.navigator = navigatorRef;
        this.matchMedia = matchMedia;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.requestFrame = requestFrame;
        this.cancelFrame = cancelFrame;
        this.profile = null;
        this.pending = new Map();
        this.started = false;
        this.onClick = this.onClick.bind(this);
        this.onPageVisible = this.onPageVisible.bind(this);
    }

    start() {
        if (this.started) return this.profile;
        let coarsePointer = false;
        try {
            coarsePointer = Boolean(this.matchMedia?.('(pointer: coarse)')?.matches);
        } catch {
            coarsePointer = false;
        }
        this.profile = detectMobileRenderProfile({
            userAgent: this.navigator?.userAgent,
            platform: this.navigator?.platform,
            maxTouchPoints: this.navigator?.maxTouchPoints,
            coarsePointer,
        });
        if (!this.profile || !this.document?.body) return null;

        this.started = true;
        this.document.body.classList?.add('cla-fast-ui');
        if (this.profile === 'webkit') this.document.body.classList?.add('cla-ui-webkit');
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

        const duration = phase === 'closing'
            ? (this.profile === 'webkit' ? 90 : 110)
            : (this.profile === 'webkit' ? 130 : 150);
        const state = { frame: null, timer: null };
        state.frame = this.requestFrame(() => {
            state.frame = null;
            state.timer = this.setTimer(() => this.clearTransition(content), duration + 64);
        });
        this.pending.set(content, state);
    }

    clearTransition(content) {
        const state = this.pending.get(content);
        if (state?.frame !== null && state?.frame !== undefined) this.cancelFrame(state.frame);
        if (state?.timer !== null && state?.timer !== undefined) this.clearTimer(state.timer);
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
        this.document.body?.classList?.remove('cla-fast-ui', 'cla-ui-webkit');
        this.profile = null;
    }
}
