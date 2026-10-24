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

test('native code-copy pointerup is not misreported for its intentional stopped click', () => {
    assert.equal(classifyInteractionAnomaly({
        actionable:true, pointerUpAction:true,
        phases:{downCapture:true,downBubble:true,upCapture:true,upBubble:true,clickCapture:true},
    }),null);
    assert.equal(classifyInteractionAnomaly({
        actionable:true, pointerUpAction:true,
        phases:{downCapture:true,upCapture:true},
    }),'propagation-stopped');
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

test('normal pointer capture and completed clicks perform no layout reads or hit tests', () => {
    const timers = new Map();
    let next = 0;
    let reads = 0;
    const diagnostics = new InteractionDiagnostics({
        storage: memoryStorage(),
        windowRef: { getComputedStyle() { reads++; return {}; } },
        documentRef: {
            elementsFromPoint() { reads++; return []; },
            elementFromPoint() { reads++; return null; },
            querySelectorAll() { reads++; return []; },
        },
        monotonicNow: () => 100,
        setTimer(callback) { const id = ++next; timers.set(id, callback); return id; },
        clearTimer(id) { timers.delete(id); },
    });
    diagnostics.started = true;
    const target = { localName: 'button', classList: [], isConnected: true, closest: selector => selector.includes('button') ? target : null };
    for (const type of ['pointerdown', 'pointerup', 'click']) {
        for (const phase of ['capture', 'bubble']) diagnostics.onPointerEvent({ type, target, pointerId: 1, clientX: 1, clientY: 1 }, phase);
    }
    assert.equal(reads, 0);
    assert.equal(diagnostics.delayTimers.size, 1, 'pointerup and click share one delay timer');
    for (const callback of [...timers.values()]) callback();
    assert.equal(reads, 0, 'successful clicks do not need a deferred style snapshot either');
    assert.equal(diagnostics.activePointer.targetElement, null, 'release the message DOM after analysis');
    diagnostics.stop();
    assert.equal(diagnostics.delayTimers.size, 0);
});

test('a failed control receives a deferred snapshot and a cancelled pointer releases DOM references', () => {
    let reads = 0;
    const diagnostics = new InteractionDiagnostics({
        windowRef: { getComputedStyle() { reads++; return {display:'block'}; } },
        documentRef: { elementsFromPoint: () => [], querySelectorAll: () => [] },
        monotonicNow: () => 1,
    });
    const target = { localName: 'button', closest: () => null, isConnected: true };
    const state = diagnostics.createPointerState({target,clientX:1,clientY:1,pointerId:2});
    assert.equal(reads, 0);
    diagnostics.inspectPointerState(state);
    assert.equal(reads, 1);
    diagnostics.inspectPointerState(state);
    assert.equal(reads, 1, 'capture rich details only once per gesture');
    diagnostics.started = true;
    diagnostics.activePointer = state;
    diagnostics.onPointerEvent({type:'pointercancel',target,pointerId:2}, 'capture');
    assert.equal(state.targetElement, null);
});
