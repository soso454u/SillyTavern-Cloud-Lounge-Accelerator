import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatScrollActivity } from '../modules/chat-scroll-activity.js';

function fixture(t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const listeners = new Map();
    const chatListeners = new Map();
    let resumes = 0;
    const target = {};
    const chat = {
        addEventListener(name, callback, options) {
            assert.deepEqual(options, { passive: true });
            chatListeners.set(name, callback);
        },
        removeEventListener(name, callback) {
            if (chatListeners.get(name) === callback) chatListeners.delete(name);
        },
        getBoundingClientRect() { assert.fail('must not measure layout'); },
    };
    const document = {
        hidden: false,
        addEventListener(name, callback) { listeners.set(name, callback); },
        removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); },
    };
    const activity = new ChatScrollActivity({ documentRef: document, now: () => Date.now(), onIdle: () => resumes++ });
    activity.start(chat);
    t.after(() => activity.stop());
    return { activity, chat, target, document, listeners, chatListeners, get resumes() { return resumes; },
        emit: (name, target) => listeners.get(name)?.({ target }),
        emitChat: (name, target) => chatListeners.get(name)?.({ target }),
    };
}

test('chat momentum scrolling holds background code work until the last scroll settles', t => {
    const f = fixture(t);
    for (let frame = 0; frame < 30; frame++) {
        f.emitChat('scroll', f.chat);
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
    f.emitChat('wheel', f.target);
    assert.equal(f.activity.active, true);
    t.mock.timers.tick(180);
    assert.equal(f.resumes, 1);
});

test('background, stop and reenable release pending waits and listeners', t => {
    const f = fixture(t);
    f.emitChat('scroll', f.chat);
    f.document.hidden = true;
    f.emit('visibilitychange');
    t.mock.timers.tick(1000);
    assert.equal(f.activity.active, false);
    assert.equal(f.resumes, 0);
    f.document.hidden = false;
    f.emit('visibilitychange');
    assert.equal(f.resumes, 1);
    f.emitChat('scroll', f.chat);
    f.activity.stop();
    t.mock.timers.tick(1000);
    assert.equal(f.resumes, 1);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.chatListeners.size, 0);
    f.activity.start(f.chat);
    f.activity.start(f.chat);
    assert.equal(f.listeners.size, 1);
    assert.equal(f.chatListeners.size, 2);
    f.activity.bind(null);
    assert.equal(f.chatListeners.size, 0);
});
