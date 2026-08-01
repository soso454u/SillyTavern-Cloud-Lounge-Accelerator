import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CLIENT_VERSION,
    connectionAllowsWarmup,
    normalizeSettings,
    shouldActivateRenderBoost,
    shouldAutoWarm,
} from '../client-core.js';

test('normalizes old UI settings without requiring server state', () => {
    const settings = normalizeSettings({ enabled: true, renderBoost: true, longChatLimit: 999 });
    assert.equal(settings.enabled, true);
    assert.equal(settings.autoWarm, false);
    assert.equal(settings.renderBoost, true);
    assert.equal(settings.longChatLimit, 50);
    assert.equal(settings.previousChatTruncation, null);
});

test('only enables render containment for genuinely long chats', () => {
    assert.equal(shouldActivateRenderBoost({ enabled: true, messageCount: 79, threshold: 80 }), false);
    assert.equal(shouldActivateRenderBoost({ enabled: true, messageCount: 80, threshold: 80 }), true);
    assert.equal(shouldActivateRenderBoost({ enabled: false, messageCount: 500, threshold: 80 }), false);
});

test('automatic warm-up respects data saving, slow links, visibility, and version', () => {
    assert.equal(connectionAllowsWarmup({ saveData: true, effectiveType: '4g' }), false);
    assert.equal(connectionAllowsWarmup({ saveData: false, effectiveType: '2g' }), false);
    assert.equal(shouldAutoWarm({
        enabled: true,
        autoWarm: true,
        visible: true,
        connection: { saveData: false, effectiveType: '4g' },
        lastWarmVersion: '',
    }), true);
    assert.equal(shouldAutoWarm({
        enabled: true,
        autoWarm: true,
        visible: true,
        connection: null,
        lastWarmVersion: CLIENT_VERSION,
    }), false);
});
