import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatOptimizer } from '../modules/chat-optimizer.js';

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
    optimizer.chatElement = {contains:()=>true};
    optimizer.originalHighlight = element => {
        highlights++;
        assert.equal(element, code);
        buttons = []; // Real highlight.js replaces innerHTML, including icons.
        code.dataset.highlighted = 'yes';
    };
    globalThis.document = {querySelectorAll:()=>[message],getSelection:()=>selection};
    t.after(() => {
        clearTimeout(optimizer.codeScanTimer);
        for (const [key,value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
    });
    return {optimizer,code,pre,button,jobs,copyScopes,get highlights(){return highlights;},get buttons(){return buttons;},set selection(value){selection=value;},set generating(value){generating=value;}};
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

test('oversized code stays intact as plain text without expensive syntax parsing', t => {
    const text = 'a'.repeat(20001);
    const f = fixture(t,{text});
    f.optimizer.queueHighlight(f.code);
    assert.equal(f.highlights,0);
    assert.equal(f.jobs.length,0);
    assert.equal(f.code.textContent,text);
    assert.equal(f.buttons[0],f.button);
});

test('queued work cannot highlight or rebuild copy controls after stop/restart', async t => {
    const f = fixture(t,{copy:false});
    f.optimizer.queueHighlight(f.code);
    f.optimizer.generation++;
    await f.jobs[0]();
    assert.equal(f.highlights,0);
    assert.deepEqual(f.copyScopes,[]);
});

test('generation disconnects chat mutations and unlock resumes observation with a delayed scan', t => {
    const f = fixture(t);
    let disconnected=0,observed=0;
    f.optimizer.domObserver = {disconnect(){disconnected++;},observe(){observed++;}};
    f.generating=true;
    f.optimizer.pauseCodeScanning();
    assert.equal(disconnected,1);
    assert.equal(observed,0);
    f.generating=false;
    f.optimizer.refreshAfterGeneration();
    assert.equal(observed,1);
    assert.notEqual(f.optimizer.codeScanTimer,null);
});
