import test from 'node:test';
import assert from 'node:assert/strict';
import { PressSweepSelection } from '../utils/press-sweep-selection.js';

function fixture(t) {
    const previous = globalThis.document, listeners = new Map();
    globalThis.document = {
        addEventListener: (name, callback, options) => listeners.set(name, { callback, options }),
        removeEventListener: name => listeners.delete(name),
    };
    const root = { addEventListener() {}, removeEventListener() {}, classList: { add() {}, remove() {} } };
    const localListeners = new Map();
    const row = { isConnected: true }, name = { isConnected: true, closest: () => row,
        addEventListener: (name, callback, options) => localListeners.set(name, { callback, options }),
        removeEventListener: name => localListeners.delete(name),
    };
    let reads = 0, selected = false;
    const selection = new PressSweepSelection({ root, nameSelector: '.name', rowSelector: '.row',
        getRows: () => { reads++; return [row]; }, isSelected: () => selected, setSelected: (_, value) => { selected = value; },
    });
    t.after(() => { selection.destroy(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
    const event = { target: { closest: () => name }, button: 0, isPrimary: true, pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 };
    return { selection, listeners, localListeners, event, get reads() { return reads; }, get selected() { return selected; } };
}

test('ordinary touch scroll neither measures rows nor registers document touch blockers', t => {
    const f = fixture(t);
    f.selection.down(f.event);
    assert.equal(f.reads, 0);
    assert.equal(f.listeners.has('touchmove'), false);
    assert.equal(f.listeners.get('pointermove').options.passive, true);
    f.selection.move({ ...f.event, clientY: 20 });
    assert.equal(f.selection.gesture, null);
    assert.equal(f.reads, 0);
    assert.equal(f.selected, false);
    assert.equal(f.listeners.has('touchmove'), false);
    assert.equal(f.localListeners.size, 0, 'a scrolling gesture releases its local listener');
});

test('a deliberate hold acquires its row snapshot and upgrades pointer tracking when armed', t => {
    const f = fixture(t);
    f.selection.down(f.event);
    f.selection.arm(f.selection.gesture);
    assert.equal(f.reads, 1);
    assert.equal(f.selected, true);
    assert.equal(f.localListeners.get('touchmove').options.passive, false);
    assert.equal(f.listeners.get('pointermove').options.passive, false);
    f.selection.cancel();
    assert.equal(f.listeners.has('touchmove'), false);
    assert.equal(f.localListeners.size, 0);
    assert.equal(f.selected, false, 'cancellation restores the original selection');
});
