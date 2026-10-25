import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingRenderOptimizer } from '../modules/streaming-render-optimizer.js';

function fixture(t, { touch = true, cost = 0 } = {}) {
    let time = 0;
    const callbacks = new Map();
    const inputs = new Map();
    const renders = [];
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
        documentRef: {
            addEventListener(name, fn, options) {
                assert.deepEqual(options, { passive: true, capture: true });
                inputs.set(name, fn);
            },
            removeEventListener(name, fn) { if (inputs.get(name) === fn) inputs.delete(name); },
        },
    });
    optimizer.start();
    t.after(() => optimizer.stop());
    return {
        optimizer, renders, inputs, callbacks, original, Processor,
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
    assert.equal(f.renders.length, 24);
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
    assert.equal(f.renders.length, 7);
    await f.processor.finalizeIntermediaryMessage(7, 'final');
    assert.equal(f.renders.at(-1)[1], 'final');
});

test('taps and native autoscroll do not trigger the scrolling budget', async t => {
    const f = fixture(t);
    f.input('touchstart', { target: chatTarget, touches: [finger(0)] });
    f.input('touchmove', { touches: [finger(4)] });
    f.input('scroll', { target: { id: 'chat' } });
    for (let i = 0; i < 5; i++) await f.token('x', i * 50);
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
    await f.token('second', 170);
    await f.token('skipped again', 230);
    await f.processor.finalizeIntermediaryMessage(7, 'final during scroll');
    await f.token('recovered', 500);
    await f.token('normal tier', 550);
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
    for (let i = 0; i < 5; i++) await f.token('x', i * 50);
    assert.equal(f.renders.length, 5);
    f.input('wheel', { target: chatTarget });
    await f.token('wheel', 300);
    await f.token('skipped', 350);
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
    await f.token('normal again', 1050);
    assert.equal(f.renders.length, 2);
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
