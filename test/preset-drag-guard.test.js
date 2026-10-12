import test from 'node:test';
import assert from 'node:assert/strict';
import { PresetDragGuard } from '../modules/preset-drag-guard.js';

function fixture(options = {}) {
    const classes = new Set();
    const listeners = new Map();
    const list = { isConnected: true };
    const update = () => {};
    const stop = () => {};
    let writes = 0;
    let instance = {
        options: { handle: null, distance: 1, delay: 30, disabled: false, update, stop, items: '.native-draggable', ...options },
        option(changes) { writes++; Object.assign(this.options, changes); },
    };
    const jquery = element => ({ sortable(command) {
        assert.equal(element, list);
        assert.equal(command, 'instance', 'never create, destroy or disable the native sortable');
        return instance;
    } });
    jquery.fn = { sortable() {} };
    const guard = new PresetDragGuard({
        getJQuery: () => jquery,
        documentRef: {
            body: { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } },
            querySelectorAll: () => [list],
            addEventListener(type, callback, config) { assert.equal(config.capture, true); assert.equal(config.passive, true); listeners.set(type, callback); },
            removeEventListener(type) { listeners.delete(type); },
        },
    });
    return { guard, list, classes, listeners, get writes() { return writes; }, get instance() { return instance; }, set instance(value) { instance = value; }, update, stop };
}

test('protects only native prompt handles without changing callbacks, item rules or disabled state', () => {
    const f = fixture();
    f.guard.start();
    assert.equal(f.instance.options.handle, '.drag-handle');
    assert.equal(f.instance.options.distance, 10);
    assert.equal(f.instance.options.delay, 150);
    assert.equal(f.instance.options.update, f.update);
    assert.equal(f.instance.options.stop, f.stop);
    assert.equal(f.instance.options.items, '.native-draggable');
    assert.equal(f.instance.options.disabled, false);
    assert.deepEqual([...f.listeners.keys()], ['pointerdown', 'mousedown', 'touchstart']);
    f.guard.start();
    assert.equal(f.writes, 1);
    f.guard.stop();
    assert.equal(f.instance.options.handle, null);
    assert.equal(f.instance.options.distance, 1);
    assert.equal(f.instance.options.delay, 30);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.classes.size, 0);
});

test('reapplies protection before mouse and touch handlers after native rerender resets options', () => {
    const f = fixture();
    f.guard.start();
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
        f.instance.options.handle = null;
        f.instance.options.delay = 30;
        const event = { target: { closest: () => f.list }, preventDefault() { assert.fail('must allow scroll/click'); }, stopPropagation() { assert.fail('must allow edit/toggle'); } };
        f.listeners.get(type)(event);
        assert.equal(f.instance.options.handle, '.drag-handle');
        assert.equal(f.instance.options.delay, 150);
    }
    const writes = f.writes;
    f.listeners.get('mousedown')({ target: { closest: () => null } });
    assert.equal(f.writes, writes, 'world info, regex and other lists are untouched');
    f.guard.stop();
    assert.equal(f.instance.options.handle, null);
    assert.equal(f.instance.options.distance, 1, 'partial native resets must not lose the original distance');
});

test('preserves stronger existing thresholds and later third-party option changes', () => {
    const f = fixture({ distance: 20, delay: 400 });
    f.guard.start();
    assert.equal(f.instance.options.distance, 20);
    assert.equal(f.instance.options.delay, 400);
    f.instance.options.handle = '.custom-handle';
    f.guard.stop();
    assert.equal(f.instance.options.handle, '.custom-handle');
    assert.equal(f.instance.options.distance, 20);
    assert.equal(f.instance.options.delay, 400);
});

test('skips disabled, actively dragging, destroyed or replaced sortables during cleanup', () => {
    const disabled = fixture({ disabled: true });
    disabled.guard.start();
    assert.equal(disabled.writes, 0);
    disabled.guard.stop();
    const active = fixture();
    active.instance.dragging = true;
    active.guard.start();
    assert.equal(active.writes, 0);
    active.instance.dragging = false;
    active.guard.protect(active.list);
    assert.equal(active.writes, 1);
    active.instance = null;
    active.guard.stop();
    assert.equal(active.guard.records.size, 0);
});

test('new native instances are protected and disconnected list records are discarded on the next interaction', () => {
    const f = fixture();
    f.guard.start();
    const replacement = { options: { handle: '.mobile-handle', distance: 2, delay: 50 }, option(changes) { Object.assign(this.options, changes); } };
    f.instance = replacement;
    f.guard.protect(f.list);
    assert.equal(replacement.options.handle, '.drag-handle');
    f.guard.stop();
    assert.equal(replacement.options.handle, '.mobile-handle');
    assert.equal(replacement.options.distance, 2);
    f.guard.start();
    f.list.isConnected = false;
    f.guard.protect(f.list);
    f.guard.stop();
    assert.equal(f.guard.records.size, 0);
});
