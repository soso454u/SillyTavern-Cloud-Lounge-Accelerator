const CAPTURE_MS = 30000;
const SAMPLE_LIMIT = 32;
const SCROLL_IDLE_MS = 180;
const WORLD_LOAD_PATH = '/api/worldinfo/get';
const ACCELERATOR_PATH = new URL('../', import.meta.url).pathname;
const KNOWN_SCRIPTS = new Map([
    ['/script.js', 'native-core'],
    ['/scripts/world-info.js', 'native-world-info'],
    ['/scripts/utils.js', 'native-utilities'],
    ['/scripts/RossAscends-mods.js', 'native-interface'],
    ['/scripts/openai.js', 'native-presets'],
    ['/scripts/extensions/regex/engine.js', 'native-regex'],
    ['/lib/select2.min.js', 'select2'],
    ['/lib/pagination.js', 'pagination'],
]);

function scriptCategory(source, origin) {
    try {
        // Parse only for classification. Never export URLs or arbitrary names.
        const url = new URL(source);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'inline-or-embedded';
        if (url.origin !== origin) return 'external';
        if (ACCELERATOR_PATH !== '/' && url.pathname.startsWith(ACCELERATOR_PATH)) return 'accelerator';
        if (/\/third-party\//.test(url.pathname)) return 'third-party-extension';
        return KNOWN_SCRIPTS.get(url.pathname) || 'same-origin-other';
    } catch {
        return 'inline-or-embedded';
    }
}

function summarizeScripts(scripts, origin) {
    const longest = [];
    const limit = Math.min(scripts?.length || 0, 64);
    for (let index = 0; index < limit; index++) {
        const script = scripts[index];
        if (longest.length === 4 && script.duration <= longest[3].duration) continue;
        longest.push(script);
        longest.sort((a, b) => b.duration - a.duration);
        if (longest.length > 4) longest.pop();
    }
    return longest.map(script => ({
        category: scriptCategory(script.sourceURL, origin),
        durationMs: ms(script.duration),
        forcedStyleAndLayoutMs: ms(script.forcedStyleAndLayoutDuration),
    }));
}

const ms = value => Math.round(value);
function elapsedFrom(timestamp, start) {
    return Number.isFinite(timestamp) && timestamp > 0 ? ms(timestamp - start) : null;
}

function worldClick(target) {
    if (target?.closest?.('#WI-SP-button .drawer-toggle')) {
        return target.closest('.drawer')?.querySelector('#WorldInfo')?.classList.contains('openDrawer') ? null : 'world-panel-open';
    }
    const toggle = target?.closest?.('#world_popup_entries_list .world_entry .inline-drawer-toggle');
    if (toggle && !target.classList.contains('text_pole')) {
        return toggle.querySelector('.inline-drawer-icon')?.classList.contains('up') ? 'world-entry-close' : 'world-entry-open';
    }
    if (target?.closest?.('#OpenAllWIEntries')) return 'world-open-all';
    if (target?.closest?.('#CloseAllWIEntries')) return 'world-close-all';
    return null;
}

export class PerformanceDiagnostics {
    constructor(windowRef = globalThis.window) {
        this.window = windowRef;
        this.document = windowRef?.document;
        this.performance = windowRef?.performance;
        this.session = null;
        this.report = null;
    }

    get active() { return this.session !== null; }

    start(onFinish) {
        if (this.active || !this.performance?.now) return false;
        const current = this.session = {
            start: this.performance.now(), onFinish,
            listeners: [], observers: [], frames: new Set(), interactions: [],
            longtask: [], 'long-animation-frame': [], dropped: {}, supported: [],
            world: null, scroll: null, scrollTimer: null, timer: null,
        };
        const listen = (element, name, callback) => {
            if (!element) return;
            element.addEventListener(name, callback, { capture: true, passive: true });
            current.listeners.push(() => element.removeEventListener(name, callback, true));
        };
        const worldRoot = this.document.getElementById('WI-SP-button');
        const worldPanel = this.document.getElementById('WorldInfo');
        const worldList = this.document.getElementById('world_popup_entries_list');
        const worldSelect = this.document.getElementById('world_editor_select');
        const chat = this.document.getElementById('chat');

        listen(worldRoot, 'click', event => {
            const target = event.target;
            const operation = worldClick(target);
            const start = this.eventTime(event);
            if (operation) this.afterFrame(current, operation, start);
            else if (target?.closest?.('#world_info_pagination :is(.J-paginationjs-next, .J-paginationjs-previous)')) {
                this.worldIntent(current, 'world-page', start);
            }
        });
        listen(worldPanel, 'input', event => {
            if (event.target?.id === 'world_info_search') this.worldIntent(current, 'world-search', this.eventTime(event));
        });
        listen(worldPanel, 'change', event => {
            const target = event.target;
            if (target?.matches?.('#world_info_pagination .J-paginationjs-size-select')) {
                this.worldIntent(current, 'world-page-size', this.eventTime(event));
            } else if (target?.id === 'world_info_sort_order') {
                this.worldIntent(current, 'world-sort', this.eventTime(event));
            }
        });

        // Select2 dispatches jQuery change events as well as using native controls.
        const $ = this.window.jQuery;
        const onBookChange = () => this.worldIntent(current, 'world-switch-book', this.performance.now());
        if (worldSelect && $?.fn?.on) {
            $(worldSelect).on('change.claPerformanceDiagnostics', onBookChange);
            current.listeners.push(() => $(worldSelect).off('change.claPerformanceDiagnostics', onBookChange));
        } else listen(worldSelect, 'change', onBookChange);
        if (worldList && this.window.MutationObserver) {
            const observer = new this.window.MutationObserver(records => {
                if (!current.world || !records.some(record => record.addedNodes.length)) return;
                const { operation, start } = current.world;
                current.world = null;
                this.afterFrame(current, operation, start, this.performance.now());
            });
            observer.observe(worldList, { childList: true });
            current.listeners.push(() => observer.disconnect());
        }
        listen(chat, 'scroll', event => {
            if (event.target !== chat) return;
            const now = this.performance.now();
            if (current.scroll) {
                current.scroll.maxGap = Math.max(current.scroll.maxGap, now - current.scroll.last);
                current.scroll.last = now;
                current.scroll.events++;
                return;
            }
            const start = this.eventTime(event);
            current.scroll = { start, last: now, events: 1, maxGap: 0, firstDispatchMs: ms(now - start) };
            this.waitForScrollIdle(current);
        });
        listen(chat, 'scrollend', event => {
            if (event.target === chat) this.finishScroll(current);
        });
        for (const type of ['longtask', 'long-animation-frame']) this.observe(current, type);
        current.timer = this.window.setTimeout(() => this.stop(), CAPTURE_MS);
        return true;
    }

    eventTime(event) {
        const now = this.performance.now();
        return event.timeStamp > 0 && event.timeStamp <= now ? event.timeStamp : now;
    }

    worldIntent(current, operation, start) {
        if (current.world) current.dropped.worldIntents = (current.dropped.worldIntents || 0) + 1;
        current.world = { operation, start };
    }

    afterFrame(current, operation, start, renderedAt) {
        if (current.frames.size >= 8) {
            current.dropped.interactions = (current.dropped.interactions || 0) + 1;
            return;
        }
        const request = callback => {
            const handle = this.window.requestAnimationFrame(() => {
                current.frames.delete(handle);
                if (this.session === current) callback();
            });
            current.frames.add(handle);
        };
        request(() => request(() => {
            this.record(current, 'interactions', {
                operation, atMs: ms(start - current.start),
                nextFrameMs: ms(this.performance.now() - start),
                domUpdateMs: renderedAt === undefined ? undefined : ms(renderedAt - start),
            });
        }));
    }

    waitForScrollIdle(current) {
        const remaining = SCROLL_IDLE_MS - (this.performance.now() - current.scroll.last);
        current.scrollTimer = this.window.setTimeout(() => {
            if (this.performance.now() - current.scroll.last < SCROLL_IDLE_MS) this.waitForScrollIdle(current);
            else this.finishScroll(current);
        }, Math.max(1, remaining));
    }

    finishScroll(current, interrupted = false) {
        if (!current.scroll) return;
        this.window.clearTimeout(current.scrollTimer);
        current.scrollTimer = null;
        const { start, last, events, maxGap, firstDispatchMs } = current.scroll;
        current.scroll = null;
        this.record(current, 'interactions', {
            operation: 'chat-scroll', atMs: ms(start - current.start),
            spanMs: ms(last - start), events, maxEventGapMs: events > 1 ? ms(maxGap) : null,
            firstDispatchMs, interrupted,
        });
    }

    observe(current, type) {
        const Observer = this.window.PerformanceObserver;
        if (!Observer?.supportedEntryTypes?.includes(type)) return;
        try {
            const observer = new Observer(list => this.readEntries(current, type, list.getEntries()));
            observer.observe({ type });
            current.observers.push({ observer, type });
            current.supported.push(type);
        } catch { /* Availability depends on the browser and its policy. */ }
    }

    record(current, key, entry) {
        const items = current[key];
        if (items.length >= SAMPLE_LIMIT) {
            current.dropped[key] = (current.dropped[key] || 0) + 1;
            items.shift();
        }
        items.push(entry);
    }

    readEntries(current, type, entries) {
        const origin = this.window.location.origin;
        for (const entry of entries.slice(-SAMPLE_LIMIT)) {
            if (entry.startTime < current.start) continue;
            const summary = { atMs: ms(entry.startTime - current.start), durationMs: ms(entry.duration) };
            if (type === 'long-animation-frame') {
                Object.assign(summary, {
                    blockingMs: ms(entry.blockingDuration),
                    renderStartMs: elapsedFrom(entry.renderStart, entry.startTime),
                    styleAndLayoutStartMs: elapsedFrom(entry.styleAndLayoutStart, entry.startTime),
                    scripts: summarizeScripts(entry.scripts, origin),
                    scriptsInspected: Math.min(entry.scripts?.length || 0, 64),
                    scriptsCapped: (entry.scripts?.length || 0) > 64,
                });
            }
            this.record(current, type, summary);
        }
        if (entries.length > SAMPLE_LIMIT) {
            current.dropped[type] = (current.dropped[type] || 0) + entries.length - SAMPLE_LIMIT;
        }
    }

    readWorldRequests(start) {
        const origin = this.window.location.origin;
        const entries = this.performance.getEntriesByName?.(origin + WORLD_LOAD_PATH, 'resource') || [];
        return entries.filter(entry => entry.startTime >= start).slice(-SAMPLE_LIMIT).map(entry => ({
            atMs: ms(entry.startTime - start),
            totalMs: ms(entry.duration),
            fetchToFirstByteMs: entry.responseStart > 0 ? ms(entry.responseStart - entry.fetchStart) : null,
            receiveMs: entry.responseStart > 0 ? ms(entry.responseEnd - entry.responseStart) : null,
        }));
    }

    stop() {
        const current = this.session;
        if (!current) return this.report;
        this.session = null;
        this.window.clearTimeout(current.timer);
        this.finishScroll(current, true);
        for (const dispose of current.listeners) dispose();
        for (const handle of current.frames) this.window.cancelAnimationFrame(handle);
        for (const { observer, type } of current.observers) {
            this.readEntries(current, type, observer.takeRecords());
            observer.disconnect();
        }
        this.report = {
            sampledMs: ms(this.performance.now() - current.start),
            supported: current.supported,
            interactions: current.interactions,
            pendingWorldOperation: current.world?.operation || null,
            pendingFrameSamples: current.frames.size,
            longTasks: current.longtask,
            longAnimationFrames: current['long-animation-frame'],
            worldBookResourceTimings: this.readWorldRequests(current.start),
            dropped: current.dropped,
        };
        current.onFinish?.();
        return this.report;
    }
}
