import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatOptimizer, hasRenderedChatTail } from '../modules/chat-optimizer.js';

function createChatElement(lastId) {
    const listeners = new Map();
    const lastMessage = {
        getAttribute(name) {
            return name === 'mesid' ? String(lastId) : null;
        },
    };
    return {
        querySelectorAll() {
            return lastId === null ? [] : [lastMessage];
        },
        addEventListener(type, handler) {
            listeners.set(type, handler);
        },
        removeEventListener(type, handler) {
            if (listeners.get(type) === handler) listeners.delete(type);
        },
        dispatch(type) {
            listeners.get(type)?.();
        },
        listeners,
    };
}

test('recognizes only a rendered final chat message as the initial tail', () => {
    assert.equal(hasRenderedChatTail(createChatElement(32), 32), true);
    assert.equal(hasRenderedChatTail(createChatElement(31), 32), false);
    assert.equal(hasRenderedChatTail(createChatElement(null), 32), false);
});

test('settles a switched chat with the official scroll helper and stops on user input', () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let nextTimer = 1;
    const timers = new Map();
    globalThis.setTimeout = (callback, delay) => {
        const id = nextTimer++;
        timers.set(id, { callback, delay });
        return id;
    };
    globalThis.clearTimeout = id => timers.delete(id);

    try {
        const chatElement = createChatElement(32);
        const scrollCalls = [];
        const optimizer = new ChatOptimizer({
            chat: Array.from({ length: 33 }, (_, id) => ({ id })),
            scrollToBottom: options => scrollCalls.push(options),
        });
        optimizer.started = true;
        optimizer.chatElement = chatElement;
        optimizer.settleInitialBottom();

        const firstTimer = [...timers].sort((left, right) => left[1].delay - right[1].delay)[0];
        timers.delete(firstTimer[0]);
        firstTimer[1].callback();
        assert.deepEqual(scrollCalls, [{ waitForFrame: true }]);

        chatElement.dispatch('pointerdown');
        for (const [, task] of [...timers]) task.callback();
        assert.equal(scrollCalls.length, 1);
        assert.equal(timers.size, 0);
        assert.equal(chatElement.listeners.size, 0);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});
