import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { StartupOptimizer } from '../modules/startup-optimizer.js';

function descriptor() {
    return {
        method: 'POST',
        url: new URL('https://example.test/api/chats/recent'),
        body: '{"max":15,"pinned":[]}',
        headers: { 'content-type': 'application/json' },
        credentials: '',
        cache: 'no-cache',
        mode: '',
        reusable: true,
    };
}

test('returns the previous recent-chat response while refreshing it in background', async () => {
    const optimizer = new StartupOptimizer({});
    optimizer.started = true;
    let calls = 0;
    const nativeFetch = async () => {
        calls += 1;
        return Response.json([{ version: calls }]);
    };

    const first = await optimizer.fetchRecentChats(nativeFetch, '/api/chats/recent', {}, descriptor());
    assert.deepEqual(await first.json(), [{ version: 1 }]);

    const second = await optimizer.fetchRecentChats(nativeFetch, '/api/chats/recent', {}, descriptor());
    assert.deepEqual(await second.json(), [{ version: 1 }]);
    await optimizer.recentPending.values().next().value;

    const third = await optimizer.fetchRecentChats(nativeFetch, '/api/chats/recent', {}, descriptor());
    assert.deepEqual(await third.json(), [{ version: 2 }]);
    assert.equal(calls, 3);
});

test('deduplicates simultaneous first recent-chat requests', async () => {
    const optimizer = new StartupOptimizer({});
    optimizer.started = true;
    let resolveRequest;
    let calls = 0;
    const nativeFetch = () => {
        calls += 1;
        return new Promise(resolve => { resolveRequest = resolve; });
    };

    const first = optimizer.fetchRecentChats(nativeFetch, '/api/chats/recent', {}, descriptor());
    const second = optimizer.fetchRecentChats(nativeFetch, '/api/chats/recent', {}, descriptor());
    resolveRequest(Response.json([{ version: 1 }]));

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.deepEqual(await firstResponse.json(), [{ version: 1 }]);
    assert.deepEqual(await secondResponse.json(), [{ version: 1 }]);
    assert.equal(calls, 1);
});

test('keeps welcome recovery out of the chat layout and uses a short top notice', async () => {
    const [source, styles] = await Promise.all([
        readFile(new URL('../modules/startup-optimizer.js', import.meta.url), 'utf8'),
        readFile(new URL('../style.css', import.meta.url), 'utf8'),
    ]);
    assert.doesNotMatch(source, /cla-welcome-placeholder|showWelcomePlaceholder|重新读取最近聊天/);
    assert.doesNotMatch(styles, /\.cla-welcome-placeholder/);
    assert.match(source, /BACKGROUND_NOTICE_MS = 1800/);
    const noticeStyles = styles.match(/\.cla-background-init-banner\s*\{[^}]*\}/)?.[0] || '';
    assert.match(noticeStyles, /top:/);
    assert.doesNotMatch(noticeStyles, /bottom:/);
});
