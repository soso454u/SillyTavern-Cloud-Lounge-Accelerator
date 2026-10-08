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
]);

function rounded(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
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
            slowRequests: [],
            longTasks: [],
            longTaskCount: 0,
            longestLongTaskMs: 0,
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
        } catch {
            this.longTaskObserver = null;
        }
    }

    noteRequest({ input, method = 'GET', durationMs = 0, status = 0, failed = false } = {}) {
        if (!this.started || this.completed || !this.report || durationMs < SLOW_REQUEST_MS) return;
        this.report.slowRequests.push({
            endpoint: safeStartupEndpoint(input, this.location),
            method: String(method || 'GET').toUpperCase().slice(0, 8),
            durationMs: rounded(durationMs),
            status: rounded(status),
            failed: Boolean(failed),
        });
        if (this.report.slowRequests.length > REQUEST_LIMIT) this.report.slowRequests.shift();
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
        const longest = report.longestLongTaskMs || 0;
        return `${ready} · 慢请求 ${requests} · 最长主线程任务 ${longest}ms`;
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
