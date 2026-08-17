import test from 'node:test';
import assert from 'node:assert/strict';

import {
    describeInteractionBlocker,
    detectInteractionEnvironment,
    getStaleLegacyOverlay,
    InteractionRecoveryGuard,
    isControlActionable,
    isDialogVisuallyHidden,
} from '../modules/interaction-recovery-guard.js';

function createDialog({ closing = false, loader = false } = {}) {
    const attributes = new Set(['open', ...(closing ? ['closing'] : [])]);
    let closes = 0;
    const dialog = {
        isConnected: true,
        classList: { contains: () => false },
        closest: selector => selector === 'dialog.popup[open]' ? dialog : null,
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
    return dialog;
}

function createTextarea() {
    const control = {
        isConnected: true,
        disabled: false,
        readOnly: false,
        inert: false,
        closest: selector => selector === '#send_textarea' ? control : null,
        getBoundingClientRect: () => ({ left: 10, right: 210, top: 300, bottom: 350, width: 200, height: 50 }),
        focus() {},
    };
    return control;
}

const visibleWindow = {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', pointerEvents: 'auto' }),
    addEventListener() {},
    removeEventListener() {},
};

test('accepts only visible, editable, non-inert controls for focus recovery', () => {
    const textarea = createTextarea();
    assert.equal(isControlActionable(textarea, { windowRef: visibleWindow }), true);
    textarea.readOnly = true;
    assert.equal(isControlActionable(textarea, { windowRef: visibleWindow }), false);
    textarea.readOnly = false;
    textarea.closest = selector => selector === '[inert]' ? {} : textarea;
    assert.equal(isControlActionable(textarea, { windowRef: visibleWindow }), false);
});

test('describes only an open popup that can actually block interaction', () => {
    const dialog = createDialog({ closing: true });
    dialog.closest = selector => selector === 'dialog.popup[open]' ? dialog : null;
    assert.equal(describeInteractionBlocker(dialog), 'dialog.popup[closing]');
    assert.equal(describeInteractionBlocker({ closest: () => null }), null);
});

test('records browser and input environment without using it as a recovery gate', () => {
    assert.equal(detectInteractionEnvironment({
        userAgent: 'Mozilla/5.0 Chrome/140.0 Mobile',
        maxTouchPoints: 5,
    }), 'Chrome · Touch');
    assert.equal(detectInteractionEnvironment({
        userAgent: 'Mozilla/5.0 Firefox/142.0',
        maxTouchPoints: 0,
    }), 'Firefox · Desktop');
});

test('observes body structure only and scopes attributes to popup dialogs on every platform', () => {
    const observations = [];
    class FakeObserver {
        constructor(callback) {
            this.callback = callback;
        }
        observe(target, options) {
            observations.push({ target, options });
        }
        disconnect() {}
    }
    const dialog = createDialog();
    const body = {};
    const documentRef = {
        body,
        addEventListener() {},
        removeEventListener() {},
        querySelectorAll: selector => selector === 'dialog.popup' ? [dialog] : [],
    };
    const guard = new InteractionRecoveryGuard({
        documentRef,
        windowRef: visibleWindow,
        mutationObserver: FakeObserver,
    });

    assert.equal(guard.start(), true);
    assert.deepEqual(observations[0], {
        target: body,
        options: { subtree: true, childList: true },
    });
    assert.equal(observations[1].target, dialog);
    assert.deepEqual(observations[1].options, {
        attributes: true,
        attributeFilter: ['open', 'closing', 'class', 'style'],
    });
    assert.equal(observations[2].target, dialog);
    assert.deepEqual(observations[2].options, {
        subtree: true,
        childList: true,
    });
    guard.stop();
});

test('remembers transient loader content and coalesces repeated dialog changes per frame', () => {
    let queued = null;
    let scans = 0;
    const dialog = createDialog({ closing: true });
    const guard = new InteractionRecoveryGuard({
        now: () => 500,
        requestFrame(callback) {
            queued = callback;
            return 7;
        },
    });
    guard.started = true;
    guard.scanDialogs = () => { scans += 1; };

    guard.onDialogMutations(dialog, [{
        type: 'childList',
        addedNodes: [{ id: 'loader' }],
    }, {
        type: 'attributes',
        attributeName: 'closing',
    }]);
    guard.scheduleScan();

    assert.equal(guard.knownLoaderDialogs.has(dialog), true);
    assert.equal(guard.closingSince.get(dialog), 500);
    assert.equal(scans, 0);
    queued();
    assert.equal(scans, 1);
    assert.equal(guard.scanHandle, null);
});

test('recovers a stale closing popup on desktop without touching a valid modal', async () => {
    const recovered = [];
    const dialog = createDialog({ closing: true });
    dialog.closest = selector => selector === 'dialog.popup[open]' ? dialog : null;
    const guard = new InteractionRecoveryGuard({ onRecovered: value => recovered.push(value) });
    guard.started = true;

    assert.equal(await guard.recoverDialog(dialog, 'closing'), true);
    assert.equal(dialog.closes, 1);
    assert.equal(recovered[0].reason, '残留关闭弹窗');
    assert.equal(recovered[0].blocker, 'dialog.popup[closing]');

    const validDialog = createDialog();
    assert.equal(await guard.recoverDialog(validDialog, 'closing'), false);
    assert.equal(validDialog.closes, 0);
});

test('leaves an orphaned loader alone while an official blocking task remains active', async () => {
    const dialog = createDialog();
    const guard = new InteractionRecoveryGuard({
        importActionLoader: async () => ({
            loader: { active: () => [{ isActive: true, isBlocking: true }] },
        }),
    });
    guard.started = true;
    guard.knownLoaderDialogs.add(dialog);

    assert.equal(await guard.recoverDialog(dialog, 'orphan-loader'), false);
    assert.equal(dialog.closes, 0);
});

test('recovers an open modal only after it remains visually hidden', async () => {
    const dialog = createDialog();
    dialog.getBoundingClientRect = () => ({ width: 0, height: 0 });
    const recovered = [];
    const guard = new InteractionRecoveryGuard({
        windowRef: visibleWindow,
        onRecovered: value => recovered.push(value),
    });
    guard.started = true;
    guard.hiddenSince.set(dialog, 0);

    assert.equal(isDialogVisuallyHidden(dialog, { windowRef: visibleWindow }), true);
    assert.equal(await guard.recoverDialog(dialog, 'hidden-dialog'), true);
    assert.equal(dialog.closes, 1);
    assert.equal(recovered[0].reason, '不可见弹窗');
    assert.equal(recovered[0].blocker, 'dialog.popup[open][hidden]');
});

test('removes a legacy shadow only when its matching popup is no longer rendered', () => {
    const overlay = {
        id: 'shadow_popup',
        isConnected: true,
        style: { display: 'block' },
        closest: selector => selector.includes('#shadow_popup') ? overlay : null,
    };
    const hiddenPopup = { isConnected: false };
    const documentRef = {
        querySelector: selector => selector === '#dialogue_popup' ? hiddenPopup : null,
    };
    const recovered = [];
    const guard = new InteractionRecoveryGuard({
        documentRef,
        windowRef: visibleWindow,
        onRecovered: value => recovered.push(value),
    });
    guard.started = true;

    assert.equal(getStaleLegacyOverlay(overlay, { documentRef, windowRef: visibleWindow }), overlay);
    assert.equal(guard.recoverLegacyOverlay(overlay), true);
    assert.equal(overlay.style.display, 'none');
    assert.equal(recovered[0].reason, '残留页面遮罩');
});

test('keeps a legacy shadow while its matching popup is visible', () => {
    const overlay = {
        id: 'shadow_popup',
        isConnected: true,
        closest: selector => selector.includes('#shadow_popup') ? overlay : null,
    };
    const popup = {
        isConnected: true,
        getBoundingClientRect: () => ({ width: 300, height: 200 }),
    };
    const documentRef = { querySelector: () => popup };
    assert.equal(getStaleLegacyOverlay(overlay, { documentRef, windowRef: visibleWindow }), null);
});

test('recognizes a transparent legacy parent as stale even while its child has a rect', () => {
    const overlay = {
        id: 'shadow_popup',
        isConnected: true,
        parentElement: null,
        closest: selector => selector.includes('#shadow_popup') ? overlay : null,
    };
    const popup = {
        isConnected: true,
        parentElement: overlay,
        getBoundingClientRect: () => ({ width: 300, height: 200 }),
    };
    const windowRef = {
        getComputedStyle: element => ({
            display: 'block',
            visibility: 'visible',
            pointerEvents: 'auto',
            opacity: element === overlay ? '0' : '1',
        }),
    };
    const documentRef = { querySelector: () => popup };
    assert.equal(getStaleLegacyOverlay(overlay, { documentRef, windowRef }), overlay);
});

test('restores the chat textarea only after the user explicitly taps a failed focus target', async () => {
    const textarea = createTextarea();
    const documentRef = {
        body: {},
        activeElement: null,
        querySelector(selector) {
            if (selector === '#send_textarea') return textarea;
            return null;
        },
    };
    textarea.focus = () => { documentRef.activeElement = textarea; };
    const recovered = [];
    const guard = new InteractionRecoveryGuard({
        documentRef,
        windowRef: visibleWindow,
        onRecovered: value => recovered.push(value),
    });
    guard.started = true;

    await guard.onPointerEnd({ type: 'pointerup', button: 0, target: textarea });
    assert.equal(documentRef.activeElement, textarea);
    assert.equal(recovered[0].reason, '输入焦点');
});

test('does not report recovery when the browser focuses the textarea during the same tap', async () => {
    const textarea = createTextarea();
    const recovered = [];
    const documentRef = {
        body: {},
        activeElement: null,
        querySelector: selector => selector === '#send_textarea' ? textarea : null,
    };
    const guard = new InteractionRecoveryGuard({
        documentRef,
        windowRef: visibleWindow,
        onRecovered: value => recovered.push(value),
        scheduleMicrotask(callback) {
            documentRef.activeElement = textarea;
            callback();
        },
    });
    guard.started = true;

    await guard.onPointerEnd({ type: 'pointerup', button: 0, target: textarea });
    assert.deepEqual(recovered, []);
});

test('never pulls focus behind a legitimate open modal', async () => {
    const textarea = createTextarea();
    let focuses = 0;
    textarea.focus = () => { focuses += 1; };
    const documentRef = {
        body: {},
        activeElement: null,
        querySelector(selector) {
            if (selector === '#send_textarea') return textarea;
            if (selector === 'dialog.popup[open]:not([closing])') return createDialog();
            return null;
        },
    };
    const guard = new InteractionRecoveryGuard({ documentRef, windowRef: visibleWindow });
    guard.started = true;

    await guard.onPointerEnd({ type: 'pointerup', button: 0, target: textarea });
    assert.equal(focuses, 0);
});

test('hit-tests a stale modal backdrop over the textarea and never replays a button click', async () => {
    const textarea = createTextarea();
    const dialog = createDialog({ closing: true });
    dialog.closest = selector => selector === 'dialog.popup[open]' ? dialog : null;
    const documentRef = {
        body: {},
        activeElement: null,
        querySelector: selector => selector === '#send_textarea' ? textarea : null,
        elementFromPoint: () => dialog,
    };
    textarea.focus = () => { documentRef.activeElement = textarea; };
    const guard = new InteractionRecoveryGuard({
        documentRef,
        windowRef: visibleWindow,
        now: () => 1000,
        requestFrame: callback => { callback(); return 1; },
    });
    guard.started = true;
    guard.closingSince.set(dialog, 0);

    await guard.onPointerEnd({
        type: 'pointerup',
        button: 0,
        target: dialog,
        clientX: 100,
        clientY: 320,
    });

    assert.equal(dialog.closes, 1);
    assert.equal(documentRef.activeElement, textarea);
});

test('removes a confirmed stale blocker over any button without replaying the click', async () => {
    const textarea = createTextarea();
    const dialog = createDialog({ closing: true });
    const documentRef = {
        body: {},
        activeElement: null,
        querySelector: selector => selector === '#send_textarea' ? textarea : null,
        elementFromPoint: () => dialog,
    };
    let textareaFocuses = 0;
    textarea.focus = () => { textareaFocuses += 1; };
    const guard = new InteractionRecoveryGuard({
        documentRef,
        windowRef: visibleWindow,
        now: () => 1000,
    });
    guard.started = true;
    guard.closingSince.set(dialog, 0);

    await guard.onPointerEnd({
        type: 'pointerup',
        button: 0,
        target: dialog,
        clientX: 20,
        clientY: 20,
    });

    assert.equal(dialog.closes, 1);
    assert.equal(textareaFocuses, 0);
});
