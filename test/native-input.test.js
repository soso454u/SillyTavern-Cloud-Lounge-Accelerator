import test from 'node:test';
import assert from 'node:assert/strict';
import {
    InputRevealGuard,
    isBelowVisualViewport,
    isIosWebKitTouch,
    restoreNativeInputLayout,
} from '../modules/native-input.js';

function element() {
    const classes = new Set(['cla-keyboard-overlay', 'cla-keyboard-closing', 'user-theme']);
    const properties = new Map([['--cla-keyboard-shift', '-320px'], ['height', '70px'], ['translate', '0 2px']]);
    return {
        classes, properties,
        classList: { remove: (...names) => names.forEach(name => classes.delete(name)) },
        style: { removeProperty: name => properties.delete(name) },
    };
}

test('removes old keyboard compensation while preserving user styling, focus and scroll', () => {
    const form = element();
    const body = element();
    const textarea = { value: '未发送的正文', selectionStart: 2, selectionEnd: 5 };
    const doc = { body, activeElement: textarea, querySelector: () => form };
    restoreNativeInputLayout(doc);
    restoreNativeInputLayout(doc);
    for (const target of [form, body]) {
        assert.deepEqual([...target.classes], ['user-theme']);
        assert.deepEqual([...target.properties], [['height', '70px'], ['translate', '0 2px']]);
    }
    assert.equal(doc.activeElement, textarea);
    assert.equal(textarea.value, '未发送的正文');
    assert.equal(textarea.selectionStart, 2);
    assert.equal(textarea.selectionEnd, 5);
});

test('native input cleanup tolerates missing layout during initialization or teardown', () => {
    assert.doesNotThrow(() => restoreNativeInputLayout({ querySelector: () => null }));
});

test('enables focus reveal only for touch WebKit on iPhone and iPad', () => {
    assert.equal(isIosWebKitTouch({
        navigatorRef: { userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1', maxTouchPoints: 5 },
    }), true);
    assert.equal(isIosWebKitTouch({
        navigatorRef: { userAgent: 'Mozilla/5.0 (Macintosh) Safari/604.1', platform: 'MacIntel', maxTouchPoints: 5 },
    }), true);
    assert.equal(isIosWebKitTouch({
        navigatorRef: { userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140', maxTouchPoints: 5 },
    }), false);
    assert.equal(isIosWebKitTouch({
        navigatorRef: { userAgent: 'Mozilla/5.0 (Macintosh) Safari/604.1', platform: 'MacIntel', maxTouchPoints: 0 },
    }), false);
});

test('detects only an input covered by the current visual viewport', () => {
    const windowRef = { visualViewport: { offsetTop: 40, height: 500 } };
    assert.equal(isBelowVisualViewport({
        getBoundingClientRect: () => ({ bottom: 620 }),
    }, windowRef), true);
    assert.equal(isBelowVisualViewport({
        getBoundingClientRect: () => ({ bottom: 530 }),
    }, windowRef), false);
});

function revealFixture() {
    const timers = new Map();
    let nextTimer = 1;
    let reveals = 0;
    const textarea = {
        getBoundingClientRect: () => ({ bottom: 760 }),
        scrollIntoView(options) {
            reveals += 1;
            assert.deepEqual(options, { block: 'nearest', inline: 'nearest', behavior: 'auto' });
        },
    };
    const listeners = new Map();
    const viewportListeners = new Map();
    const documentRef = {
        body: {},
        activeElement: textarea,
        querySelector: selector => selector === '#send_textarea' ? textarea : null,
        addEventListener: (type, handler) => listeners.set(type, handler),
        removeEventListener: type => listeners.delete(type),
    };
    const windowRef = {
        visualViewport: {
            offsetTop: 0,
            height: 500,
            addEventListener: (type, handler) => viewportListeners.set(type, handler),
            removeEventListener: type => viewportListeners.delete(type),
        },
    };
    const guard = new InputRevealGuard({
        documentRef,
        windowRef,
        navigatorRef: { userAgent: 'iPhone', maxTouchPoints: 5 },
        setTimer(callback, delay) {
            const id = nextTimer++;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimer: id => timers.delete(id),
    });
    return { guard, textarea, documentRef, timers, listeners, viewportListeners, reveals: () => reveals };
}

test('reveals a covered chat input as soon as Safari reports its keyboard viewport', () => {
    const fixture = revealFixture();
    assert.equal(fixture.guard.start(), true);
    fixture.guard.onFocusIn({ target: fixture.textarea });
    assert.deepEqual([...fixture.timers.values()].map(item => item.delay), [80, 220, 420, 700]);
    fixture.viewportListeners.get('resize')();
    assert.equal(fixture.reveals(), 1);
    assert.equal(fixture.documentRef.activeElement, fixture.textarea);
});

test('final focus check nudges third-party keyboards even if viewport reporting is stale', () => {
    const fixture = revealFixture();
    fixture.guard.window.visualViewport.height = 900;
    fixture.guard.start();
    fixture.guard.onFocusIn({ target: fixture.textarea });
    const final = [...fixture.timers.values()].find(item => item.delay === 700);
    final.callback();
    assert.equal(fixture.reveals(), 1);
});

test('never reveals or steals focus after the user enters another editor', () => {
    const fixture = revealFixture();
    fixture.guard.start();
    fixture.guard.onFocusIn({ target: fixture.textarea });
    fixture.documentRef.activeElement = { id: 'preset-editor' };
    for (const { callback } of [...fixture.timers.values()]) callback();
    fixture.viewportListeners.get('scroll')();
    assert.equal(fixture.reveals(), 0);
    assert.equal(fixture.documentRef.activeElement.id, 'preset-editor');
});

test('blur and stop cancel pending checks and remove every listener', () => {
    const fixture = revealFixture();
    fixture.guard.start();
    fixture.guard.onFocusIn({ target: fixture.textarea });
    fixture.guard.onFocusOut({ target: fixture.textarea });
    assert.equal(fixture.timers.size, 0);
    fixture.guard.stop();
    assert.equal(fixture.listeners.size, 0);
    assert.equal(fixture.viewportListeners.size, 0);
});
