import test from 'node:test';
import assert from 'node:assert/strict';

import {
    calculateKeyboardLift,
    getVisualViewportBottom,
    KeyboardOverlayGuard,
} from '../modules/keyboard-overlay-guard.js';

test('measures only the part of the form that is actually below the visual viewport', () => {
    assert.equal(calculateKeyboardLift({ formBottom: 1000, viewportBottom: 620 }), 380);
    assert.equal(calculateKeyboardLift({ formBottom: 620, viewportBottom: 620 }), 0);
    assert.equal(calculateKeyboardLift({ formBottom: 618, viewportBottom: 620 }), 0);
});

test('does not compound a transform already applied to the input form', () => {
    assert.equal(calculateKeyboardLift({ formBottom: 620, viewportBottom: 620, appliedLift: 380 }), 380);
});

test('uses visual viewport layout coordinates and clamps them to the page', () => {
    const windowRef = {
        innerHeight: 1000,
        document: { documentElement: { clientHeight: 1000 } },
        visualViewport: { offsetTop: 100, height: 540 },
    };
    assert.equal(getVisualViewportBottom(windowRef), 640);
    windowRef.visualViewport.height = 1200;
    assert.equal(getVisualViewportBottom(windowRef), 1000);
});

test('lifts only the form on an overlay keyboard and cleans up without scrolling', () => {
    const classes = new Set();
    const properties = new Map();
    const textarea = {};
    let formBottom = 1000;
    const form = { getBoundingClientRect: () => ({ bottom: formBottom }) };
    const listeners = new Map();
    const viewportListeners = new Map();
    const documentRef = {
        activeElement: textarea,
        body: {
            classList: {
                add: name => classes.add(name),
                remove: name => classes.delete(name),
                contains: name => classes.has(name),
            },
            style: {
                setProperty: (name, value) => properties.set(name, value),
                removeProperty: name => properties.delete(name),
            },
        },
        querySelector(selector) {
            if (selector === '#send_textarea') return textarea;
            if (selector === '#form_sheld') return form;
            return null;
        },
        addEventListener: (type, handler) => listeners.set(type, handler),
        removeEventListener: type => listeners.delete(type),
    };
    const windowRef = {
        innerHeight: 1000,
        document: { documentElement: { clientHeight: 1000 } },
        visualViewport: {
            offsetTop: 0,
            height: 600,
            addEventListener: (type, handler) => viewportListeners.set(type, handler),
            removeEventListener: type => viewportListeners.delete(type),
        },
        addEventListener() {},
        removeEventListener() {},
    };
    const guard = new KeyboardOverlayGuard({
        documentRef,
        windowRef,
        navigatorRef: { maxTouchPoints: 5 },
        requestFrame: callback => callback(),
        cancelFrame() {},
    });

    assert.equal(guard.start(), true);
    assert.equal(classes.has('cla-keyboard-overlay'), true);
    assert.equal(properties.get('--cla-keyboard-shift'), '-400px');

    formBottom = 600;
    guard.sync();
    assert.equal(properties.get('--cla-keyboard-shift'), '-400px', 'the existing transform must not be applied twice');

    windowRef.visualViewport.height = 1000;
    guard.sync();
    assert.equal(classes.has('cla-keyboard-overlay'), false, 'the form must return immediately as the viewport expands');
    assert.equal(properties.has('--cla-keyboard-shift'), false);

    guard.stop();
    assert.equal(classes.has('cla-keyboard-overlay'), false);
    assert.equal(properties.has('--cla-keyboard-shift'), false);
});
