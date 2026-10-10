const STORAGE_KEY = 'cla-startup-diagnostic-v1';
const SLOW_REQUEST_MS = 1500;
const SLOW_STARTUP_MS = 30000;
const REQUEST_LIMIT = 12;
const LONG_TASK_LIMIT = 12;
const KNOWN_ENDPOINTS = new Set([
    '/csrf-token',
    '/version',
    '/api/settings/get',
    '/api/extensions/discover',
    '/api/avatars/get',
    '/api/characters/all',
    '/api/backgrounds/all',
    '/api/chats/recent',
    '/api/chats/get',
    '/api/chats/group/get',
    '/api/chats/save',
    '/api/chats/group/save',
    '/api/quick-replies/save',
]);

function rounded(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function timingNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function readNavigationTiming(performanceRef) {
    try {
        const entry = performanceRef?.getEntriesByType?.('navigation')?.[0];
        if (!entry) return null;
        return {
            type: String(entry.type || '').slice(0, 24) || undefined,
            startTime: timingNumber(entry.startTime),
            fetchStart: timingNumber(entry.fetchStart),
            requestStart: timingNumber(entry.requestStart),
            responseStart: timingNumber(entry.responseStart),
            responseEnd: timingNumber(entry.responseEnd),
            domContentLoadedEventEnd: timingNumber(entry.domContentLoadedEventEnd),
            loadEventEnd: timingNumber(entry.loadEventEnd),
            transferSize: timingNumber(entry.transferSize),
            encodedBodySize: timingNumber(entry.encodedBodySize),
            decodedBodySize: timingNumber(entry.decodedBodySize),
        };
    } catch {
        return null;
    }
}

function readResourceTimings(performanceRef, input, locationRef) {
    try {
        const rawUrl = typeof input === 'string' ? input : input?.url;
        const url = new URL(rawUrl, locationRef?.origin || 'https://localhost');
        const entries = performanceRef?.getEntriesByName?.(url.href) || [];
        return [...entries].filter(entry => entry.entryType !== 'navigation' && entry.responseEnd > 0).map(entry => ({
            startTime: timingNumber(entry.startTime),
            fetchStart: timingNumber(entry.fetchStart),
            requestStart: timingNumber(entry.requestStart),
            responseStart: timingNumber(entry.responseStart),
            responseEnd: timingNumber(entry.responseEnd),
            transferSize: timingNumber(entry.transferSize),
            encodedBodySize: timingNumber(entry.encodedBodySize),
            decodedBodySize: timingNumber(entry.decodedBodySize),
        }));
    } catch {
        return [];
    }
}

function timingDelta(timing, from, to) {
    const start = Number(timing?.[from]);
    const end = Number(timing?.[to]);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start
        ? rounded(end - start)
        : null;
}

function markerDelta(markers, from, to) {
    const start = Number(markers?.[from]);
    const end = Number(markers?.[to]);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start
        ? rounded(end - start)
        : null;
}

function settingsRequestLowerBound(report) {
    // Early completed resources and requests seen by our fetch wrapper belong
    // to disjoint periods. Later resources may overlap wrapper observations.
    const early = rounded(report?.coverage?.settingsResourcesBeforePlugin);
    const observed = rounded(report?.requestStats?.['/api/settings/get']?.count);
    return Math.max(early + observed, rounded(report?.coverage?.settingsResourceCount));
}

export function safeStartupEndpoint(input, locationRef = globalThis.location) {
    try {
        const pathname = new URL(
            typeof input === 'string' ? input : input?.url,
            locationRef?.origin || 'https://localhost',
        ).pathname;
        if (KNOWN_ENDPOINTS.has(pathname)) return pathname;
        const root = pathname.split('/').filter(Boolean)[0];
        return root ? `/${root}/…` : '/';
    } catch {
        return 'unknown';
    }
}

function readStored(storage) {
    try {
        const value = JSON.parse(storage?.getItem?.(STORAGE_KEY) || 'null');
        return value && typeof value === 'object' ? value : null;
    } catch {
        return null;
    }
}

export class StartupDiagnostics {
    constructor({
        eventSource,
        eventTypes,
        documentRef = globalThis.document,
        locationRef = globalThis.location,
        storage = globalThis.localStorage,
        performanceRef = globalThis.performance,
        PerformanceObserverRef = globalThis.PerformanceObserver,
        MutationObserverRef = globalThis.MutationObserver,
        getComputedStyleRef = globalThis.getComputedStyle,
        now = () => Date.now(),
        setTimer = globalThis.setTimeout,
        clearTimer = globalThis.clearTimeout,
    } = {}) {
        this.eventSource = eventSource;
        this.eventTypes = eventTypes;
        this.document = documentRef;
        this.location = locationRef;
        this.storage = storage;
        this.performance = performanceRef;
        this.PerformanceObserver = PerformanceObserverRef;
        this.MutationObserver = MutationObserverRef;
        this.getComputedStyle = getComputedStyleRef;
        this.now = now;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.handlers = [];
        this.overlayObserver = null;
        this.longTaskObserver = null;
        this.persistTimer = null;
        this.overlay = null;
        this.completed = false;
        this.started = false;
        this.report = null;
    }

    elapsed() {
        return rounded(this.performance?.now?.());
    }

    start() {
        if (this.started || this.completed) return;
        this.started = true;
        this.report = {
            schema: 1,
            recordedAt: new Date(this.now()).toISOString(),
            markers: {},
            markerOrder: [],
            navigationTiming: readNavigationTiming(this.performance),
            coverage: {
                pluginActivatedMs: this.elapsed(),
                earlyUnobservedMs: this.elapsed(),
                resourceTiming: typeof this.performance?.getEntriesByName === 'function' ? 'available' : 'unsupported',
                jsonParse: 'not-observed',
                initializationBeforePlugin: 'not-observed',
                requestDuration: 'response-headers-only',
            },
            slowRequests: [],
            requestStats: {},
            longTasks: [],
            longTaskCount: 0,
            longestLongTaskMs: 0,
            longTaskSupport: 'unsupported',
            slow: false,
        };
        this.mark('PLUGIN_ACTIVATED');
        this.bind(this.eventTypes?.SETTINGS_LOADED, () => this.mark('SETTINGS_LOADED'));
        this.bind(this.eventTypes?.APP_INITIALIZED, () => this.mark('APP_INITIALIZED'));
        this.bind(this.eventTypes?.APP_READY, () => this.finish());
        this.watchStartupOverlay();
        this.watchLongTasks();
    }

    bind(name, handler) {
        if (!name || !this.eventSource?.on) return;
        this.eventSource.on(name, handler);
        this.handlers.push([name, handler]);
    }

    mark(name) {
        if (!this.report || this.report.markers[name] !== undefined) return;
        this.report.markers[name] = this.elapsed();
        this.report.markerOrder.push(name);
        this.schedulePersist();
    }

    watchStartupOverlay() {
        this.overlay = this.document?.querySelector?.('.splash-screen')?.closest?.('dialog')
            || this.document?.querySelector?.('.splash-screen')
            || null;
        if (!this.overlay || !this.document?.body || typeof this.MutationObserver !== 'function') return;
        this.overlayObserver = new this.MutationObserver(() => this.checkOverlay());
        this.overlayObserver.observe(this.document.body, { childList: true });
    }

    checkOverlay() {
        if (!this.overlay || this.report?.markers?.STARTUP_OVERLAY_HIDDEN !== undefined) return;
        let hidden = !this.overlay.isConnected;
        if (!hidden) {
            try {
                const style = this.getComputedStyle?.(this.overlay);
                hidden = style?.display === 'none' || style?.visibility === 'hidden' || Number(style?.opacity) <= 0.01;
            } catch {
                hidden = false;
            }
        }
        if (!hidden) return;
        this.mark('STARTUP_OVERLAY_HIDDEN');
        this.overlayObserver?.disconnect?.();
        this.overlayObserver = null;
    }

    watchLongTasks() {
        if (typeof this.PerformanceObserver !== 'function') return;
        const supported = this.PerformanceObserver.supportedEntryTypes;
        if (Array.isArray(supported) && !supported.includes('longtask')) return;
        this.report.longTaskSupport = 'observing';
        try {
            this.longTaskObserver = new this.PerformanceObserver(list => {
                for (const entry of list.getEntries?.() || []) {
                    const durationMs = rounded(entry.duration);
                    this.report.longTaskCount += 1;
                    this.report.longestLongTaskMs = Math.max(this.report.longestLongTaskMs, durationMs);
                    this.report.longTasks.push({
                        startMs: rounded(entry.startTime),
                        durationMs,
                    });
                    if (this.report.longTasks.length > LONG_TASK_LIMIT) this.report.longTasks.shift();
                }
                this.schedulePersist();
            });
            try {
                this.longTaskObserver.observe({ type: 'longtask', buffered: true });
            } catch {
                this.longTaskObserver.observe({ entryTypes: ['longtask'] });
            }
            this.report.longTaskSupport = 'observed';
        } catch {
            this.longTaskObserver = null;
            this.report.longTaskSupport = 'failed';
        }
    }

    getResourceTiming(input) {
        return readResourceTimings(this.performance, input, this.location).at(-1) || null;
    }

    noteRequest({
        input,
        method = 'GET',
        durationMs = 0,
        status = 0,
        failed = false,
        responseBytes = 0,
        contentEncoding = '',
        initiator = '',
        resourceTiming = null,
    } = {}) {
        if (!this.started || this.completed || !this.report) return;
        const endpoint = safeStartupEndpoint(input, this.location);
        const duration = rounded(durationMs);
        const bytes = rounded(responseBytes);
        const stats = this.report.requestStats[endpoint] || {
            count: 0,
            slowCount: 0,
            totalDurationMs: 0,
            maxDurationMs: 0,
            responseBytes: 0,
            sizedResponses: 0,
            timedResponses: 0,
            encodedBodyBytes: 0,
            decodedBodyBytes: 0,
            networkWaitMs: 0,
            downloadMs: 0,
            resourceDurationMs: 0,
            encodings: {},
        };
        stats.count += 1;
        stats.totalDurationMs += duration;
        stats.maxDurationMs = Math.max(stats.maxDurationMs, duration);
        if (duration >= SLOW_REQUEST_MS) stats.slowCount += 1;
        if (bytes > 0) {
            stats.responseBytes += bytes;
            stats.sizedResponses += 1;
        }
        if (resourceTiming) {
            stats.timedResponses += 1;
            stats.encodedBodyBytes += timingNumber(resourceTiming.encodedBodySize) || 0;
            stats.decodedBodyBytes += timingNumber(resourceTiming.decodedBodySize) || 0;
            stats.networkWaitMs += timingDelta(resourceTiming, 'requestStart', 'responseStart') || 0;
            stats.downloadMs += timingDelta(resourceTiming, 'responseStart', 'responseEnd') || 0;
            stats.resourceDurationMs += timingDelta(resourceTiming, 'startTime', 'responseEnd') || 0;
        }
        if (contentEncoding) {
            const encoding = String(contentEncoding).toLowerCase().slice(0, 24);
            stats.encodings[encoding] = (stats.encodings[encoding] || 0) + 1;
        }
        this.report.requestStats[endpoint] = stats;
        if (duration >= SLOW_REQUEST_MS) {
            const request = {
                endpoint,
                method: String(method || 'GET').toUpperCase().slice(0, 8),
                durationMs: duration,
                status: rounded(status),
                failed: Boolean(failed),
            };
            if (bytes > 0) request.responseBytes = bytes;
            if (contentEncoding) request.contentEncoding = String(contentEncoding).toLowerCase().slice(0, 24);
            if (initiator) request.initiator = String(initiator).slice(0, 240);
            if (resourceTiming) {
                request.timing = {
                    networkWaitMs: timingDelta(resourceTiming, 'requestStart', 'responseStart'),
                    downloadMs: timingDelta(resourceTiming, 'responseStart', 'responseEnd'),
                    resourceDurationMs: timingDelta(resourceTiming, 'startTime', 'responseEnd'),
                    transferSize: timingNumber(resourceTiming.transferSize),
                    encodedBodySize: timingNumber(resourceTiming.encodedBodySize),
                    decodedBodySize: timingNumber(resourceTiming.decodedBodySize),
                };
            }
            this.report.slowRequests.push(request);
            this.report.slowRequests.sort((left, right) => right.durationMs - left.durationMs);
            if (this.report.slowRequests.length > REQUEST_LIMIT) this.report.slowRequests.splice(REQUEST_LIMIT);
        }
        this.schedulePersist();
    }

    schedulePersist() {
        if (this.persistTimer !== null) return;
        this.persistTimer = this.setTimer(() => {
            this.persistTimer = null;
            this.persist();
        }, 300);
    }

    persist() {
        if (!this.report) return;
        try {
            this.storage?.setItem?.(STORAGE_KEY, JSON.stringify(this.report));
        } catch {
            // Startup instrumentation must never delay or abort initialization.
        }
    }

    finish() {
        if (!this.report || this.completed) return;
        this.mark('APP_READY');
        this.checkOverlay();
        const readyMs = this.report.markers.APP_READY || 0;
        // fetch() resolves at headers. Only now inspect completed transfers;
        // the latest entry at headers may belong to an earlier settings read.
        const settingsResources = readResourceTimings(this.performance, '/api/settings/get', this.location);
        this.report.settingsResources = settingsResources.slice(-4);
        this.report.durations = {
            pluginToSettingsMs: markerDelta(this.report.markers, 'PLUGIN_ACTIVATED', 'SETTINGS_LOADED'),
            settingsToInitializedMs: markerDelta(this.report.markers, 'SETTINGS_LOADED', 'APP_INITIALIZED'),
            initializedToReadyMs: markerDelta(this.report.markers, 'APP_INITIALIZED', 'APP_READY'),
            pluginToReadyMs: markerDelta(this.report.markers, 'PLUGIN_ACTIVATED', 'APP_READY'),
        };
        const readyIndex = this.report.markerOrder.indexOf('APP_READY');
        const overlayIndex = this.report.markerOrder.indexOf('STARTUP_OVERLAY_HIDDEN');
        this.report.coverage = {
            ...this.report.coverage,
            overlayHiddenBeforeReady: overlayIndex >= 0 && readyIndex >= 0 && overlayIndex < readyIndex,
            observedThroughMs: readyMs,
            settingsResourceCount: settingsResources.length,
            settingsResourcesBeforePlugin: settingsResources.filter(entry => (
                entry.startTime < this.report.markers.PLUGIN_ACTIVATED
            )).length,
        };
        this.report.coverage.settingsRequestCountLowerBound = settingsRequestLowerBound(this.report);
        this.report.slow = readyMs >= SLOW_STARTUP_MS;
        this.report.recordedAt = new Date(this.now()).toISOString();
        this.completed = true;
        this.persist();
        this.longTaskObserver?.disconnect?.();
        this.longTaskObserver = null;
        if (this.report.markers.STARTUP_OVERLAY_HIDDEN !== undefined) {
            this.overlayObserver?.disconnect?.();
            this.overlayObserver = null;
        }
    }

    getReport() {
        return this.report || readStored(this.storage);
    }

    getSummary() {
        const report = this.getReport();
        if (!report) return '等待启动数据';
        const readyMs = report.markers?.APP_READY;
        const ready = Number.isFinite(readyMs) ? `APP_READY ${(readyMs / 1000).toFixed(1)}s` : '采集中';
        const requests = report.slowRequests?.length || 0;
        const settingsCount = settingsRequestLowerBound(report);
        const longest = report.longestLongTaskMs || 0;
        const settings = settingsCount ? ` · 设置请求至少 ${settingsCount}次` : '';
        const longTasks = report.longTaskSupport === 'observed'
            ? `最长主线程任务 ${longest}ms`
            : `Long Task ${report.longTaskSupport || '不可用'}`;
        return `${ready} · 慢请求 ${requests}${settings} · ${longTasks}`;
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        for (const [name, handler] of this.handlers) this.eventSource?.removeListener?.(name, handler);
        this.handlers = [];
        this.overlayObserver?.disconnect?.();
        this.overlayObserver = null;
        this.longTaskObserver?.disconnect?.();
        this.longTaskObserver = null;
        if (this.persistTimer !== null) this.clearTimer(this.persistTimer);
        this.persistTimer = null;
        this.persist();
    }
}
