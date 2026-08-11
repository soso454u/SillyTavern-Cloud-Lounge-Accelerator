import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { detectRenderProfile, UiRenderOptimizer } from '../modules/ui-render-optimizer.js';

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
    frameCallback();
    timerCallback();
    assert.equal(contentClasses.contains('cla-ui-closing'), false);
    optimizer.stop();
    assert.equal(bodyClasses.contains('cla-fast-ui'), false);
    assert.equal(bodyClasses.contains('cla-ui-webkit'), false);
});

test('styles desktop, popup lifecycle, and native sortable helpers without global layers', async () => {
    const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(styles, /@media \(prefers-reduced-motion: no-preference\)/);
    assert.match(styles, /cla-ui-desktop[\s\S]*transition-duration: 160ms/);
    assert.match(styles, /dialog\.popup\[closing\]/);
    assert.match(styles, /--popup-animation-speed: 130ms/);
    assert.match(styles, /:has\(\.ui-sortable-helper, \.sortable-drag, \.sortable-chosen\)/);
    assert.doesNotMatch(styles, /\.drawer-content\s*\{[^}]*will-change/s);
});
