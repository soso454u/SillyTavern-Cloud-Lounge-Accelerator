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
