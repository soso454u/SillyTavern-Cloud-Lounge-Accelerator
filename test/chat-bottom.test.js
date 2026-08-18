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
        scrollHeight: 2400,
        scrollCalls: [],
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
        scrollTo(left, top) {
            this.scrollCalls.push([left, top]);
        },
        listeners,
    };
}

test('recognizes only a rendered final chat message as the initial tail', () => {
    assert.equal(hasRenderedChatTail(createChatElement(32), 32), true);
    assert.equal(hasRenderedChatTail(createChatElement(31), 32), false);
    assert.equal(hasRenderedChatTail(createChatElement(null), 32), false);
});

test('settles a switched chat synchronously and stops on user input', () => {
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
        assert.deepEqual(scrollCalls, [{ waitForFrame: false }]);
        assert.deepEqual(chatElement.scrollCalls, [[0, 2400]]);

        chatElement.dispatch('click');
        for (const [, task] of [...timers]) task.callback();
        assert.equal(scrollCalls.length, 1);
        assert.equal(chatElement.scrollCalls.length, 1);
        assert.equal(timers.size, 0);
        assert.equal(chatElement.listeners.size, 0);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});

test('settles only once per actual chat entry and not for same-chat history updates', () => {
    let currentChatId = 'chat-a';
    const optimizer = new ChatOptimizer({
        chat: [{ id: 1 }],
        getCurrentChatId: () => currentChatId,
    });
    optimizer.started = true;
    optimizer.inspectPayload = () => {};
    optimizer.refreshChatBindings = () => {};
    let settleCalls = 0;
    let cancelCalls = 0;
    optimizer.settleInitialBottom = () => settleCalls++;
    optimizer.cancelInitialBottom = () => cancelCalls++;

    optimizer.handleChatChanged();
    optimizer.handleChatChanged();
    assert.equal(settleCalls, 1, 'same-chat events must not restart initial auto-scroll');

    currentChatId = 'chat-b';
    optimizer.handleChatChanged();
    assert.equal(settleCalls, 2, 'switching chats should settle the new chat once');

    currentChatId = null;
    optimizer.handleChatChanged();
    assert.equal(cancelCalls, 1, 'leaving chat cancels pending initial auto-scroll');

    currentChatId = 'chat-a';
    optimizer.handleChatChanged();
    assert.equal(settleCalls, 3, 're-entering a chat should settle it again');
});

test('claims history pagination as the current chat before a following chat event', () => {
    const optimizer = new ChatOptimizer({
        chat: [{ id: 1 }],
        getCurrentChatId: () => 'chat-a',
    });
    optimizer.started = true;
    optimizer.inspectPayload = () => {};
    optimizer.refreshChatBindings = () => {};
    let settleCalls = 0;
    let cancelCalls = 0;
    optimizer.settleInitialBottom = () => settleCalls++;
    optimizer.cancelInitialBottom = () => cancelCalls++;

    optimizer.handleMoreMessagesLoaded();
    optimizer.handleChatChanged();

    assert.equal(optimizer.activeChatKey, 'chat-a');
    assert.equal(cancelCalls, 1);
    assert.equal(settleCalls, 0, 'history pagination must not become an initial-entry bottom settle');
});

test('does not force the welcome screen to the bottom', () => {
    const chatElement = createChatElement(1);
    const optimizer = new ChatOptimizer({
        chat: [{}, {}],
        getCurrentChatId: () => undefined,
        scrollToBottom: () => assert.fail('welcome screen must keep its native position'),
    });
    optimizer.started = true;
    optimizer.chatElement = chatElement;
    optimizer.settleInitialBottom();
    assert.deepEqual(chatElement.scrollCalls, []);
});
