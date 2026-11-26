import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatOptimizer } from '../modules/chat-optimizer.js';
import { ChatScrollActivity } from '../modules/chat-scroll-activity.js';

function fixture(t, { text = 'const a = 1;', copy = true } = {}) {
    const previous = { document: globalThis.document, Element: globalThis.Element };
    class FakeElement {}
    globalThis.Element = FakeElement;
    const message = new FakeElement();
    const code = new FakeElement();
    const pre = new FakeElement();
    const button = { nativeHandler: () => 'copy' };
    let buttons = copy ? [button] : [];
    let selection = {isCollapsed:true};
    let generating = false;
    let highlights = 0;
    const copyScopes = [];
    const listeners = new Map();
    code.dataset = {};
    code.textContent = text;
    code.isConnected = true;
    code.closest = selector => selector === '.mes' ? message : selector === 'pre' ? pre : null;
    code.hasAttribute = () => code.dataset.highlighted === 'yes';
    code.querySelectorAll = () => buttons;
    code.querySelector = () => buttons[0] || null;
    code.contains = node => buttons.includes(node);
    code.appendChild = node => buttons.push(node);
    pre.dataset = {};
    const jobs = [];
    const optimizer = new ChatOptimizer({
        isGenerating: () => generating,
        importChatApi: async () => ({addCopyToCodeBlocks(scope) { copyScopes.push(scope); buttons.push(button); }}),
        scheduler: { schedule(callback) {
            let resolve, reject;
            const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
            jobs.push(async () => { try { resolve(await callback()); } catch(error) { reject(error); } });
            return promise;
        } },
    });
    optimizer.started = true;
    optimizer.highlightLibrary = {};
    optimizer.chatElement = { contains: () => true,
        addEventListener: (name, fn) => listeners.set(name, fn),
        removeEventListener: name => listeners.delete(name),
    };
    optimizer.originalHighlight = element => {
        highlights++;
        assert.equal(element, code);
        buttons = []; // Real highlight.js replaces innerHTML, including icons.
        code.dataset.highlighted = 'yes';
    };
    globalThis.document = {
        querySelector: () => optimizer.chatElement, getSelection: () => selection,
        addEventListener: (name, fn) => listeners.set(name, fn),
        removeEventListener: name => listeners.delete(name),
    };
    t.after(() => {
        for (const [key,value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
    });
    return {optimizer,code,pre,button,jobs,copyScopes,listeners,get highlights(){return highlights;},get buttons(){return buttons;},set selection(value){selection=value;},set generating(value){generating=value;}};
}

test('deduplicates pending code highlights and preserves the same native copy button and handler', async t => {
    const f = fixture(t);
    for(let i=0;i<20;i++) f.optimizer.queueHighlight(f.code);
    assert.equal(f.jobs.length,1);
    await f.jobs[0]();
    assert.equal(f.highlights,1);
    assert.equal(f.buttons[0],f.button);
    assert.equal(f.buttons[0].nativeHandler(),'copy');
    assert.equal(f.copyScopes.length,0,'existing native buttons need no helper call or rebuilding');
});

test('creates a missing copy control only for the highlighted pre rather than the entire message', async t => {
    const f = fixture(t,{copy:false});
    f.optimizer.queueHighlight(f.code);
    await f.jobs[0]();
    assert.deepEqual(f.copyScopes,[f.pre]);
    assert.equal(f.buttons.length,1);
});

test('selection, held pointer and generation defer code mutation even if a task was already queued', async t => {
    const f = fixture(t);
    f.optimizer.queueHighlight(f.code);
    f.selection = {isCollapsed:false,anchorNode:{}};
    await f.jobs[0]();
    assert.equal(f.highlights,0);
    f.selection = {isCollapsed:true};
    f.optimizer.highlightPointerId = 7;
    f.optimizer.queueHighlight(f.code);
    assert.equal(f.jobs.length,1);
    f.optimizer.highlightPointerId = null;
    f.generating = true;
    f.optimizer.queueHighlight(f.code);
    assert.equal(f.jobs.length,1);
    assert.equal(f.buttons[0],f.button);
});

test('oversized code stays intact as plain text without expensive syntax parsing', async t => {
    const text = 'a'.repeat(20001);
    const f = fixture(t,{text});
    f.optimizer.queueHighlight(f.code);
    await f.jobs[0]();
    assert.equal(f.highlights,0);
    assert.equal(f.code.textContent,text);
    assert.equal(f.buttons[0],f.button);
});

test('queued work cannot highlight or rebuild copy controls after stop/restart', async t => {
    const f = fixture(t,{copy:false});
    f.optimizer.queueHighlight(f.code);
    f.optimizer.pauseCodeScanning();
    await f.jobs[0]();
    assert.equal(f.highlights,0);
    assert.deepEqual(f.copyScopes,[]);
});

test('generation disconnects chat mutations and unlock resumes observation with a scheduled scan', t => {
    const f = fixture(t);
    let disconnected=0,observed=0;
    f.optimizer.codeObservationStarted = true;
    f.optimizer.domObserver = {disconnect(){disconnected++;},observe(){observed++;}};
    f.generating=true;
    f.optimizer.pauseCodeScanning();
    assert.equal(disconnected,1);
    assert.equal(observed,0);
    f.generating=false;
    f.optimizer.refreshAfterGeneration();
    assert.equal(observed,1);
    assert.equal(f.jobs.length,1);
});

test('old offscreen code is observed without reading its contents', t => {
    const f = fixture(t);
    const original = globalThis.IntersectionObserver;
    let observed;
    globalThis.IntersectionObserver = class {
        observe(element) { observed = element; }
    };
    t.after(() => { globalThis.IntersectionObserver = original; });
    const message = { matches: () => true, nextElementSibling: null };
    const first = { nextElementSibling: { ...message, nextElementSibling: { ...message, nextElementSibling: message } } };
    f.code.closest = selector => selector === '.mes' ? first : null;
    Object.defineProperty(f.code, 'textContent', { get: () => assert.fail('offscreen code was read') });
    f.optimizer.queueHighlight(f.code);
    assert.equal(observed, f.code);
    assert.equal(f.jobs.length, 0);
});

test('queued highlights and newly visible code wait through momentum scrolling after pointer release', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const f = fixture(t);
    f.optimizer.codeObservationStarted = true;
    f.optimizer.scrollActivity = new ChatScrollActivity({
        now: () => Date.now(),
        onIdle: () => f.optimizer.queueCodeScan(),
    });
    f.optimizer.scrollActivity.start(f.optimizer.chatElement);
    t.after(() => f.optimizer.scrollActivity.stop());
    f.optimizer.queueHighlight(f.code);
    assert.equal(f.jobs.length, 1);
    f.listeners.get('scroll')({ target: f.optimizer.chatElement });
    f.optimizer.highlightPointerId = null; // Finger lifted, but native momentum continues.
    await f.jobs[0]();
    assert.equal(f.highlights, 0);
    // Let the scheduled promise's finally release its pending-code marker,
    // as it would before a later real scroll-settle timer runs.
    await Promise.resolve();
    await Promise.resolve();
    f.optimizer.queueHighlight(f.code, true);
    assert.equal(f.jobs.length, 1, 'intersection callbacks must not restart highlighting mid-scroll');
    t.mock.timers.tick(100);
    f.listeners.get('scroll')({ target: f.optimizer.chatElement });
    t.mock.timers.tick(179);
    assert.equal(f.jobs.length, 1);
    t.mock.timers.tick(1);
    await f.jobs[1](); // Resumed discovery queues the deferred code.
    await f.jobs[2]();
    assert.equal(f.highlights, 1);
    assert.equal(f.buttons[0], f.button);
    assert.equal(f.buttons[0].nativeHandler(), 'copy');
});

test('background pages defer code DOM work and visibility return can resume it', async t => {
    const f = fixture(t);
    globalThis.document.hidden = true;
    f.optimizer.queueHighlight(f.code);
    assert.equal(f.jobs.length, 0);
    globalThis.document.hidden = false;
    f.optimizer.queueHighlight(f.code);
    await f.jobs[0]();
    assert.equal(f.highlights, 1);
});
