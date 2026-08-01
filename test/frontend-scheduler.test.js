import test from 'node:test';
import assert from 'node:assert/strict';

import { FrameBudgetScheduler, budgetForIntensity } from '../frontend-scheduler.js';

test('maps takeover intensities to the documented frame budgets', () => {
    assert.equal(budgetForIntensity('balanced'), 8);
    assert.equal(budgetForIntensity('strong'), 10);
    assert.equal(budgetForIntensity('extreme'), 12);
});

test('runs higher-priority queued work first', async () => {
    const previousRaf = globalThis.requestAnimationFrame;
    const previousCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0);
    globalThis.cancelAnimationFrame = clearTimeout;
    const scheduler = new FrameBudgetScheduler({ budgetMs: 10 });
    const order = [];
    const low = scheduler.schedule(() => order.push('low'), { priority: 4 });
    const high = scheduler.schedule(() => order.push('high'), { priority: 0 });
    await Promise.all([low, high]);
    assert.deepEqual(order, ['high', 'low']);
    scheduler.destroy();
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.cancelAnimationFrame = previousCancel;
});
