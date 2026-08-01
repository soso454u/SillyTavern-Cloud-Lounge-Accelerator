import test from 'node:test';
import assert from 'node:assert/strict';

import { FrameScheduler } from '../utils/scheduler.js';
import { calculateInsertionIndex } from '../utils/drag-engine.js';

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
