import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMemoryDiagnostics } from '../modules/memory-diagnostics.js';

function documentFixture(nodes, animations = []) {
    const documentElement = {};
    return {
        documentElement,
        createTreeWalker(root, mask) {
            assert.equal(root, documentElement);
            assert.equal(mask, 1);
            let index = 0;
            return { nextNode: () => nodes[index++] || null };
        },
        getAnimations: () => animations,
    };
}

test('reports numeric heap, media, animation and frame counts without exporting content or URLs', () => {
    const frameDocument = documentFixture([{ nodeName: 'DIV' }], [{ playState: 'running' }]);
    const documentRef = documentFixture([
        { nodeName: 'IMG', currentSrc: 'https://private.example/sensitive.gif?token=secret', naturalWidth: 400, naturalHeight: 300 },
        { nodeName: 'IFRAME', contentDocument: frameDocument },
        { nodeName: 'VIDEO', paused: false, ended: false },
    ], [{ playState: 'running' }, { playState: 'paused' }]);
    const result = collectMemoryDiagnostics({ documentRef,
        performanceRef: { memory: { usedJSHeapSize: 123, totalJSHeapSize: 456, jsHeapSizeLimit: 789 } },
        chat: [{ mes: 'private message body', extra: { variables: { secret: 'private variable' } } }], characters: [{ name: 'private character' }],
    });
    assert.equal(result.heap.usedBytes, 123);
    assert.equal(result.heap.scope, 'javascript-heap-not-total-tab-memory');
    assert.equal(result.dom.gifImages, 1);
    assert.equal(result.dom.decodedImagePixels, 120000);
    assert.equal(result.dom.playingMedia, 1);
    assert.deepEqual(result.dom.animations, { total: 2, running: 1 });
    assert.equal(result.embedded[0].elements, 1);
    assert.equal(result.characterCount, 1);
    assert.ok(result.chat.data.stringChars > 0);
    assert.doesNotMatch(JSON.stringify(result), /private|sensitive|secret/);
    assert.equal(result.coverage.cpu, 'not-measured');
    assert.equal(result.coverage.detachedNodes, 'not-measured');
});

test('does not mistake unavailable browser heap data for zero memory or inspect inaccessible frames', () => {
    const frame = { nodeName: 'IFRAME', get contentDocument() { throw new Error('cross origin'); } };
    const result = collectMemoryDiagnostics({ documentRef: documentFixture([frame]), performanceRef: {}, chat: [] });
    assert.deepEqual(result.heap, { support: 'unavailable', usedBytes: null });
    assert.deepEqual(result.embedded, [{ access: 'unavailable' }]);
    assert.equal(result.dom.iframes, 1);
});

test('caps DOM and recent data inspection and handles cycles without JSON serialization or getters', () => {
    let visits = 0;
    const nodes = { get documentElement() { return {}; }, createTreeWalker() {
        return { nextNode: () => { visits++; return { nodeName: 'DIV' }; } };
    } };
    const value = { text: 'data', toJSON() { assert.fail('toJSON must not run'); }, get dynamic() { assert.fail('getter must not run'); } };
    value.self = value;
    const cyclic = collectMemoryDiagnostics({ documentRef: nodes, performanceRef: {}, chat: [value] });
    assert.equal(visits, 10000);
    assert.equal(cyclic.dom.capped, true);
    assert.equal(cyclic.chat.data.stringChars, 4);
    assert.equal(cyclic.chat.data.capped, false);
    const large = collectMemoryDiagnostics({ documentRef: null, performanceRef: {}, chat: Array.from({ length: 1000 }, () => ({ extra: Array(200).fill('value') })) });
    assert.equal(large.chat.messages, 1000);
    assert.equal(large.chat.sampledMessages, 100);
    assert.equal(large.chat.data.properties, 10000);
    assert.equal(large.chat.data.capped, true);
});

test('samples at most eight embedded documents and tolerates missing document APIs', () => {
    let reads = 0;
    const frames = Array.from({ length: 50 }, () => ({ nodeName: 'IFRAME', get contentDocument() { reads++; return documentFixture([]); } }));
    const result = collectMemoryDiagnostics({ documentRef: documentFixture(frames), performanceRef: {} });
    assert.equal(result.dom.iframes, 50);
    assert.equal(result.embedded.length, 8);
    assert.equal(reads, 8);
    assert.equal(collectMemoryDiagnostics({ documentRef: {}, performanceRef: {} }).dom, null);
});
