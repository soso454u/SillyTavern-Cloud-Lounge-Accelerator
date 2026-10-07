import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsPanel } from '../ui/panel.js';

test('reuses an already mounted settings panel instead of recreating it at APP_READY', () => {
    const panel = new SettingsPanel({});
    panel.root = { isConnected: true };
    assert.equal(panel.mount(), true);
});

test('coalesces overlapping panel refreshes and never updates a removed panel', async () => {
    let resolveStatus;
    let calls = 0;
    let updates = 0;
    const panel = new SettingsPanel({ getStatus: () => {
        calls += 1;
        return new Promise(resolve => { resolveStatus = resolve; });
    } });
    const root = { isConnected: true, dataset: {}, querySelector: () => null };
    panel.root = root;
    panel.performance = { update: () => { updates += 1; } };
    const first = panel.refresh();
    const second = panel.refresh();
    assert.equal(first, second);
    assert.equal(calls, 1);
    resolveStatus({ performance: {} });
    await first;
    assert.equal(updates, 1);
    const afterRemoval = panel.refresh();
    panel.root = null;
    resolveStatus({ performance: {} });
    await afterRemoval;
    assert.equal(updates, 1);
});
