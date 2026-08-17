import test from 'node:test';
import assert from 'node:assert/strict';

import { getVisualViewportBottom, MobileViewportGuard } from '../modules/mobile-viewport-guard.js';

function createEventTarget() {
    const listeners = new Map();
    return {
        listeners,
        addEventListener(type, handler) {
            listeners.set(type, handler);
        },
        removeEventListener(type, handler) {
            if (listeners.get(type) === handler) listeners.delete(type);
        },
    };
}

test('calculates the keyboard-safe bottom edge from the visual viewport', () => {
    const windowRef = {
        innerHeight: 900,
        visualViewport: { offsetTop: 12, height: 520 },
        document: { documentElement: { clientHeight: 900 } },
    };
    assert.equal(getVisualViewportBottom(windowRef), 532);
    windowRef.visualViewport.height = 1000;
    assert.equal(getVisualViewportBottom(windowRef), 900);
    assert.equal(getVisualViewportBottom({}), null);
});

test('keeps the chat form above a touch keyboard and cleans up on stop', () => {
    const classNames = new Set();
    const properties = new Map();
    const body = {
        classList: {
            add: name => classNames.add(name),
            remove: name => classNames.delete(name),
        },
        style: {
            setProperty: (name, value) => properties.set(name, value),
            removeProperty: name => properties.delete(name),
        },
    };
    const textarea = {};
    const documentEvents = createEventTarget();
    const viewportEvents = createEventTarget();
    Object.assign(viewportEvents, { offsetTop: 10, height: 500 });
    const windowEvents = createEventTarget();
    const documentRef = {
        ...documentEvents,
        body,
        activeElement: textarea,
        documentElement: { clientHeight: 820 },
        querySelector: selector => selector === '#send_textarea' ? textarea : null,
    };
    const windowRef = {
        ...windowEvents,
        innerHeight: 820,
        document: documentRef,
        visualViewport: viewportEvents,
    };
    const frames = [];
    const guard = new MobileViewportGuard({
        documentRef,
        windowRef,
        navigatorRef: { maxTouchPoints: 5 },
        requestFrame(callback) {
            frames.push(callback);
            return frames.length;
        },
    });

    assert.equal(guard.start(), true);
    assert.equal(classNames.has('cla-chat-keyboard'), true);
    assert.equal(properties.get('--cla-visual-viewport-bottom'), '510px');

    viewportEvents.height = 430;
    viewportEvents.listeners.get('resize')();
    frames.shift()();
    assert.equal(properties.get('--cla-visual-viewport-bottom'), '440px');

    guard.stop();
    assert.equal(classNames.has('cla-chat-keyboard'), false);
    assert.equal(properties.has('--cla-visual-viewport-bottom'), false);
    assert.equal(viewportEvents.listeners.size, 0);
});

test('does not install viewport overrides on a non-touch desktop', () => {
    const guard = new MobileViewportGuard({
        documentRef: { body: {} },
        windowRef: { visualViewport: {} },
        navigatorRef: { maxTouchPoints: 0 },
        matchMediaRef: () => ({ matches: false }),
    });
    assert.equal(guard.start(), false);
});
