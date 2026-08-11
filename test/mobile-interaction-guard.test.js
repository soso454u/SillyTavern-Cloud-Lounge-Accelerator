import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getDialogRecoveryReason,
    isTouchEnvironment,
    MobileInteractionGuard,
} from '../modules/mobile-interaction-guard.js';

function createDialog({ closing = false, loader = false } = {}) {
    const attributes = new Set(['open', ...(closing ? ['closing'] : [])]);
    let closes = 0;
    return {
        isConnected: true,
        classList: { contains: () => false, remove: () => {} },
        hasAttribute: name => attributes.has(name),
        removeAttribute: name => attributes.delete(name),
        querySelector: selector => selector === '#loader' && loader ? {} : null,
        close() {
            closes += 1;
            attributes.delete('open');
        },
        get closes() {
            return closes;
        },
    };
}

test('enables the interaction guard only for touch or coarse-pointer devices', () => {
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

test('recovers only stale popup states and leaves active loaders alone', () => {
    assert.equal(getDialogRecoveryReason({ open: true, closing: true }), 'closing');
    assert.equal(getDialogRecoveryReason({
        open: true,
        knownLoader: true,
        loaderPresent: false,
        activeBlockingLoader: false,
    }), 'orphan-loader');
    assert.equal(getDialogRecoveryReason({
        open: true,
        knownLoader: true,
        loaderPresent: false,
        activeBlockingLoader: true,
    }), null);
    assert.equal(getDialogRecoveryReason({
        open: true,
        knownLoader: true,
        loaderPresent: true,
    }), null);
});

test('reveals a minimized quick reply runner only after its modal backdrop is tapped', () => {
    const state = {
        open: true,
        quickReplyExecuting: true,
        quickReplyMinimized: true,
    };
    assert.equal(getDialogRecoveryReason(state), null);
    assert.equal(getDialogRecoveryReason({ ...state, backdropTap: true }), 'quick-reply');
    assert.equal(getDialogRecoveryReason({
        open: true,
        backdropTap: true,
        quickReplyHidden: true,
    }), 'quick-reply');
    assert.equal(getDialogRecoveryReason({
        open: true,
        backdropTap: true,
        quickReplyExecuting: false,
        quickReplyMinimized: true,
    }), null);
});

test('forces a stale closing dialog out of the native modal layer', async () => {
    const dialog = createDialog({ closing: true });
    const guard = new MobileInteractionGuard({});
    guard.started = true;

    assert.equal(await guard.recoverDialog(dialog, 'closing'), true);
    assert.equal(dialog.closes, 1);
    assert.equal(dialog.hasAttribute('open'), false);
    assert.equal(dialog.hasAttribute('closing'), false);
});

test('does not close an orphaned loader while an official blocking task is active', async () => {
    const dialog = createDialog();
    const guard = new MobileInteractionGuard({
        importActionLoader: async () => ({
            loader: { active: () => [{ isActive: true, isBlocking: true }] },
        }),
    });
    guard.started = true;
    guard.knownLoaderDialogs.add(dialog);

    assert.equal(await guard.recoverDialog(dialog, 'orphan-loader'), false);
    assert.equal(dialog.closes, 0);
});
