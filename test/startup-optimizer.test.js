import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { shouldRevealUiBeforeReady, StartupOptimizer } from '../modules/startup-optimizer.js';

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

test('passes startup user-library responses through without cloning or retaining them', async t => {
    const originals = { window: globalThis.window, location: globalThis.location, document: globalThis.document };
    let clones = 0;
    let calls = 0;
    const response = { ok: true, clone() { clones += 1; return this; } };
    globalThis.location = { href: 'https://example.test/' };
    globalThis.document = { body: { classList: { remove() {} } } };
    globalThis.window = {
        fetch: async () => { calls += 1; return response; },
        addEventListener() {}, removeEventListener() {},
    };
    t.after(() => {
        for (const [name, value] of Object.entries(originals)) {
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
        }
    });
    const optimizer = new StartupOptimizer({ eventSource: { on() {}, removeListener() {} }, eventTypes: {} });
    optimizer.start();
    for (const path of ['/api/characters/all', '/api/avatars/get', '/api/backgrounds/all']) {
        assert.equal(await window.fetch(path, { method: 'POST', body: '{}' }), response);
    }
    assert.equal(calls, 3);
    assert.equal(clones, 0);
    assert.equal(optimizer.entries.size, 0);
    optimizer.stop();
});

test('keeps the native startup blocker until APP_READY on iPhone and iPad', async () => {
    const iosNavigator = {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
        platform: 'iPhone',
        maxTouchPoints: 5,
    };
    assert.equal(shouldRevealUiBeforeReady({ navigatorRef: iosNavigator, matchMediaRef: () => ({ matches: true }) }), false);
    assert.equal(shouldRevealUiBeforeReady({
        navigatorRef: { userAgent: 'Mozilla/5.0 Chrome/140', platform: 'Linux x86_64', maxTouchPoints: 0 },
        matchMediaRef: () => ({ matches: false }),
    }), true);

    let loaderImports = 0;
    const optimizer = new StartupOptimizer({
        allowEarlyUi: () => false,
        importActionLoader: async () => {
            loaderImports += 1;
            return { loader: { active: () => [] } };
        },
    });
    optimizer.started = true;
    optimizer.startupFeatures = true;
    await optimizer.onSettingsLoaded();
    assert.equal(loaderImports, 0, 'iOS must not expose controls before SillyTavern has bound them');
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

test('never clones or reparses full chat payloads for side-channel metrics', async () => {
    const source = await readFile(new URL('../modules/startup-optimizer.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /observe-chat|onChatPayload|inspectChatResponse/);
    assert.doesNotMatch(source, /cloneResponse\(response\).*inspectChat/s);
});
