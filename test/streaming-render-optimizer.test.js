import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingRenderOptimizer } from '../modules/streaming-render-optimizer.js';

function fixture(t, { touch = true, cost = 0 } = {}) {
    let time = 0;
    const callbacks = new Map();
    const inputs = new Map();
    const renders = [];
    const chatClasses = new Set();
    const themeWrites = [];
    const documentRef = {
        querySelector:()=>({classList:{
            add(name) { themeWrites.push(['add', name]); chatClasses.add(name); },
            remove(name) { themeWrites.push(['remove', name]); chatClasses.delete(name); },
        }}),
        addEventListener(name, fn, options) {
            assert.deepEqual(options, { passive: true, capture: true });
            inputs.set(name, fn);
        },
        removeEventListener(name, fn) { if (inputs.get(name) === fn) inputs.delete(name); },
    };
    const eventTypes = { STREAM_TOKEN_RECEIVED: 'token', GENERATION_ENDED: 'end', GENERATION_STOPPED: 'stop', CHAT_CHANGED: 'chat' };
    const eventSource = {
        on(name, fn) { callbacks.set(name, fn); },
        removeListener(name, fn) { if (callbacks.get(name) === fn) callbacks.delete(name); },
    };
    class Processor {
        constructor() { this.type = 'normal'; this.result = ''; }
        async onProgressStreaming(...args) {
            assert.ok(this instanceof Processor, 'native method keeps its receiver');
            renders.push(args);
            time += cost;
            if (this.error) throw this.error;
            return args[1];
        }
        async finalizeIntermediaryMessage(id, text) { return this.onProgressStreaming(id, text, true); }
    }
    let processor = new Processor();
    const original = processor.onProgressStreaming;
    const optimizer = new StreamingRenderOptimizer({
        eventSource, eventTypes, getStreamingProcessor: () => processor,
        now: () => time,
        navigatorRef: touch ? { userAgent: 'iPhone', maxTouchPoints: 5 } : {},
        matchMedia: () => ({ matches: false }),
        documentRef,
    });
    optimizer.start();
    t.after(() => optimizer.stop());
    return {
        optimizer, renders, inputs, callbacks, original, Processor, chatClasses, documentRef, themeWrites,
        get processor() { return processor; }, set processor(value) { processor = value; },
        set time(value) { time = value; },
        input(name, data = {}) { inputs.get(name)?.(data); },
        emit(name) { callbacks.get(name)?.(); },
        async token(text, at) {
            time = at;
            processor.result = text; // Native generator updates this before token subscribers.
            callbacks.get('token')?.();
            return processor.onProgressStreaming(7, text);
        },
    };
}

const chatTarget = { closest: selector => selector === '#chat' };
const finger = (x, y = 0) => ({ identifier: 1, clientX: x, clientY: y });

test('coalesces only intermediate previews and always formats the entire final snapshot', async t => {
    const f = fixture(t);
    for (let i = 0; i < 120; i++) await f.token(`snapshot-${i}`, i * 10);
    assert.equal(f.renders.length, 12);
    assert.equal(f.processor.result, 'snapshot-119');
    assert.equal(await f.processor.finalizeIntermediaryMessage(7, 'complete message'), 'complete message');
    assert.deepEqual(f.renders.at(-1), [7, 'complete message', true]);
    await f.processor.onProgressStreaming(7, 'next tool preview');
    assert.equal(f.renders.at(-1)[1], 'next tool preview');
});

test('keeps native slow refresh intervals and gives desktop a larger preview budget', async t => {
    const f = fixture(t, { touch: false });
    for (let i = 0; i < 100; i++) await f.token('x', i * 10);
    assert.equal(f.renders.length, 25);
    f.renders.length = 0;
    for (let i = 0; i < 10; i++) await f.token('slow', 2000 + i * 200);
    assert.equal(f.renders.length, 10);
});

test('expensive native passes leave recovery time instead of running at the FPS ceiling', async t => {
    const f = fixture(t, { cost: 30 });
    for (let i = 0; i < 20; i++) await f.token('x', i * 40);
    assert.equal(f.renders.length, 5);
    await f.processor.finalizeIntermediaryMessage(7, 'final');
    assert.equal(f.renders.at(-1)[1], 'final');
});

test('taps and native autoscroll do not trigger the scrolling budget', async t => {
    const f = fixture(t);
    f.input('touchstart', { target: chatTarget, touches: [finger(0)] });
    f.input('touchmove', { touches: [finger(4)] });
    f.input('scroll', { target: { id: 'chat' } });
    for (let i = 0; i < 5; i++) await f.token('x', i * 100);
    assert.equal(f.renders.length, 5);
});

test('actual chat drags and inertial scrolling reduce previews, then recover automatically', async t => {
    const f = fixture(t);
    f.input('touchstart', { target: chatTarget, touches: [finger(0)] });
    f.input('touchmove', { touches: [finger(0, 12)] });
    await f.token('first', 0);
    await f.token('skipped', 60);
    f.time = 160;
    f.input('touchend');
    f.input('scroll', { target: { id: 'chat' } });
    await f.token('second', 260);
    await f.token('skipped again', 300);
    await f.processor.finalizeIntermediaryMessage(7, 'final during scroll');
    await f.token('recovered', 500);
    await f.token('normal tier', 600);
    assert.deepEqual(f.renders.map(args => args[1]), ['first', 'second', 'final during scroll', 'recovered', 'normal tier']);
});

test('wheel outside chat and a cancelled/multi-touch gesture do not enter scroll mode', async t => {
    const f = fixture(t);
    f.input('wheel', { target: { closest: () => false } });
    f.input('touchstart', { target: chatTarget, touches: [finger(0)] });
    f.input('touchcancel');
    f.input('touchmove', { touches: [finger(30)] });
    f.input('touchstart', { target: chatTarget, touches: [finger(0), finger(1)] });
    f.input('touchmove', { touches: [finger(30)] });
    for (let i = 0; i < 5; i++) await f.token('x', i * 100);
    assert.equal(f.renders.length, 5);
    f.input('wheel', { target: chatTarget });
    await f.token('wheel', 500);
    await f.token('skipped', 550);
    assert.equal(f.renders.length, 6);
});

test('new message IDs and final passes bypass the preview deadline', async t => {
    const f = fixture(t);
    await f.token('x', 0);
    await f.processor.onProgressStreaming(8, 'tool reply');
    await f.processor.onProgressStreaming(8, 'final', true, { extra: 1 });
    assert.deepEqual(f.renders, [[7, 'x'], [8, 'tool reply'], [8, 'final', true, { extra: 1 }]]);
});

test('native autoscroll cannot indefinitely extend the post-gesture budget', async t => {
    const f = fixture(t);
    f.input('wheel', { target: chatTarget });
    for (let time = 0; time <= 1000; time += 100) {
        f.time = time;
        f.input('scroll', { target: { id: 'chat' } });
    }
    await f.token('normal', 1000);
    await f.token('normal again', 1100);
    assert.equal(f.renders.length, 2);
});

test('a render slower than the previous 125ms cap still gets idle time after it completes',async t=>{
    const f=fixture(t,{cost:300});
    await f.token('slow',0); // finishes at 300; recovery is 600ms.
    await f.token('must skip',301);
    await f.token('still idle',899);
    assert.equal(f.renders.length,1);
    await f.token('next full snapshot',900);
    assert.equal(f.renders.length,2);
    const report=f.optimizer.getReport();
    assert.equal(report.maxPreviewMs,300);
    assert.equal(report.maxRecoveryMs,600);
    assert.equal(report.skippedPreviews,2);
    await f.processor.finalizeIntermediaryMessage(7,'complete');
    assert.equal(f.renders.at(-1)[1],'complete');
});

test('pointer interaction reserves time for controls while finalization remains immediate',async t=>{
    const f=fixture(t);
    await f.token('initial',0);
    f.time=100;f.input('pointerdown');
    await f.token('paused for menu',150);
    await f.processor.finalizeIntermediaryMessage(7,'final');
    assert.equal(f.renders.at(-1)[1],'final');
    await f.token('resumed',300);
    assert.equal(f.renders.at(-1)[1],'resumed');
});

test('streaming keeps theme classes untouched on touch and desktop throughout its lifecycle', async t => {
    for (const touch of [true, false]) {
        const f = fixture(t, { touch });
        await f.token('preview', 0);
        await f.token('coalesced', 10);
        assert.equal(f.renders.length, 1, 'preview throttling stays active');
        for (const event of ['chat', 'token', 'stop', 'token', 'end']) f.emit(event);
        f.optimizer.stop();
        assert.deepEqual(f.themeWrites, [], 'never adds even a temporary glass override');
        assert.equal(f.chatClasses.size, 0);
    }
});

test('stop, end and chat switch restore native ownership without delayed DOM work', async t => {
    const f = fixture(t);
    for (const name of ['stop', 'end', 'chat']) {
        await f.token('preview', 0);
        await f.token('coalesced', 10);
        f.emit(name);
        assert.equal(f.processor.onProgressStreaming, f.original);
        assert.equal(Object.hasOwn(f.processor, 'onProgressStreaming'), false);
        await f.processor.finalizeIntermediaryMessage(7, `final after ${name}`);
        assert.equal(f.renders.at(-1)[1], `final after ${name}`);
    }
    f.optimizer.stop();
    assert.equal(f.inputs.size, 0);
    assert.equal(f.callbacks.size, 0);
});

test('replaced processors restore the previous one and start with a fresh preview', async t => {
    const f = fixture(t);
    const previous = f.processor;
    await f.token('old', 0);
    f.processor = new f.Processor();
    await f.token('new', 1);
    assert.equal(previous.onProgressStreaming, f.original);
    assert.equal(f.renders.at(-1)[1], 'new');
});

test('unknown processors, impersonation and read-only methods stay native', t => {
    const f = fixture(t);
    for (const processor of [null, { onProgressStreaming() {} }, Object.freeze(new f.Processor())]) {
        f.processor = processor;
        f.emit('token');
        assert.equal(f.optimizer.current, null);
    }
    f.processor = new f.Processor();
    f.processor.type = 'impersonate';
    f.emit('token');
    assert.equal(f.processor.onProgressStreaming, f.original);
});

test('cleanup preserves instance descriptors and later wrappers installed by other extensions', t => {
    const f = fixture(t);
    f.optimizer.detach();
    Object.defineProperty(f.processor, 'onProgressStreaming', { value: f.original, configurable: true, writable: true, enumerable: false });
    const descriptor = Object.getOwnPropertyDescriptor(f.processor, 'onProgressStreaming');
    f.emit('token');
    f.emit('token');
    f.optimizer.detach();
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.processor, 'onProgressStreaming'), descriptor);
    f.emit('token');
    const ours = f.processor.onProgressStreaming;
    const later = function (...args) { return ours.apply(this, args); };
    f.processor.onProgressStreaming = later;
    f.optimizer.stop();
    assert.equal(f.processor.onProgressStreaming, later);
});

test('native rejections and non-preview arguments pass through unchanged', async t => {
    const f = fixture(t);
    const error = new Error('native failure');
    f.processor.error = error;
    await assert.rejects(f.token('error', 0), candidate => candidate === error);
    delete f.processor.error;
    await f.processor.onProgressStreaming(-1, null, false);
    assert.deepEqual(f.renders.at(-1), [-1, null, false]);
});

const scrollRoot = () => ({
    id: 'chat',
    classList: {
        add() { assert.fail('scrolling must not add theme overrides'); },
        remove() { assert.fail('scrolling must not modify theme classes'); },
    },
});

test('ordinary scrolling without generation never changes the theme or renders messages', t => {
    for (const touch of [true, false]) {
        const f = fixture(t, { touch });
        f.processor = null;
        f.emit('end');
        const chat = scrollRoot();
        f.input('scroll', { target: chat });
        f.time = 180;
        f.input('scroll', { target: chat });
        f.input('wheel', { target: { closest: () => chat } });
        f.emit('chat');
        f.optimizer.stop();
        assert.equal(f.optimizer.current, null);
        assert.equal(f.renders.length, 0);
        assert.deepEqual(f.themeWrites, []);
        assert.equal(f.inputs.size, 0);
    }
});

test('touch drag and wheel retain scroll throttling without changing glass appearance', async t => {
    for (const input of ['touch', 'wheel']) {
        const f = fixture(t);
        const chat = scrollRoot();
        const target = { closest: () => chat };
        if (input === 'touch') {
            f.input('touchstart', { target, touches: [finger(0)] });
            f.input('touchmove', { touches: [finger(12)] });
        } else f.input('wheel', { target });
        await f.token('first', 0);
        f.input('scroll', { target: chat });
        await f.token('skipped during scroll', 100);
        await f.token('scroll preview', 250);
        await f.processor.finalizeIntermediaryMessage(7, 'full final message');
        assert.deepEqual(f.renders.map(args => args[1]), ['first', 'scroll preview', 'full final message']);
        f.input('touchend');
        f.optimizer.stop();
        assert.deepEqual(f.themeWrites, []);
    }
});
