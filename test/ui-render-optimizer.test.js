import test from 'node:test';
import assert from 'node:assert/strict';

import { detectMobileRenderProfile, UiRenderOptimizer } from '../modules/ui-render-optimizer.js';

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
    assert.equal(detectMobileRenderProfile({ userAgent: 'iPhone', maxTouchPoints: 5 }), 'webkit');
    assert.equal(detectMobileRenderProfile({ platform: 'MacIntel', maxTouchPoints: 5 }), 'webkit');
    assert.equal(detectMobileRenderProfile({ userAgent: 'Android', maxTouchPoints: 5 }), 'balanced');
    assert.equal(detectMobileRenderProfile({ userAgent: 'Macintosh', maxTouchPoints: 0 }), null);
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
});
