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

test('passes user libraries, settings and full chats through without cloning or retaining them', async t => {
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
    for (const path of ['/api/characters/all', '/api/avatars/get', '/api/backgrounds/all',
        '/api/settings/get', '/api/chats/get', '/api/chats/group/get']) {
        assert.equal(await window.fetch(path, { method: 'POST', body: '{}' }), response);
    }
    assert.equal(calls, 6);
    assert.equal(clones, 0);
    assert.equal(optimizer.entries.size, 0);
    optimizer.stop();
});

test('startup events and reconnect never hide the loader or recover / clear a chat', async t => {
    const originals = { window: globalThis.window, location: globalThis.location, document: globalThis.document };
    const events = new Map();
    const windowEvents = new Map();
    let requests = 0;
    globalThis.location = { href: 'https://example.test/' };
    globalThis.document = {
        querySelector: () => null,
        body: {},
        createElement() { assert.fail('startup must not inject recovery UI'); },
    };
    globalThis.window = {
        fetch: async () => { requests += 1; throw new Error('offline'); },
        addEventListener: (name, handler) => windowEvents.set(name, handler),
        removeEventListener: name => windowEvents.delete(name),
    };
    t.after(() => {
        for (const [name, value] of Object.entries(originals)) {
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
        }
    });
    const eventSource = {
        on(name, handler) { events.set(name, [...(events.get(name) || []), handler]); },
        removeListener(name, handler) { events.set(name, (events.get(name) || []).filter(item => item !== handler)); },
        async emit(name) { for (const handler of events.get(name) || []) await handler(); },
    };
    for (const startupFeatures of [true, false]) {
        const optimizer = new StartupOptimizer({
            eventSource, eventTypes: { SETTINGS_LOADED: 'settings', APP_READY: 'ready' },
        });
        optimizer.start({ startupFeatures });
        await eventSource.emit('settings');
        // APP_READY with a blank chat, then a role switch and reconnection.
        await eventSource.emit('ready');
        await eventSource.emit('chat_changed');
        windowEvents.get('online')?.();
        assert.equal(requests, 0);
        assert.equal(windowEvents.has('online'), false);
        optimizer.stop();
    }
    const source = await readFile(new URL('../modules/startup-optimizer.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /action-loader|welcome-screen|openWelcomeScreen|recoverWelcomeScreen|loader\.hide/);
});

test('never clones or reparses full chat payloads for side-channel metrics', async () => {
    const source = await readFile(new URL('../modules/startup-optimizer.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /observe-chat|onChatPayload|inspectChatResponse/);
    assert.doesNotMatch(source, /cloneResponse\(response\).*inspectChat/s);
});

test('chat read failures stay failures and save requests retain their original payload', async t => {
    const originals = { window: globalThis.window, location: globalThis.location };
    const failure = new Error('network failure');
    const response = {
        ok: false, status: 500,
        clone() { assert.fail('must not clone a failed chat'); },
        json() { assert.fail('must not interpret a failed chat as an empty chat'); },
    };
    const calls = [];
    globalThis.location = { href: 'https://example.test/' };
    globalThis.window = {
        fetch: async (input, init) => {
            calls.push({ input, init });
            if (init.signal) throw failure;
            return response;
        },
    };
    t.after(() => {
        for (const [name, value] of Object.entries(originals)) {
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
        }
    });
    const optimizer = new StartupOptimizer({});
    optimizer.installFetchCoordinator();
    for (const path of ['/api/chats/get', '/api/chats/group/get']) {
        const init = { method: 'POST', body: '{"file_name":"fixture"}' };
        assert.equal(await window.fetch(path, init), response);
        assert.deepEqual(calls.at(-1), { input: path, init });
        await assert.rejects(window.fetch(path, { ...init, signal: new AbortController().signal }), value => value === failure);
    }
    for (const path of ['/api/chats/save', '/api/chats/group/save']) {
        const init = { method: 'POST', body: '{"chat":[{"mes":"fixture"}]}' };
        assert.equal(await window.fetch(path, init), response);
        assert.equal(calls.at(-1).init, init);
        assert.equal(calls.at(-1).init.body, init.body);
    }
    assert.equal(calls.length, 6, 'no recovery reads, automatic saves or retries');
    assert.equal(optimizer.entries.size, 0);
});

test('completed startup diagnostics do not inspect later native fetch responses', async t => {
    const originals = { window: globalThis.window, location: globalThis.location };
    const response = {
        get status() { assert.fail('completed diagnostics must not inspect status'); },
        get headers() { assert.fail('completed diagnostics must not inspect headers'); },
    };
    globalThis.location = { href: 'https://example.test/' };
    globalThis.window = { fetch: async () => response };
    t.after(() => {
        for (const [name, value] of Object.entries(originals)) {
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
        }
    });
    const optimizer = new StartupOptimizer({ diagnostics: {
        started: true, completed: true,
        noteRequest() { assert.fail('completed diagnostics must not record requests'); },
    } });
    optimizer.installFetchCoordinator();
    assert.equal(await window.fetch('/api/settings/get', { method: 'POST', body: '{}' }), response);
    window.fetch = optimizer.nativeFetch;
});
