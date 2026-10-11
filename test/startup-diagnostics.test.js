import test from 'node:test';
import assert from 'node:assert/strict';

import { safeStartupEndpoint, StartupDiagnostics } from '../modules/startup-diagnostics.js';

function emitter(asyncDispatch = false) {
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
            if (asyncDispatch) return (async () => {
                for (const handler of listeners.get(name) || []) await handler();
            })();
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
    const originalEmit = eventSource.emit;
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
    assert.equal(eventSource.emit, originalEmit, 'restore the native emitter when startup completes');

    const report = diagnostics.getReport();
    assert.deepEqual(Object.fromEntries(['PLUGIN_ACTIVATED', 'SETTINGS_LOADED', 'APP_INITIALIZED', 'APP_READY']
        .map(name => [name, report.markers[name]])), {
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
    assert.equal(report.coverage.settingsRequestCountLowerBound, 2);
    assert.match(diagnostics.getSummary(), /设置请求至少 2次/);
});

test('counts an early settings read plus a later fetch even when resource timing retains only the early read', () => {
    const diagnostics = new StartupDiagnostics({
        eventTypes: {}, storage: memoryStorage(),
        documentRef: { querySelector: () => null },
        locationRef: { origin: 'https://example.test' },
        performanceRef: {
            now: () => 38000,
            getEntriesByName: () => [{ startTime: 18000, responseEnd: 32000 }],
        },
        PerformanceObserverRef: null, MutationObserverRef: null,
        setTimer: () => 1, clearTimer() {},
    });
    diagnostics.start();
    diagnostics.noteRequest({ input: '/api/settings/get', durationMs: 3000, status: 200 });
    diagnostics.finish();
    const report = diagnostics.getReport();
    assert.equal(report.coverage.settingsResourceCount, 1);
    assert.equal(report.requestStats['/api/settings/get'].count, 1);
    assert.equal(report.coverage.settingsRequestCountLowerBound, 2);
    assert.match(diagnostics.getSummary(), /设置请求至少 2次/);
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

test('separates remaining activation, awaited settings subscribers, and native welcome work', async () => {
    const eventSource = emitter(true);
    const originalEmit = eventSource.emit;
    let elapsed = 40000;
    let releaseSettings;
    const diagnostics = new StartupDiagnostics({
        eventSource,
        eventTypes: { EXTENSION_SETTINGS_LOADED: 'extensions', SETTINGS_LOADED: 'settings', APP_READY: 'ready' },
        documentRef: { querySelector: () => null }, storage: memoryStorage(),
        performanceRef: { now: () => elapsed },
        PerformanceObserverRef: null, MutationObserverRef: null,
        setTimer: () => 1, clearTimer() {},
    });
    diagnostics.start();
    // This late subscriber would be missed by an ordinary end-marker listener.
    eventSource.on('extensions', () => new Promise(resolve => { releaseSettings = resolve; }));
    elapsed = 65000;
    const pending = eventSource.emit('extensions', { secret: 'must not be recorded' });
    assert.equal(diagnostics.getReport().markers.EXTENSION_SETTINGS_LOADED_DISPATCH_START, 65000);
    assert.equal(diagnostics.getReport().markers.EXTENSION_SETTINGS_LOADED_DISPATCH_END, undefined);
    elapsed = 125000;
    releaseSettings();
    await pending;
    elapsed = 125850;
    await eventSource.emit('settings');
    elapsed = 128100;
    // Includes awaited ready subscribers even when registered after diagnostics.
    const wrappedEmit = eventSource.emit;
    eventSource.emit = function (name, ...args) { return wrappedEmit.call(this, name, ...args); };
    const laterWrapper = eventSource.emit;
    eventSource.on('ready', async () => { elapsed = 136540; });
    await eventSource.emit('ready');
    const report = diagnostics.getReport();
    assert.equal(report.durations.pluginToExtensionSettingsMs, 25000);
    assert.equal(report.durations.extensionSettingsListenersMs, 60000);
    assert.equal(report.durations.extensionSettingsToSettingsMs, 850);
    assert.equal(report.durations.appReadyListenersMs, 8440);
    assert.equal(diagnostics.completed, true);
    assert.equal(eventSource.emit, laterWrapper, 'must not replace a later wrapper');
    assert.equal(JSON.stringify(report).includes('must not be recorded'), false);
    diagnostics.stop();
    assert.equal(eventSource.emit, laterWrapper);
    assert.notEqual(laterWrapper, originalEmit);
});

test('phase observation preserves return identity, arguments, receiver and rejection; restores on stop', async () => {
    const eventSource = emitter();
    const error = new Error('failed');
    const rejection = Promise.reject(error);
    const payload = {};
    eventSource.emit = function (name, arg) {
        assert.equal(this, eventSource);
        assert.equal(name, 'extensions');
        assert.equal(arg, payload);
        return rejection;
    };
    const originalEmit = eventSource.emit;
    const diagnostics = new StartupDiagnostics({
        eventSource, eventTypes: { EXTENSION_SETTINGS_LOADED: 'extensions' },
        documentRef: { querySelector: () => null }, storage: memoryStorage(),
        PerformanceObserverRef: null, MutationObserverRef: null,
        setTimer: () => 1, clearTimer() {},
    });
    diagnostics.start();
    const result = eventSource.emit('extensions', payload);
    assert.equal(result, rejection);
    await assert.rejects(result, value => value === error);
    assert.equal(typeof diagnostics.getReport().markers.EXTENSION_SETTINGS_LOADED_DISPATCH_FAILED, 'number');
    assert.equal(diagnostics.getReport().markers.EXTENSION_SETTINGS_LOADED_DISPATCH_END, undefined);
    diagnostics.stop();
    assert.equal(eventSource.emit, originalEmit);
});
