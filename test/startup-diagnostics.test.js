import test from 'node:test';
import assert from 'node:assert/strict';

import { safeStartupEndpoint, StartupDiagnostics } from '../modules/startup-diagnostics.js';

function emitter() {
    const listeners = new Map();
    return {
        on(name, handler) {
            const handlers = listeners.get(name) || [];
            handlers.push(handler);
            listeners.set(name, handlers);
        },
        removeListener(name, handler) {
            listeners.set(name, (listeners.get(name) || []).filter(item => item !== handler));
        },
        emit(name) {
            for (const handler of listeners.get(name) || []) handler();
        },
    };
}

function memoryStorage() {
    const values = new Map();
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
}

test('startup endpoint labels never retain query strings or user-specific paths', () => {
    const locationRef = { origin: 'https://example.test' };
    assert.equal(safeStartupEndpoint('/api/settings/get?token=secret', locationRef), '/api/settings/get');
    assert.equal(safeStartupEndpoint('/api/chats/get/private-chat.jsonl?key=secret', locationRef), '/api/…');
    assert.equal(safeStartupEndpoint('/characters/Alice.png', locationRef), '/characters/…');
});

test('records official startup markers, slow requests, and the 30 second boundary', () => {
    const eventSource = emitter();
    const eventTypes = {
        SETTINGS_LOADED: 'settings',
        APP_INITIALIZED: 'initialized',
        APP_READY: 'ready',
    };
    const storage = memoryStorage();
    let elapsed = 1200;
    const diagnostics = new StartupDiagnostics({
        eventSource,
        eventTypes,
        documentRef: { body: {}, querySelector: () => null },
        locationRef: { origin: 'https://example.test' },
        storage,
        performanceRef: { now: () => elapsed },
        PerformanceObserverRef: null,
        MutationObserverRef: null,
        setTimer: () => 1,
        clearTimer() {},
        now: () => 1000,
    });

    diagnostics.start();
    elapsed = 8000;
    eventSource.emit('settings');
    diagnostics.noteRequest({
        input: '/api/chats/get/private.jsonl?token=secret',
        method: 'POST',
        durationMs: 2200,
        status: 200,
    });
    diagnostics.noteRequest({
        input: '/api/settings/get',
        method: 'POST',
        durationMs: 320,
        status: 200,
        responseBytes: 6660000,
        contentEncoding: 'br',
        initiator: 'at QuickReply.init (extensions/quick-reply/index.js:1:1)',
    });
    elapsed = 31000;
    eventSource.emit('initialized');
    elapsed = 32100;
    eventSource.emit('ready');

    const report = diagnostics.getReport();
    assert.deepEqual(report.markers, {
        PLUGIN_ACTIVATED: 1200,
        SETTINGS_LOADED: 8000,
        APP_INITIALIZED: 31000,
        APP_READY: 32100,
    });
    assert.equal(report.slow, true);
    assert.deepEqual(report.slowRequests, [{
        endpoint: '/api/…', method: 'POST', durationMs: 2200, status: 200, failed: false,
    }]);
    assert.deepEqual(report.requestStats['/api/settings/get'], {
        count: 1,
        slowCount: 0,
        totalDurationMs: 320,
        maxDurationMs: 320,
        responseBytes: 6660000,
        sizedResponses: 1,
        encodings: { br: 1 },
    });
    assert.equal(JSON.stringify(report).includes('secret'), false);
});
