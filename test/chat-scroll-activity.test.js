import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatScrollActivity } from '../modules/chat-scroll-activity.js';

function fixture(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const listeners = new Map();
    let resumes = 0;
    const target = {};
    const chat = { contains: node => node === target, getBoundingClientRect() { assert.fail('must not measure layout'); } };
    const document = {
        hidden: false,
        addEventListener(name, callback, options) { assert.deepEqual(options, { capture: true, passive: true }); listeners.set(name, callback); },
        removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); },
    };
    const activity = new ChatScrollActivity({ documentRef: document, getChatElement: () => chat, onIdle: () => resumes++ });
    activity.start();
    t.after(() => activity.stop());
    return { activity, chat, target, document, listeners, get resumes() { return resumes; }, emit: (name, target) => listeners.get(name)?.({ target }) };
}

test('chat momentum scrolling holds background code work until the last scroll settles', t => {
    const f = fixture(t);
    for (let frame = 0; frame < 30; frame++) {
        f.emit('scroll', f.chat);
        t.mock.timers.tick(16);
        assert.equal(f.activity.active, true);
        assert.equal(f.resumes, 0);
    }
    t.mock.timers.tick(163);
    assert.equal(f.resumes, 0);
    t.mock.timers.tick(1);
    assert.equal(f.resumes, 1);
    assert.equal(f.activity.active, false);
    t.mock.timers.tick(5000);
    assert.equal(f.resumes, 1, 'idle pages have no recurring wakeups');
});

test('wheel inside chat reserves the first frame; other plugin scrolling does not block chat work', t => {
    const f = fixture(t);
    f.emit('scroll', {});
    f.emit('wheel', {});
    assert.equal(f.activity.active, false);
    f.emit('wheel', f.target);
    assert.equal(f.activity.active, true);
    t.mock.timers.tick(180);
    assert.equal(f.resumes, 1);
});

test('background, stop and reenable release pending waits and listeners', t => {
    const f = fixture(t);
    f.emit('scroll', f.chat);
    f.document.hidden = true;
    f.emit('visibilitychange');
    t.mock.timers.tick(1000);
    assert.equal(f.activity.active, false);
    assert.equal(f.resumes, 0);
    f.document.hidden = false;
    f.emit('visibilitychange');
    assert.equal(f.resumes, 1);
    f.emit('scroll', f.chat);
    f.activity.stop();
    t.mock.timers.tick(1000);
    assert.equal(f.resumes, 1);
    assert.equal(f.listeners.size, 0);
    f.activity.start();
    f.activity.start();
    assert.equal(f.listeners.size, 3);
});
