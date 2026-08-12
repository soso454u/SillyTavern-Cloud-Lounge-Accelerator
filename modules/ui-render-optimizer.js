const TRANSITION_CLASSES = ['cla-ui-opening', 'cla-ui-closing'];
const LEGACY_DRAWER_HAS_MARKERS = [
    'body:has(.drawer-content.maximized)',
    'body:has(.drawer-content.open)',
    'body:has(#character_popup.open)',
    '#top-settings-holder:has(.drawer-content.openDrawer:not(.fillLeft):not(.fillRight))',
];

function readCssRules(sheet) {
    try {
        return sheet?.cssRules || null;
    } catch {
        // Cross-origin and browser-managed stylesheets may deny CSSOM access.
        return null;
    }
}

function findRuleIndex(rules, target) {
    if (!rules || !target) return -1;
    for (let index = 0; index < rules.length; index += 1) {
        if (rules[index] === target) return index;
    }
    return -1;
}

export function isLegacyMobileDrawerHasRule(rule) {
    const selector = typeof rule?.selectorText === 'string' ? rule.selectorText : '';
    const zIndex = String(rule?.style?.zIndex || '');
    return zIndex === '4005' && LEGACY_DRAWER_HAS_MARKERS.every(marker => selector.includes(marker));
}

export function patchLegacyMobileDrawerHasRules(documentRef = globalThis.document) {
    const patches = [];
    for (const sheet of Array.from(documentRef?.styleSheets || [])) {
        const rules = readCssRules(sheet);
        if (!rules || typeof sheet.insertRule !== 'function' || typeof sheet.deleteRule !== 'function') continue;

        for (let index = 0; index < rules.length; index += 1) {
            const rule = rules[index];
            if (!isLegacyMobileDrawerHasRule(rule)) continue;

            const originalText = rule.cssText;
            let replacementRule = null;
            try {
                const insertedIndex = sheet.insertRule(
                    `@media (min-width: 1001px) { ${originalText} }`,
                    index + 1,
                );
                replacementRule = readCssRules(sheet)?.[insertedIndex ?? index + 1] || null;
                sheet.deleteRule(index);
            } catch {
                const currentRules = readCssRules(sheet);
                const replacementIndex = findRuleIndex(currentRules, replacementRule);
                if (replacementIndex >= 0) {
                    try {
                        sheet.deleteRule(replacementIndex);
                    } catch {
                        // Leaving the original rule intact is safer than forcing a partial patch.
                    }
                }
                continue;
            }

            patches.push({
                sheet,
                originalText,
                originalIndex: index,
                replacementRule,
            });
        }
    }
    return patches;
}

export function restoreLegacyMobileDrawerHasRules(patches = []) {
    for (const patch of [...patches].reverse()) {
        const rules = readCssRules(patch.sheet);
        const replacementIndex = findRuleIndex(rules, patch.replacementRule);
        if (replacementIndex < 0) continue;

        try {
            patch.sheet.insertRule(patch.originalText, replacementIndex);
            const updatedRules = readCssRules(patch.sheet);
            const shiftedReplacementIndex = findRuleIndex(updatedRules, patch.replacementRule);
            if (shiftedReplacementIndex >= 0) patch.sheet.deleteRule(shiftedReplacementIndex);
        } catch {
            // A page reload restores the source stylesheet if another extension rewrites it first.
        }
    }
}

export function detectRenderProfile({
    userAgent = globalThis.navigator?.userAgent || '',
    platform = globalThis.navigator?.platform || '',
    maxTouchPoints = globalThis.navigator?.maxTouchPoints || 0,
    coarsePointer = false,
} = {}) {
    const touch = Number(maxTouchPoints) > 0 || coarsePointer === true;
    if (!touch) return 'desktop';
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
        this.drawerHasPatches = [];
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
        this.profile = detectRenderProfile({
            userAgent: this.navigator?.userAgent,
            platform: this.navigator?.platform,
            maxTouchPoints: this.navigator?.maxTouchPoints,
            coarsePointer,
        });
        if (!this.profile || !this.document?.body) return null;

        this.started = true;
        this.document.body.classList?.add('cla-fast-ui');
        this.document.body.classList?.add(`cla-ui-${this.profile}`);
        this.drawerHasPatches = patchLegacyMobileDrawerHasRules(this.document);
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

        const durations = {
            desktop: { opening: 160, closing: 130 },
            balanced: { opening: 90, closing: 70 },
            webkit: { opening: 80, closing: 60 },
        };
        const duration = durations[this.profile]?.[phase] ?? durations.desktop[phase];
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
        restoreLegacyMobileDrawerHasRules(this.drawerHasPatches);
        this.drawerHasPatches = [];
        this.document.body?.classList?.remove(
            'cla-fast-ui',
            'cla-ui-desktop',
            'cla-ui-balanced',
            'cla-ui-webkit',
        );
        this.profile = null;
    }
}
