import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    detectRenderProfile,
    UiRenderOptimizer,
} from '../modules/ui-render-optimizer.js';

const LEGACY_SELECTOR = [
    'body:has(.drawer-content.maximized) #top-settings-holder:has(.drawer-content.openDrawer:not(.fillLeft):not(.fillRight))',
    'body:has(.drawer-content.open) #top-settings-holder:has(.drawer-content.openDrawer:not(.fillLeft):not(.fillRight))',
    'body:has(#character_popup.open) #top-settings-holder:has(.drawer-content.openDrawer:not(.fillLeft):not(.fillRight))',
].join(', ');

function styleRule(cssText = `${LEGACY_SELECTOR} { z-index: 4005; }`) {
    return {
        cssText,
        selectorText: LEGACY_SELECTOR,
        style: { zIndex: '4005' },
    };
}

function classList(initial = []) {
    const values = new Set(initial);
    return {
        add: (...names) => names.forEach(name => values.add(name)),
        remove: (...names) => names.forEach(name => values.delete(name)),
        contains: name => values.has(name),
        values,
    };
}

test('selects WebKit, balanced, and desktop render profiles automatically', () => {
    assert.equal(detectRenderProfile({ userAgent: 'iPhone', maxTouchPoints: 5 }), 'webkit');
    assert.equal(detectRenderProfile({ platform: 'MacIntel', maxTouchPoints: 5 }), 'webkit');
    assert.equal(detectRenderProfile({ userAgent: 'Android', maxTouchPoints: 5 }), 'balanced');
    assert.equal(detectRenderProfile({ userAgent: 'Macintosh', maxTouchPoints: 0 }), 'desktop');
});

test('marks only the active top drawer and cleans temporary render hints', () => {
    const bodyClasses = classList();
    const contentClasses = classList(['openDrawer']);
    const content = { classList: contentClasses };
    const drawer = { querySelector: () => content };
    const toggle = { closest: selector => selector === '.drawer' ? drawer : toggle };
    const target = { closest: () => toggle };
    let frameCallback = null;
    let timerCallback = null;
    const documentRef = {
        body: { classList: bodyClasses },
        styleSheets: [{ cssRules: [styleRule()] }],
        addEventListener() {},
        removeEventListener() {},
        querySelectorAll: () => [content],
    };
    const optimizer = new UiRenderOptimizer({
        documentRef,
        navigatorRef: { userAgent: 'iPhone', maxTouchPoints: 5 },
        matchMedia: () => ({ matches: true }),
        requestFrame(callback) {
            frameCallback = callback;
            return 1;
        },
        cancelFrame() {},
        setTimer(callback) {
            timerCallback = callback;
            return 2;
        },
        clearTimer() {},
    });

    assert.equal(optimizer.start(), 'webkit');
    optimizer.onClick({ target });
    assert.equal(contentClasses.contains('cla-ui-closing'), true);
    assert.equal(bodyClasses.contains('cla-fast-ui'), true);
    assert.equal(bodyClasses.contains('cla-ui-webkit'), true);
    assert.equal(documentRef.styleSheets[0].cssRules[0].selectorText, LEGACY_SELECTOR);
    assert.equal(frameCallback, null);
    timerCallback();
    assert.equal(contentClasses.contains('cla-ui-closing'), false);
    optimizer.stop();
    assert.equal(bodyClasses.contains('cla-fast-ui'), false);
    assert.equal(bodyClasses.contains('cla-ui-webkit'), false);
    assert.equal(documentRef.styleSheets[0].cssRules[0].selectorText, LEGACY_SELECTOR);
});

for (const environment of [
    { userAgent: 'iPhone', maxTouchPoints: 5 },
    { userAgent: 'Android', maxTouchPoints: 5 },
    { userAgent: 'Macintosh', maxTouchPoints: 0 },
]) {
    test(`preserves native drawer stacking across start/stop on ${environment.userAgent}`, () => {
        const rule = styleRule();
        const sheet = {
            cssRules: [rule],
            insertRule() { assert.fail('must not rewrite native stacking rules'); },
            deleteRule() { assert.fail('must not remove native stacking rules'); },
        };
        const optimizer = new UiRenderOptimizer({
            documentRef: {
                body: { classList: classList() },
                styleSheets: [sheet],
                addEventListener() {},
                removeEventListener() {},
            },
            navigatorRef: environment,
            matchMedia: () => ({ matches: environment.maxTouchPoints > 0 }),
        });
        optimizer.start();
        assert.equal(sheet.cssRules[0], rule);
        assert.equal(rule.style.zIndex, '4005');
        optimizer.stop();
        optimizer.start();
        optimizer.stop();
        assert.equal(sheet.cssRules.length, 1);
        assert.equal(sheet.cssRules[0], rule);
    });
}

test('styles desktop, popup lifecycle, and native sortable helpers without global layers', async () => {
    const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(styles, /@media \(prefers-reduced-motion: no-preference\)/);
    assert.match(styles, /cla-ui-desktop[\s\S]*transition-duration: 160ms/);
    assert.match(styles, /dialog\.popup\[closing\]/);
    assert.match(styles, /--popup-animation-speed: 130ms/);
    assert.match(styles, /:has\(\.ui-sortable-helper, \.sortable-drag, \.sortable-chosen\)/);
    assert.doesNotMatch(styles, /will-change:\s*height/);
    assert.match(styles, /@media \(max-width: 1000px\) and \(pointer: coarse\)/);
    assert.doesNotMatch(styles, /cla-keyboard-overlay|--cla-keyboard-shift/);
    assert.match(styles, /transition-property:\s*opacity, transform, display/);
    assert.match(styles, /height:\s*auto !important/);
    assert.doesNotMatch(styles, /(?:cla-ui-closing|dialog\.popup\[closing\])[^{}]*\{[^}]*pointer-events:\s*none/);
    assert.match(styles, /@starting-style/);
    assert.match(styles, /drawer-content:is\(\.cla-ui-opening, \.cla-ui-closing\)[\s\S]*will-change:\s*transform, opacity/);
});
