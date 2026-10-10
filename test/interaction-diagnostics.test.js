import test from 'node:test';
import assert from 'node:assert/strict';

import {
    classifyInteractionAnomaly,
    describeSafeElement,
    InteractionDiagnostics,
} from '../modules/interaction-diagnostics.js';

function memoryStorage() {
    const values = new Map();
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
}

test('classifies distinct click failure paths without changing the event', () => {
    assert.equal(classifyInteractionAnomaly({ pointerCaptureStuck: true }), 'pointer-capture-residual');
    assert.equal(classifyInteractionAnomaly({ blocker: 'dialog-backdrop' }), 'hit-blocker');
    assert.equal(classifyInteractionAnomaly({ issues: ['disabled'] }), 'control-disabled');
    assert.equal(classifyInteractionAnomaly({ issues: ['pointer-events-none'] }), 'control-not-hittable');
    assert.equal(classifyInteractionAnomaly({ phases: { downCapture: true } }), 'propagation-stopped');
    assert.equal(classifyInteractionAnomaly({ actionable: true, phases: { upCapture: true, upBubble: true } }), 'click-missing');
    assert.equal(classifyInteractionAnomaly({
        actionable: true,
        phases: { downCapture: true, downBubble: true, upCapture: true, upBubble: true, clickCapture: true, clickBubble: true },
    }), null);
    assert.equal(classifyInteractionAnomaly({
        actionable: true,
        issues: ['pointer-events-none'],
        phases: { downCapture: true, downBubble: true, upCapture: true, upBubble: true, clickCapture: true, clickBubble: true },
    }), null);
    assert.equal(classifyInteractionAnomaly({
        actionable: true,
        issues: ['pointer-events-none'],
        phases: { downCapture: true, downBubble: true, upCapture: true, upBubble: true },
    }), 'control-not-hittable');
});

test('safe element identifiers omit text, attributes, and unsafe dynamic ids', () => {
    const element = {
        localName: 'button',
        id: 'secret/value?token=123',
        classList: new Set(['menu_button', 'fa-copy', 'unsafe/value']),
        textContent: 'private message body',
    };
    assert.equal(describeSafeElement(element), 'button.menu_button.fa-copy');
});

test('a custom close icon with a completed click is not a propagation failure', () => {
    assert.equal(classifyInteractionAnomaly({
        actionable: false,
        issues: [],
        phases: { downCapture: true, clickCapture: true, clickBubble: true },
    }), null);
    assert.equal(classifyInteractionAnomaly({
        actionable: false,
        phases: { downCapture: true, clickCapture: true },
    }), 'propagation-stopped');
});

test('persists only a bounded diagnostic snapshot that survives a new instance', () => {
    const storage = memoryStorage();
    const diagnostics = new InteractionDiagnostics({ storage, now: () => 1000 });
    diagnostics.events = Array.from({ length: 60 }, (_, index) => ({ at: index, type: 'selectionchange' }));
    diagnostics.persistAnomaly('click-missing', {
        pointerType: 'touch',
        target: 'button#send_but',
        path: ['button#send_but', 'form#form_sheld'],
        hitStack: ['button#send_but'],
        actionable: true,
        blocker: null,
        issues: [],
        phases: { upCapture: true, upBubble: true },
        elementState: [],
        popups: [],
    });

    const restored = new InteractionDiagnostics({ storage }).getReport();
    assert.equal(restored.kind, 'click-missing');
    assert.equal(restored.pointer.target, 'button#send_but');
    assert.equal(restored.events.length, 16);
    assert.equal(JSON.stringify(restored).includes('private message body'), false);
});

test('distinguishes resource load errors and preserves a more valuable recent anomaly', () => {
    const storage = memoryStorage();
    const diagnostics = new InteractionDiagnostics({ storage, now: () => 2000 });
    diagnostics.onError({ type: 'error', target: { localName: 'img' }, filename: '/img/avatar.png' });
    assert.equal(diagnostics.events[0].sourceType, 'resource');
    assert.equal(diagnostics.events[0].resourceTag, 'img');

    diagnostics.persistAnomaly('business-exception', null);
    diagnostics.persistAnomaly('unconfirmed', null);
    assert.equal(diagnostics.getReport().kind, 'business-exception');
});

test('ordinary taps cannot erase failure evidence after 30 seconds or a restart', () => {
    const storage = memoryStorage();
    new InteractionDiagnostics({ storage, now: () => 1000 }).persistAnomaly('click-missing', null);
    const diagnostics = new InteractionDiagnostics({ storage, now: () => 90000 });
    diagnostics.lastClipboardActivityAt = 100;
    diagnostics.persistAnomaly('unconfirmed', null);
    assert.equal(diagnostics.getReport().kind, 'click-missing');
});

test('resource failures do not become business exceptions and errors use the newest pointer', () => {
    const diagnostics = new InteractionDiagnostics({ storage: memoryStorage(), monotonicNow: () => 1000 });
    diagnostics.lastUserState = { startedAt: 500, target: 'button#old' };
    diagnostics.activePointer = { startedAt: 900, target: 'button#send_but' };
    diagnostics.onError({ type: 'error', target: { localName: 'img' } });
    assert.equal(diagnostics.getReport(), null);
    diagnostics.onError({ type: 'error', error: new TypeError(), filename: '/script.js' });
    assert.equal(diagnostics.getReport().pointer.target, 'button#send_but');
});
