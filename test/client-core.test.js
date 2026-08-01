import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CHAT_LIMIT_CHOICES,
    CLIENT_VERSION,
    buildChatDiagnostics,
    connectionAllowsWarmup,
    findLatestChatRequest,
    normalizeSettings,
    shouldActivateRenderBoost,
    shouldAutoWarm,
} from '../client-core.js';

test('normalizes old UI settings without requiring server state', () => {
    const settings = normalizeSettings({ enabled: true, renderBoost: true, longChatLimit: 999 });
    assert.equal(settings.enabled, true);
    assert.equal(settings.autoWarm, false);
    assert.equal(settings.renderBoost, true);
    assert.equal(settings.longChatLimit, 20);
    assert.equal(settings.renderBoostThreshold, 20);
    assert.deepEqual(CHAT_LIMIT_CHOICES, [10, 15, 20, 30, 50]);
    assert.equal(settings.previousChatTruncation, null);
});

test('keeps versioned heavy-beautify settings and supported low chat limits', () => {
    const settings = normalizeSettings({
        settingsVersion: CLIENT_VERSION,
        heavyBeautifyMode: true,
        longChatLimit: 15,
        renderBoostThreshold: 40,
        heavyModePrevious: { renderBoost: false, longChatMode: true, longChatLimit: 30 },
    });
    assert.equal(settings.heavyBeautifyMode, true);
    assert.equal(settings.longChatLimit, 15);
    assert.equal(settings.renderBoostThreshold, 40);
    assert.deepEqual(settings.heavyModePrevious, { renderBoost: false, longChatMode: true, longChatLimit: 30 });
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

test('selects the latest real chat load request and derives browser diagnostics', () => {
    const entries = [
        { name: 'https://example.test/api/chats/search', startTime: 10, responseEnd: 20, duration: 10 },
        { name: 'https://example.test/api/chats/get', startTime: 100, responseEnd: 180, duration: 80, transferSize: 4096 },
        { name: 'https://example.test/api/chats/group/get', startTime: 200, responseEnd: 260, duration: 60, transferSize: 2048 },
    ];
    const request = findLatestChatRequest(entries, 300);
    assert.equal(request.startTime, 200);
    const metrics = buildChatDiagnostics({
        now: 350,
        requestEntry: request,
        loadStart: 190,
        firstContentAt: 330,
        displayedMessages: 15,
        totalMessages: 28,
        domNodes: 3200,
        longTasks: [
            { startTime: 150, duration: 99 },
            { startTime: 270, duration: 74 },
        ],
    });
    assert.equal(metrics.requestMs, 60);
    assert.equal(metrics.transferBytes, 2048);
    assert.equal(metrics.firstContentMs, 140);
    assert.equal(metrics.totalLoadMs, 160);
    assert.equal(metrics.frontendMs, 90);
    assert.equal(metrics.longestTaskMs, 74);
});
