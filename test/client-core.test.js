import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CHAT_LIMIT_CHOICES,
    CLIENT_VERSION,
    buildChatDiagnostics,
    chooseAdaptiveChatLimit,
    classifyTakeoverRequest,
    connectionAllowsWarmup,
    detectSwipeAxis,
    estimateRenderComplexity,
    findLatestChatRequest,
    getAdaptiveBatchSize,
    measureChatPayload,
    normalizeSettings,
    prioritizeMessageDescriptors,
    shouldActivateRenderBoost,
    shouldAutoWarm,
} from '../client-core.js';
import { ACCELERATOR_VERSION } from '../server/worker-template.js';

test('keeps every published version source in sync', async () => {
    const [{ default: manifest }, { default: packageJson }] = await Promise.all([
        import('../manifest.json', { with: { type: 'json' } }),
        import('../package.json', { with: { type: 'json' } }),
    ]);
    assert.equal(CLIENT_VERSION, '1.5.0');
    assert.equal(manifest.version, CLIENT_VERSION);
    assert.equal(packageJson.version, CLIENT_VERSION);
    assert.equal(ACCELERATOR_VERSION, CLIENT_VERSION);
});

test('normalizes old UI settings without requiring server state', () => {
    const settings = normalizeSettings({ enabled: true, renderBoost: true, longChatLimit: 999 });
    assert.equal(settings.enabled, true);
    assert.equal(settings.autoWarm, false);
    assert.equal(settings.renderBoost, true);
    assert.equal(settings.longChatLimit, 20);
    assert.equal(settings.renderBoostThreshold, 20);
    assert.deepEqual(CHAT_LIMIT_CHOICES, [8, 10, 15, 20, 30, 50]);
    assert.equal(settings.previousChatTruncation, null);
});

test('enables the guarded takeover defaults for existing installations', () => {
    const settings = normalizeSettings({ settingsVersion: '1.3.1' });
    assert.equal(settings.takeoverEnabled, true);
    assert.equal(settings.takeoverIntensity, 'strong');
    assert.equal(settings.requestPrefetch, true);
    assert.equal(settings.regexAutoRefresh, true);
    assert.equal(settings.adaptiveChatLimit, true);
    assert.equal(settings.autoLoadOlder, true);
    assert.equal(settings.deferChatHighlight, true);
    assert.equal(settings.mobileSwipeGuard, true);
    assert.equal(settings.renderBoost, true);
    assert.equal(settings.adaptivePreviousChatTruncation, null);
});

test('chooses smaller first-paint limits for rich chats and constrained devices', () => {
    assert.equal(chooseAdaptiveChatLimit({ averageTextLength: 400, richMarkerCount: 0, hardwareConcurrency: 8, deviceMemory: 8 }), 30);
    assert.equal(chooseAdaptiveChatLimit({ averageTextLength: 5000, richMarkerCount: 12, hardwareConcurrency: 8, deviceMemory: 8 }), 15);
    assert.equal(chooseAdaptiveChatLimit({ averageTextLength: 5000, richMarkerCount: 12, hardwareConcurrency: 4, deviceMemory: 4 }), 8);
    const metrics = measureChatPayload([{ mes: '<details><table>heavy</table></details>' }, { mes: 'plain' }]);
    assert.ok(metrics.richMarkerCount >= 2);
});

test('strictly classifies request reuse, observation, invalidation, and native paths', () => {
    assert.equal(classifyTakeoverRequest({ pathname: '/api/characters/all', method: 'POST' }), 'reuse');
    assert.equal(classifyTakeoverRequest({ pathname: '/scripts/extensions/regex/editor.html', method: 'GET' }), 'reuse');
    assert.equal(classifyTakeoverRequest({ pathname: '/api/chats/get', method: 'POST' }), 'observe-chat');
    assert.equal(classifyTakeoverRequest({ pathname: '/api/characters/delete', method: 'POST' }), 'invalidate');
    assert.equal(classifyTakeoverRequest({ pathname: '/api/backends/chat-completions/generate', method: 'POST' }), 'native');
    assert.equal(classifyTakeoverRequest({ pathname: '/api/settings/save', method: 'POST' }), 'native');
});

test('mobile swipe guard only classifies decisive gestures', () => {
    assert.equal(detectSwipeAxis({ deltaX: 4, deltaY: 5 }), 'pending');
    assert.equal(detectSwipeAxis({ deltaX: 8, deltaY: 40 }), 'vertical');
    assert.equal(detectSwipeAxis({ deltaX: 40, deltaY: 8 }), 'horizontal');
    assert.equal(detectSwipeAxis({ deltaX: 20, deltaY: 18 }), 'ambiguous');
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

test('prioritizes visible then recent messages while preserving order', () => {
    const descriptors = [
        { messageId: 1 },
        { messageId: 2, recent: true },
        { messageId: 3, visible: true },
        { messageId: 4, visible: true, recent: true },
        { messageId: 5 },
    ];
    assert.deepEqual(
        prioritizeMessageDescriptors(descriptors).map(item => item.messageId),
        [3, 4, 2, 1, 5],
    );
});

test('reduces frame batches for complex messages and slow frames', () => {
    const light = estimateRenderComplexity({ domNodes: 40, htmlLength: 1200, richElements: 0 });
    const heavy = estimateRenderComplexity({ domNodes: 900, htmlLength: 24000, richElements: 8 });
    assert.ok(heavy > light);
    assert.equal(getAdaptiveBatchSize({ complexity: heavy, currentBatch: 6 }), 1);
    assert.equal(getAdaptiveBatchSize({ complexity: light, previousFrameMs: 24, currentBatch: 5 }), 3);
    assert.equal(getAdaptiveBatchSize({ complexity: light, previousFrameMs: 4, currentBatch: 4 }), 5);
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
