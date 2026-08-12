import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getQuickReplyRecoveryReason,
    isTouchEnvironment,
    MobileInteractionGuard,
} from '../modules/mobile-interaction-guard.js';

test('enables the mobile guard only for touch or coarse-pointer devices', () => {
    assert.equal(isTouchEnvironment({
        navigatorRef: { maxTouchPoints: 5 },
        matchMedia: () => ({ matches: false }),
    }), true);
    assert.equal(isTouchEnvironment({
        navigatorRef: { maxTouchPoints: 0 },
        matchMedia: () => ({ matches: true }),
    }), true);
    assert.equal(isTouchEnvironment({
        navigatorRef: { maxTouchPoints: 0 },
        matchMedia: () => ({ matches: false }),
    }), false);
});

test('reveals a minimized quick reply runner only after its modal backdrop is tapped', () => {
    const state = {
        open: true,
        quickReplyExecuting: true,
        quickReplyMinimized: true,
    };
    assert.equal(getQuickReplyRecoveryReason(state), null);
    assert.equal(getQuickReplyRecoveryReason({ ...state, backdropTap: true }), 'quick-reply');
    assert.equal(getQuickReplyRecoveryReason({
        open: true,
        backdropTap: true,
        quickReplyHidden: true,
    }), 'quick-reply');
    assert.equal(getQuickReplyRecoveryReason({
        open: true,
        backdropTap: true,
        quickReplyExecuting: false,
        quickReplyMinimized: true,
    }), null);
});

test('releases touch pointer capture without taking over mouse input', () => {
    let released = null;
    const target = {
        hasPointerCapture: () => true,
        releasePointerCapture: pointerId => { released = pointerId; },
        matches: () => false,
    };
    const guard = new MobileInteractionGuard({});
    guard.started = true;
    guard.onPointerEnd({ target, type: 'pointercancel', pointerType: 'touch', pointerId: 7 });
    assert.equal(released, 7);
});

test('expands a hidden running quick reply instead of stopping it', () => {
    const values = new Set(['qr--isExecuting', 'qr--minimized']);
    const quickReply = {
        classList: {
            contains: name => values.has(name),
            remove: name => values.delete(name),
        },
    };
    let maximized = 0;
    const dialogClasses = new Set(['qr--hide']);
    const dialog = {
        matches: selector => selector === 'dialog.popup[open]',
        hasAttribute: name => name === 'open',
        classList: {
            contains: name => dialogClasses.has(name),
            remove: name => dialogClasses.delete(name),
        },
        querySelector(selector) {
            if (selector === '#qr--modalEditor') return quickReply;
            if (selector === '#qr--modal-maximize') return { click: () => { maximized += 1; } };
            return null;
        },
    };
    const guard = new MobileInteractionGuard({});
    guard.started = true;
    guard.onPointerEnd({
        target: dialog,
        type: 'pointerup',
        pointerType: 'touch',
        pointerId: 1,
        cancelable: true,
        preventDefault() {},
        stopImmediatePropagation() {},
    });

    assert.equal(dialogClasses.has('qr--hide'), false);
    assert.equal(values.has('qr--minimized'), false);
    assert.equal(maximized, 1);
});
