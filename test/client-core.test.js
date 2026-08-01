import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    CLIENT_VERSION,
    chooseAdaptiveChatLimit,
    classifyStartupRequest,
    connectionAllowsWarmup,
    detectSwipeAxis,
    estimateRenderComplexity,
    getAdaptiveBatchSize,
    measureChatPayload,
    prioritizeMessageDescriptors,
} from '../client-core.js';
import { getLegacyChatTruncation, normalizeSettings } from '../settings.js';
import { ACCELERATOR_VERSION } from '../server/worker-template.js';

test('keeps every published version source in sync', async () => {
    const [{ default: manifest }, { default: packageJson }] = await Promise.all([
        import('../manifest.json', { with: { type: 'json' } }),
        import('../package.json', { with: { type: 'json' } }),
    ]);
    assert.equal(CLIENT_VERSION, '2.0.0');
    assert.equal(manifest.version, CLIENT_VERSION);
    assert.equal(packageJson.version, CLIENT_VERSION);
    assert.equal(ACCELERATOR_VERSION, CLIENT_VERSION);
});

test('migrates legacy expert settings into three user-facing switches', () => {
    const settings = normalizeSettings({
        enabled: false,
        takeoverEnabled: true,
        interactionOptimization: false,
        adaptivePreviousChatTruncation: 100,
        autoLoadBatch: 20,
    });
    assert.deepEqual(settings, {
        pageAcceleration: false,
        chatOptimization: true,
        interactionOptimization: false,
        settingsVersion: CLIENT_VERSION,
    });
    assert.equal(getLegacyChatTruncation({ adaptivePreviousChatTruncation: 80 }), 80);
    assert.equal(getLegacyChatTruncation({ previousChatTruncation: 50 }), 50);
});

test('chooses smaller first-paint limits for rich chats and constrained devices', () => {
    assert.equal(chooseAdaptiveChatLimit({ averageTextLength: 400, richMarkerCount: 0, hardwareConcurrency: 8, deviceMemory: 8 }), 30);
    assert.equal(chooseAdaptiveChatLimit({ averageTextLength: 5000, richMarkerCount: 12, hardwareConcurrency: 8, deviceMemory: 8 }), 15);
    assert.equal(chooseAdaptiveChatLimit({ averageTextLength: 5000, richMarkerCount: 12, hardwareConcurrency: 4, deviceMemory: 4 }), 8);
    assert.ok(measureChatPayload([{ mes: '<details><table>heavy</table></details>' }]).richMarkerCount >= 2);
});

test('strictly scopes startup request observation and reuse', () => {
    assert.equal(classifyStartupRequest({ pathname: '/api/characters/all', method: 'POST' }), 'reuse');
    assert.equal(classifyStartupRequest({ pathname: '/scripts/extensions/regex/editor.html', method: 'GET' }), 'reuse');
    assert.equal(classifyStartupRequest({ pathname: '/api/chats/get', method: 'POST' }), 'observe-chat');
    assert.equal(classifyStartupRequest({ pathname: '/api/characters/delete', method: 'POST' }), 'invalidate');
    assert.equal(classifyStartupRequest({ pathname: '/api/settings/save', method: 'POST' }), 'native');
});

test('keeps gesture and frame algorithms automatic', () => {
    assert.equal(detectSwipeAxis({ deltaX: 8, deltaY: 40 }), 'vertical');
    assert.equal(detectSwipeAxis({ deltaX: 40, deltaY: 8 }), 'horizontal');
    assert.equal(detectSwipeAxis({ deltaX: 20, deltaY: 18 }), 'ambiguous');
    const heavy = estimateRenderComplexity({ domNodes: 900, htmlLength: 24000, richElements: 8 });
    assert.equal(getAdaptiveBatchSize({ complexity: heavy, currentBatch: 6 }), 1);
    assert.equal(connectionAllowsWarmup({ saveData: true, effectiveType: '4g' }), false);
});

test('prioritizes visible then recent messages without reordering peers', () => {
    const descriptors = [{ id: 1 }, { id: 2, recent: true }, { id: 3, visible: true }, { id: 4 }];
    assert.deepEqual(prioritizeMessageDescriptors(descriptors).map(item => item.id), [3, 2, 1, 4]);
});

test('removes the public safe-mode navigation entry and global takeover wording', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /cla-safe/);
    assert.doesNotMatch(source, /location\.assign/);
    assert.doesNotMatch(source, /全局前端接管/);
});
