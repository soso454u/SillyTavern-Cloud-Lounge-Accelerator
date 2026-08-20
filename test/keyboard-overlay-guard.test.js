import test from 'node:test';
import assert from 'node:assert/strict';

import {
    calculateKeyboardLift,
    getCloseSnapThreshold,
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

test('uses a bounded closing snap threshold for short and tall input panels', () => {
    assert.equal(getCloseSnapThreshold(80), 48);
    assert.equal(getCloseSnapThreshold(320), 80);
    assert.equal(getCloseSnapThreshold(900), 96);
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
    const timers = new Map();
    let nextTimer = 1;
    const textarea = {};
    let formBottom = 1000;
    const form = {
        getBoundingClientRect: () => ({ bottom: formBottom, height: 320 }),
        classList: {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            contains: name => classes.has(name),
        },
        style: {
            setProperty: (name, value) => properties.set(name, value),
            removeProperty: name => properties.delete(name),
        },
    };
    const listeners = new Map();
    const viewportListeners = new Map();
    const documentRef = {
        activeElement: textarea,
        body: {
            classList: {},
            style: {},
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
        setTimer(callback, delay) {
            const id = nextTimer++;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimer: id => timers.delete(id),
    });

    assert.equal(guard.start(), true);
    assert.equal(classes.has('cla-keyboard-overlay'), true);
    assert.equal(properties.get('--cla-keyboard-shift'), '-400px');

    formBottom = 600;
    guard.sync();
    assert.equal(properties.get('--cla-keyboard-shift'), '-400px', 'the existing transform must not be applied twice');

    documentRef.activeElement = null;
    guard.onFocusChange({ type: 'focusout', target: textarea });
    const release = [...timers.values()].find(timer => timer.delay === 160);
    release.callback();
    assert.equal(properties.get('--cla-keyboard-shift'), '0px', 'a missed viewport close event must still start the form return');
    assert.equal(classes.has('cla-keyboard-closing'), true);

    const cleanup = [...timers.values()].find(timer => timer.delay === 80);
    cleanup.callback();
    assert.equal(classes.has('cla-keyboard-overlay'), false);
    assert.equal(properties.has('--cla-keyboard-shift'), false);

    guard.stop();
    assert.equal(classes.has('cla-keyboard-overlay'), false);
    assert.equal(properties.has('--cla-keyboard-shift'), false);
});
