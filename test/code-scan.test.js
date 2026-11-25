import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatOptimizer } from '../modules/chat-optimizer.js';

function fixture(t, count = 5000) {
    const previous = globalThis.document;
    let visits = 0;
    const node = localName => ({
        localName, nodeType: 1, dataset: {},
        querySelectorAll() { assert.fail('must not synchronously query an entire subtree'); },
        matches: () => localName === 'code',
        contains(other) { for (; other; other = other.parentElement) if (other === this) return true; return false; },
    });
    const append = (parent, child) => {
        child.parentElement = parent;
        if (parent.lastElementChild) parent.lastElementChild.nextElementSibling = child;
        else parent.firstElementChild = child;
        parent.lastElementChild = child;
    };
    const chat = node('div'), root = node('div'), code = node('code');
    append(chat, root);
    for (let i = 0; i < count; i++) append(root, node('span'));
    append(root, code);
    const audio = node('audio'), frame = node('iframe');
    Object.defineProperty(frame, 'contentDocument', { get() { assert.fail('must not enter other plugin frames'); } });
    audio.pause = audio.play = () => assert.fail('must not control media');
    append(root, audio); append(root, frame);
    globalThis.document = {
        getSelection: () => ({ isCollapsed: true }),
        createTreeWalker(root, mask) {
            assert.equal(mask, 1);
            let current = root;
            return { nextNode() {
                let next = current.firstElementChild;
                while (!next) {
                    if (current === root) return null;
                    next = current.nextElementSibling;
                    current = current.parentElement;
                }
                current = next;
                visits++;
                return current;
            } };
        },
    };
    t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
    const optimizer = new ChatOptimizer({});
    optimizer.chatElement = chat;
    optimizer.queueHighlight = element => { if (element === code) code.highlighted = true; };
    return { optimizer, chat, root, code, get visits() { return visits; } };
}

test('large message scanning resumes across bounded batches and coalesces overlapping roots', t => {
    const f = fixture(t);
    f.optimizer.addedCodeRoots.add(f.root);
    for (let node = f.root.firstElementChild; node; node = node.nextElementSibling) f.optimizer.addedCodeRoots.add(node);
    let passes = 0;
    do {
        const before = f.visits;
        f.optimizer.observeCodeBlocks(Infinity);
        assert.ok(f.visits - before <= 160);
        assert.ok(++passes < 100, 'scan must finish without repeating completed roots');
    } while (f.optimizer.codeScanCursor || f.optimizer.addedCodeRoots.size || f.optimizer.deferredHighlights.size);
    assert.ok(passes > 1);
    assert.equal(f.visits, 5003, 'every descendant is walked only once');
    assert.equal(f.code.highlighted, true, 'code at the end of a large message is still processed');
});

test('text-only status updates do not inspect pending code or schedule a scan', t => {
    const f = fixture(t, 0);
    f.optimizer.observedHighlights.add({});
    f.optimizer.deferredHighlights.set({}, false);
    f.optimizer.chatElement.contains = () => assert.fail('text updates must not sweep retained code');
    f.optimizer.queueCodeScan = () => {};
    f.optimizer.collectAddedCode([{ target: { closest: () => null }, addedNodes: [{ nodeType: 3 }], removedNodes: [{ nodeType: 3 }] }]);
    assert.equal(f.optimizer.addedCodeRoots.size, 0);
});

test('removing a partially scanned message or pausing releases its traversal state', t => {
    const f = fixture(t);
    f.optimizer.queueCodeScan = () => {};
    f.optimizer.addedCodeRoots.add(f.root);
    f.optimizer.observeCodeBlocks(Infinity);
    assert.ok(f.optimizer.codeScanCursor);
    f.root.parentElement = null;
    f.optimizer.collectAddedCode([{ target: f.chat, addedNodes: [], removedNodes: [f.root] }]);
    assert.equal(f.optimizer.codeScanCursor, null);
    f.optimizer.codeScanCursor = { root: f.root };
    f.optimizer.pauseCodeScanning();
    assert.equal(f.optimizer.codeScanCursor, null);
    assert.equal(f.optimizer.addedCodeRoots.size, 0);
});
