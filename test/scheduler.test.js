import test from 'node:test';
import assert from 'node:assert/strict';

import { FrameScheduler } from '../utils/scheduler.js';
import { calculateInsertionIndex, findDirectListItem } from '../utils/drag-engine.js';

test('runs higher-priority queued work first', async () => {
    const callbacks = [];
    globalThis.requestAnimationFrame = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelAnimationFrame = () => {};
    const scheduler = new FrameScheduler();
    const order = [];
    const low = scheduler.schedule(() => order.push('low'), { priority: 4 });
    const high = scheduler.schedule(() => order.push('high'), { priority: 0 });
    callbacks.shift()(0);
    await Promise.all([low, high]);
    assert.deepEqual(order, ['high', 'low']);
    scheduler.destroy();
});

test('a delayed animation frame leaves remaining background work for the next frame', async t => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const callbacks = [];
    globalThis.requestAnimationFrame = callback => {
        callbacks.push(callback);
        return callbacks.length;
    };
    globalThis.cancelAnimationFrame = () => {};
    const scheduler = new FrameScheduler();
    t.after(() => scheduler.destroy());
    const order = [];
    const background = scheduler.schedule(() => order.push('background'), { priority: 3 });
    const chat = scheduler.schedule(deadline => {
        order.push('chat');
        assert.ok(deadline - now < 5);
        now += 5;
    }, { priority: 1 });

    now = 45;
    callbacks.shift()(45);
    await chat;
    assert.deepEqual(order, ['chat']);
    now = 62;
    callbacks.shift()(62);
    await background;
    assert.deepEqual(order, ['chat', 'background']);
});

test('calculates a single DOM insertion point from item midpoints', () => {
    const rects = [
        { top: 0, height: 40 },
        { top: 40, height: 40 },
        { top: 80, height: 40 },
    ];
    assert.equal(calculateInsertionIndex(rects, 10, 1), 0);
    assert.equal(calculateInsertionIndex(rects, 70, 0), 2);
    assert.equal(calculateInsertionIndex(rects, 140, 1), 3);
});

test('resolves a nested drag handle to the matching direct list item', () => {
    const list = {};
    const item = { parentElement: list, matches: selector => selector === '*' || selector === '.entry' };
    const wrapper = { parentElement: item, matches: () => false };
    const handle = { parentElement: wrapper, matches: () => false };
    assert.equal(findDirectListItem(handle, list, '*'), item);
    assert.equal(findDirectListItem(handle, list, '.entry'), item);
    assert.equal(findDirectListItem(handle, list, '.missing'), null);
});
