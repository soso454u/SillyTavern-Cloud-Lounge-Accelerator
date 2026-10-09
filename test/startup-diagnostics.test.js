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
        timedResponses: 0,
        encodedBodyBytes: 0,
        decodedBodyBytes: 0,
        networkWaitMs: 0,
        downloadMs: 0,
        resourceDurationMs: 0,
        encodings: { br: 1 },
    });
    assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('keeps the slowest requests and exposes timing coverage without reading bodies', () => {
    const diagnostics = new StartupDiagnostics({
        eventSource: emitter(),
        eventTypes: {},
        documentRef: { body: {}, querySelector: () => null },
        locationRef: { origin: 'https://example.test' },
        storage: memoryStorage(),
        performanceRef: {
            now: () => 1000,
            getEntriesByType: () => [{
                type: 'reload',
                startTime: 0,
                fetchStart: 1,
                requestStart: 2,
                responseStart: 30,
                responseEnd: 80,
                domContentLoadedEventEnd: 120,
                loadEventEnd: 180,
                transferSize: 200,
                encodedBodySize: 100,
                decodedBodySize: 300,
            }],
            getEntriesByName: () => [{
                startTime: 10,
                requestStart: 20,
                responseStart: 70,
                responseEnd: 170,
                transferSize: 600,
                encodedBodySize: 500,
                decodedBodySize: 900,
            }],
        },
        PerformanceObserverRef: null,
        MutationObserverRef: null,
        setTimer: () => 1,
        clearTimer() {},
        now: () => 1000,
    });
    diagnostics.start();
    diagnostics.noteRequest({
        input: '/api/settings/get',
        durationMs: 1800,
        status: 200,
        resourceTiming: diagnostics.getResourceTiming('/api/settings/get'),
    });
    diagnostics.noteRequest({ input: '/api/settings/get', durationMs: 4200, status: 200 });
    const report = diagnostics.getReport();
    assert.equal(report.navigationTiming.decodedBodySize, 300);
    assert.equal(report.coverage.resourceTiming, 'available');
    assert.equal(report.coverage.jsonParse, 'not-observed');
    assert.equal(report.slowRequests[0].durationMs, 4200);
    assert.equal(report.requestStats['/api/settings/get'].decodedBodyBytes, 900);
    assert.equal(report.longTaskSupport, 'unsupported');
});

test('counts completed settings transfers before and after activation without confusing headers with body timing', () => {
    const entries = [{ startTime: 10, responseEnd: 20000, decodedBodySize: 57000000 }];
    const diagnostics = new StartupDiagnostics({
        eventTypes: {}, storage: memoryStorage(),
        documentRef: { querySelector: () => null },
        locationRef: { origin: 'https://example.test' },
        performanceRef: { now: () => 24000, getEntriesByName: () => entries },
        PerformanceObserverRef: null, MutationObserverRef: null,
        setTimer: () => 1, clearTimer() {},
    });
    diagnostics.start();
    diagnostics.noteRequest({ input: '/api/settings/get', durationMs: 3000, status: 200 });
    entries.push({ startTime: 25000, responseEnd: 50000, decodedBodySize: 57000000 });
    entries.push({ startTime: 51000, responseEnd: 0 });
    diagnostics.finish();
    const report = diagnostics.getReport();
    assert.equal(report.requestStats['/api/settings/get'].count, 1);
    assert.equal(report.requestStats['/api/settings/get'].timedResponses, 0);
    assert.equal(report.coverage.settingsResourceCount, 2);
    assert.equal(report.coverage.settingsResourcesBeforePlugin, 1);
    assert.equal(report.settingsResources[1].responseEnd, 50000);
    assert.equal(report.slowRequests[0].timing, undefined);
    assert.match(diagnostics.getSummary(), /设置请求 2次/);
});

test('does not claim Long Task support when WebKit lists only other entry types', () => {
    class Observer {
        static supportedEntryTypes = ['resource', 'navigation'];
        constructor() { assert.fail('unsupported observer must not be constructed'); }
    }
    const diagnostics = new StartupDiagnostics({
        eventTypes: {}, documentRef: { querySelector: () => null },
        PerformanceObserverRef: Observer, MutationObserverRef: null,
        setTimer: () => 1, clearTimer() {},
    });
    diagnostics.start();
    assert.equal(diagnostics.getReport().longTaskSupport, 'unsupported');
});
