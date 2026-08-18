import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getVisualViewportBottom,
    getVisualViewportInset,
    MobileViewportGuard,
} from '../modules/mobile-viewport-guard.js';

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
    assert.equal(getVisualViewportInset(windowRef), 368);
    windowRef.visualViewport.height = 1000;
    assert.equal(getVisualViewportBottom(windowRef), 900);
    assert.equal(getVisualViewportInset(windowRef), 0);
    assert.equal(getVisualViewportBottom({}), null);
    assert.equal(getVisualViewportInset({}), null);
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
    let sheldBottom = 820;
    const sheld = { getBoundingClientRect: () => ({ bottom: sheldBottom }) };
    const chat = {
        scrollHeight: 1600,
        scrollTop: 780,
        clientHeight: 820,
        scrollCalls: [],
        scrollTo(left, top) {
            this.scrollCalls.push([left, top]);
            this.scrollTop = top;
        },
    };
    const documentEvents = createEventTarget();
    const viewportEvents = createEventTarget();
    Object.assign(viewportEvents, { offsetTop: 10, height: 500 });
    const windowEvents = createEventTarget();
    const documentRef = {
        ...documentEvents,
        body,
        activeElement: textarea,
        documentElement: { clientHeight: 820 },
        querySelector: selector => ({
            '#send_textarea': textarea,
            '#sheld': sheld,
            '#chat': chat,
        })[selector] || null,
    };
    const windowRef = {
        ...windowEvents,
        innerHeight: 820,
        document: documentRef,
        visualViewport: viewportEvents,
    };
    const frames = [];
    let nextTimer = 1;
    const timers = new Map();
    const guard = new MobileViewportGuard({
        documentRef,
        windowRef,
        navigatorRef: { maxTouchPoints: 5 },
        setTimer(callback, delay) {
            const id = nextTimer++;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimer(id) {
            timers.delete(id);
        },
        requestFrame(callback) {
            frames.push(callback);
            return frames.length;
        },
    });

    assert.equal(guard.start(), true);
    assert.equal(classNames.has('cla-chat-keyboard'), true);
    assert.equal(properties.get('--cla-keyboard-inset'), '310px');
    frames.shift()();
    assert.deepEqual(chat.scrollCalls, [[0, 1600]], 'a chat already at the bottom should remain anchored');

    sheldBottom = 510;
    viewportEvents.height = 430;
    viewportEvents.listeners.get('resize')();
    frames.shift()();
    assert.equal(properties.get('--cla-keyboard-inset'), '380px');
    frames.shift()();

    sheldBottom = 60;
    windowRef.innerHeight = 440;
    documentRef.documentElement.clientHeight = 440;
    viewportEvents.offsetTop = 10;
    viewportEvents.height = 430;
    viewportEvents.listeners.get('resize')();
    frames.shift()();
    assert.equal(properties.get('--cla-keyboard-inset'), '0px', 'a layout already resized for the keyboard must not be lifted twice');
    frames.shift()();

    documentRef.activeElement = null;
    documentEvents.listeners.get('focusout')({ type: 'focusout', target: textarea });
    sheldBottom = 820;
    windowRef.innerHeight = 820;
    documentRef.documentElement.clientHeight = 820;
    viewportEvents.height = 600;
    viewportEvents.listeners.get('resize')();
    frames.shift()();
    assert.equal(properties.get('--cla-keyboard-inset'), '210px', 'closing animation should keep following the visible viewport');
    frames.shift()();

    sheldBottom = 610;
    viewportEvents.height = 810;
    viewportEvents.listeners.get('resize')();
    frames.shift()();
    assert.equal(properties.get('--cla-keyboard-inset'), '0px');
    assert.equal(classNames.has('cla-chat-keyboard'), true, 'zero overlap must remain stable briefly before cleanup');
    frames.shift()();
    const stableTimer = [...timers].find(([, task]) => task.delay === 120);
    assert.ok(stableTimer, 'keyboard close should be confirmed from a stable viewport instead of a fixed animation duration');
    timers.delete(stableTimer[0]);
    stableTimer[1].callback();
    assert.equal(classNames.has('cla-chat-keyboard'), false);
    assert.equal(properties.has('--cla-keyboard-inset'), false);
    assert.equal([...timers.values()].some(task => task.delay === 1800), false, 'stable close should cancel the fallback timer');

    guard.stop();
    assert.equal(classNames.has('cla-chat-keyboard'), false);
    assert.equal(properties.has('--cla-keyboard-inset'), false);
    assert.equal(viewportEvents.listeners.size, 0);
});

test('uses the same viewport guard on iOS, Android, and Windows touch devices', () => {
    for (const userAgent of [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
        'Mozilla/5.0 (Linux; Android 15; Pixel 9)',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Touch)',
    ]) {
        const documentEvents = createEventTarget();
        const viewportEvents = createEventTarget();
        Object.assign(viewportEvents, { offsetTop: 0, height: 800 });
        const windowEvents = createEventTarget();
        const body = {
            classList: { add() {}, remove() {} },
            style: { setProperty() {}, removeProperty() {} },
        };
        const documentRef = {
            ...documentEvents,
            body,
            activeElement: null,
            documentElement: { clientHeight: 800 },
            querySelector: () => null,
        };
        const guard = new MobileViewportGuard({
            documentRef,
            windowRef: {
                ...windowEvents,
                innerHeight: 800,
                document: documentRef,
                visualViewport: viewportEvents,
            },
            navigatorRef: { maxTouchPoints: 5, userAgent },
            requestFrame: () => 1,
            cancelFrame() {},
        });

        assert.equal(guard.start(), true, userAgent);
        guard.stop();
    }
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
