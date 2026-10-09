import test from 'node:test';
import assert from 'node:assert/strict';
import { RegexRefreshController } from '../modules/regex-refresh.js';

test('missing rendering API preserves the entire chat without a network reload', async () => {
    const chat = Object.freeze(Array.from({ length: 1000 }, (_, id) => Object.freeze({ mes: `message-${id}` })));
    let reloads = 0;
    const controller = new RegexRefreshController({
        chat,
        reloadCurrentChat: () => { reloads += 1; },
        importChatApi: async () => ({}),
    });
    const result = await controller.reapply();
    assert.equal(result.unavailable, true);
    assert.equal(reloads, 0);
    assert.equal(chat.length, 1000);
    assert.equal(chat[999].mes, 'message-999');
});

test('stops a queued regex refresh when another chat becomes active', async () => {
    let chatId = 'a';
    let resume;
    let updates = 0;
    const controller = new RegexRefreshController({
        chat: [{ mes: 'a' }],
        getCurrentChatId: () => chatId,
        importChatApi: async () => ({ updateMessageBlock: () => { updates += 1; } }),
        scheduler: { yield: () => new Promise(resolve => { resume = resolve; }) },
    });
    controller.getDescriptors = () => [{ messageId: 0, visible: true, complexity: 1 }];
    const pending = controller.reapply();
    await Promise.resolve();
    chatId = 'b';
    resume();
    assert.equal((await pending).cancelled, true);
    assert.equal(updates, 0);
});

test('stopping the controller cancels a refresh awaiting the native module', async () => {
    let resolveApi;
    const controller = new RegexRefreshController({
        chat: [{}],
        importChatApi: () => new Promise(resolve => { resolveApi = resolve; }),
    });
    controller.getDescriptors = () => assert.fail('stopped refresh must not inspect the current chat');
    const pending = controller.reapply();
    controller.stop();
    resolveApi({ updateMessageBlock() {} });
    assert.equal((await pending).cancelled, true);
});
