import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    CHAT_PAGE_SIZE,
    CLIENT_VERSION,
    chooseAdaptiveChatLimit,
    classifyStartupRequest,
    connectionAllowsWarmup,
    detectSwipeAxis,
    estimateRenderComplexity,
    getAdaptiveBatchSize,
    looksLikeHeavyHtml,
    measureChatPayload,
    prioritizeMessageDescriptors,
    selectLiveMessageIndexes,
} from '../client-core.js';
import { isHeavyHtmlCodeText } from '../modules/chat-optimizer.js';
import { getLegacyChatTruncation, normalizeSettings } from '../settings.js';
import { ACCELERATOR_VERSION } from '../server/worker-template.js';

test('keeps every published version source in sync', async () => {
    const [{ default: manifest }, { default: packageJson }] = await Promise.all([
        import('../manifest.json', { with: { type: 'json' } }),
        import('../package.json', { with: { type: 'json' } }),
    ]);
    assert.equal(CLIENT_VERSION, '2.0.4');
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

test('always opens chats with only the latest five messages', () => {
    assert.equal(CHAT_PAGE_SIZE, 5);
    assert.equal(chooseAdaptiveChatLimit({ averageTextLength: 400, richMarkerCount: 0, hardwareConcurrency: 8, deviceMemory: 8 }), 5);
    assert.equal(chooseAdaptiveChatLimit({ averageTextLength: 5000, richMarkerCount: 12, hardwareConcurrency: 8, deviceMemory: 8 }), 5);
    assert.equal(chooseAdaptiveChatLimit({ averageTextLength: 5000, richMarkerCount: 12, hardwareConcurrency: 4, deviceMemory: 4 }), 5);
    assert.ok(measureChatPayload([{ mes: '<details><table>heavy</table></details>' }]).richMarkerCount >= 2);
});

test('detects full HTML documents while keeping the fixed five-message page', () => {
    const fullDocument = `<!DOCTYPE html><html><head><style>${'x'.repeat(3100)}</style></head><body></body></html>`;
    const fencedDocument = `\`\`\`html\n<html>${'x'.repeat(6000)}</html>\n\`\`\``;
    assert.equal(looksLikeHeavyHtml(fullDocument), true);
    assert.equal(looksLikeHeavyHtml(fencedDocument), true);
    assert.equal(looksLikeHeavyHtml(`<div>${'x'.repeat(4000)}</div>`), false);

    const metrics = measureChatPayload([{ mes: 'plain' }, { mes: fullDocument }]);
    assert.equal(metrics.heavyHtmlCount, 1);
    assert.equal(metrics.maxHtmlLength, fullDocument.length);
    assert.equal(chooseAdaptiveChatLimit({ ...metrics, hardwareConcurrency: 8, deviceMemory: 8 }), 5);
    assert.equal(chooseAdaptiveChatLimit({ ...metrics, hardwareConcurrency: 4, deviceMemory: 4 }), 5);
    assert.equal(chooseAdaptiveChatLimit({ maxHtmlLength: 10000, hardwareConcurrency: 8, deviceMemory: 8 }), 5);
    const longPlain = measureChatPayload([{ mes: 'x'.repeat(12000) }]);
    assert.equal(longPlain.heavyHtmlCount, 0);
    assert.equal(longPlain.maxHtmlLength, 0);
});

test('skips highlighting for full HTML documents even without a language class', () => {
    const html = `<!doctype html><html><head></head><body>${'x'.repeat(4000)}</body></html>`;
    assert.equal(isHeavyHtmlCodeText({ text: html, classNames: ['language-html'] }), true);
    assert.equal(isHeavyHtmlCodeText({ text: html, classNames: ['language-javascript'] }), true);
    assert.equal(isHeavyHtmlCodeText({ text: '<!doctype html><html><head></head></html>' }), true);
    assert.equal(isHeavyHtmlCodeText({ text: `<!doctype html><html>${'x'.repeat(2600)}</html>` }), true);
    assert.equal(isHeavyHtmlCodeText({ text: '<!doctype html><html></html>' }), false);
    assert.equal(isHeavyHtmlCodeText({ text: `<div>${'x'.repeat(5000)}</div>` }), false);
});

test('keeps visible messages, their neighbors, and only a generating tail live', () => {
    assert.deepEqual(selectLiveMessageIndexes([false, false, true, false, false]), [1, 2, 3]);
    assert.deepEqual(selectLiveMessageIndexes([false, true, false, false, false], { generating: true }), [0, 1, 2, 4]);
    assert.deepEqual(selectLiveMessageIndexes([false, false, false, false, false]), [2, 3, 4]);
    assert.deepEqual(selectLiveMessageIndexes([]), []);
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

test('leaves native history scrolling and sortable ownership untouched', async () => {
    const [chatSource, interactionSource, styles] = await Promise.all([
        readFile(new URL('../modules/chat-optimizer.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/interaction-optimizer.js', import.meta.url), 'utf8'),
        readFile(new URL('../style.css', import.meta.url), 'utf8'),
    ]);
    assert.doesNotMatch(chatSource, /showMoreMessages|onHistoryClick|maybeLoadEarlier|\.scrollTop/);
    assert.doesNotMatch(interactionSource, /SortableBridge|PointerDragEngine|PresetPanelAdapter|DrawerAnimationAdapter/);
    assert.doesNotMatch(styles, /content-visibility|contain-intrinsic-size|cla-drag-ghost/);
});
