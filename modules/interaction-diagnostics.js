const STORAGE_KEY = 'cla-interaction-diagnostic-v1';
const EVENT_LIMIT = 48;
const PERSISTED_EVENT_LIMIT = 16;
const CLICK_WAIT_MS = 850;
const ERROR_WINDOW_MS = 2000;
const CLIPBOARD_CORRELATION_MS = 15000;
const BUSY_THRESHOLD_MS = 250;
const MAX_REPORT_BYTES = 12000;
const CONTROL_SELECTOR = [
    'button',
    'a[href]',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '.menu_button',
    '.interactable',
].join(',');
const BLOCKER_SELECTOR = [
    '#loader',
    '#preloader',
    '#shadow_popup',
    '#shadow_character_popup',
    '#shadow_select_chat_popup',
].join(',');

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function safeToken(value, limit = 48) {
    const token = String(value || '');
    return /^[\w-]+$/u.test(token) ? token.slice(0, limit) : '';
}

function safeFileName(value, limit = 64) {
    const token = String(value || '');
    return /^[\w.-]+$/u.test(token) ? token.slice(0, limit) : '';
}

export function describeSafeElement(element) {
    if (!element || element === globalThis.window) return 'window';
    if (element === globalThis.document) return 'document';
    const tag = safeToken(element.localName || element.tagName || '', 24).toLowerCase();
    if (!tag) return 'unknown';
    const id = safeToken(element.id);
    let classes = [];
    try {
        classes = [...(element.classList || [])].map(value => safeToken(value, 32)).filter(Boolean).slice(0, 2);
    } catch {
        classes = [];
    }
    return `${tag}${id ? `#${id}` : ''}${classes.map(value => `.${value}`).join('')}`.slice(0, 120);
}

function safePath(event) {
    try {
        return (event.composedPath?.() || []).slice(0, 7).map(describeSafeElement);
    } catch {
        return [describeSafeElement(event.target)];
    }
}

function safeHitStack(documentRef, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    try {
        const stack = documentRef?.elementsFromPoint?.(x, y);
        if (Array.isArray(stack) || stack?.length >= 0) {
            return [...stack].slice(0, 7).map(describeSafeElement);
        }
        const hit = documentRef?.elementFromPoint?.(x, y);
        return hit ? [describeSafeElement(hit)] : [];
    } catch {
        return [];
    }
}

function inspectElementChain(element, windowRef) {
    const chain = [];
    const issues = new Set();
    for (let current = element; current && chain.length < 6; current = current.parentElement) {
        let style = null;
        try {
            style = windowRef?.getComputedStyle?.(current) || null;
        } catch {
            style = null;
        }
        const state = {
            element: describeSafeElement(current),
            disabled: Boolean(current.disabled || current.getAttribute?.('aria-disabled') === 'true'),
            inert: Boolean(current.inert || current.hasAttribute?.('inert')),
            pointerEvents: String(style?.pointerEvents || ''),
            visibility: String(style?.visibility || ''),
            display: String(style?.display || ''),
            opacity: String(style?.opacity || ''),
            zIndex: String(style?.zIndex || ''),
        };
        if (state.disabled) issues.add('disabled');
        if (state.inert) issues.add('inert');
        if (state.pointerEvents === 'none') issues.add('pointer-events-none');
        if (state.visibility === 'hidden' || state.visibility === 'collapse') issues.add('hidden');
        if (state.display === 'none') issues.add('display-none');
        chain.push(state);
    }
    return { chain, issues: [...issues] };
}

function inspectPopups(documentRef, windowRef) {
    const dialogs = documentRef?.querySelectorAll?.('dialog[open]') || [];
    return [...dialogs].slice(-4).map(dialog => {
        let style = null;
        try {
            style = windowRef?.getComputedStyle?.(dialog) || null;
        } catch {
            style = null;
        }
        return {
            element: describeSafeElement(dialog),
            closing: Boolean(dialog.hasAttribute?.('closing')),
            loader: Boolean(dialog.querySelector?.('#loader')),
            display: String(style?.display || ''),
            visibility: String(style?.visibility || ''),
            pointerEvents: String(style?.pointerEvents || ''),
            opacity: String(style?.opacity || ''),
            zIndex: String(style?.zIndex || ''),
        };
    });
}

function isLikelyControl(target) {
    try {
        return Boolean(target?.closest?.(CONTROL_SELECTOR));
    } catch {
        return false;
    }
}

function detectBlocker(documentRef, event) {
    const x = finite(event?.clientX, Number.NaN);
    const y = finite(event?.clientY, Number.NaN);
    let hit = event?.target || null;
    try {
        hit = documentRef?.elementFromPoint?.(x, y) || hit;
    } catch {
        // Keep the event target when hit-testing is unavailable.
    }
    const dialog = hit?.matches?.('dialog[open]') ? hit : null;
    if (dialog) return `dialog-backdrop:${describeSafeElement(dialog)}`;
    const explicit = hit?.closest?.(BLOCKER_SELECTOR);
    if (explicit) return describeSafeElement(explicit);
    return null;
}

function errorDescriptor(event) {
    const reason = event?.reason;
    const error = event?.error;
    const name = safeToken(error?.name || reason?.name || event?.type || 'Error', 48) || 'Error';
    let source = '';
    try {
        const pathname = new URL(event?.filename || '', globalThis.location?.origin || 'https://localhost').pathname;
        source = safeFileName(pathname.split('/').pop(), 64);
    } catch {
        source = '';
    }
    return {
        type: event?.type === 'unhandledrejection' ? 'unhandledrejection' : 'error',
        name,
        source: source || undefined,
        line: Number.isFinite(event?.lineno) ? event.lineno : undefined,
        column: Number.isFinite(event?.colno) ? event.colno : undefined,
    };
}

function storageRead(storage) {
    try {
        const value = JSON.parse(storage?.getItem?.(STORAGE_KEY) || 'null');
        return value && typeof value === 'object' ? value : null;
    } catch {
        return null;
    }
}

function storageWrite(storage, value) {
    try {
        let serialized = JSON.stringify(value);
        if (serialized.length > MAX_REPORT_BYTES) {
            const compact = {
                ...value,
                pointer: value.pointer ? {
                    ...value.pointer,
                    elementState: undefined,
                    popups: undefined,
                } : null,
                events: (value.events || []).slice(-6),
            };
            serialized = JSON.stringify(compact);
        }
        if (serialized.length > MAX_REPORT_BYTES) return;
        storage?.setItem?.(STORAGE_KEY, serialized);
    } catch {
        // Diagnostics must never affect the interaction being observed.
    }
}

export function classifyInteractionAnomaly(state = {}) {
    if (state.pointerCaptureStuck) return 'pointer-capture-residual';
    if (state.blocker) return 'hit-blocker';
    // A pointer-events rule on an ancestor can remain in computed style while
    // a captured pointer still completes its normal click path.  Treat that
    // as evidence only when the click was actually lost; otherwise this would
    // report successful taps (for example a prompt-manager minimize button)
    // as broken controls after copy/selection activity.
    const phases = state.phases || {};
    if (state.actionable && phases.clickBubble) return null;
    if (state.issues?.includes('disabled') || state.issues?.includes('inert')) return 'control-disabled';
    if (state.issues?.some(issue => ['pointer-events-none', 'hidden', 'display-none'].includes(issue))) {
        return 'control-not-hittable';
    }
    if ((phases.downCapture && !phases.downBubble)
        || (phases.upCapture && !phases.upBubble)
        || (phases.clickCapture && !phases.clickBubble)) return 'propagation-stopped';
    if (state.actionable && phases.upCapture && !phases.clickCapture) return 'click-missing';
    return null;
}

export async function copyDiagnosticText(text, {
    navigatorRef = globalThis.navigator,
    documentRef = globalThis.document,
} = {}) {
    try {
        if (navigatorRef?.clipboard?.writeText) {
            await navigatorRef.clipboard.writeText(String(text));
            return true;
        }
    } catch {
        // Fall back to the legacy copy path for Web Apps without clipboard permission.
    }
    const active = documentRef?.activeElement;
    const selection = documentRef?.getSelection?.();
    const ranges = [];
    try {
        for (let index = 0; index < Number(selection?.rangeCount || 0); index += 1) {
            ranges.push(selection.getRangeAt(index).cloneRange());
        }
    } catch {
        ranges.length = 0;
    }
    const parent = documentRef?.querySelector?.('dialog[open]:last-of-type') || documentRef?.body;
    if (!parent?.appendChild || !documentRef?.createElement) throw new Error('无法写入剪贴板');
    const textarea = documentRef.createElement('textarea');
    textarea.value = String(text);
    textarea.readOnly = true;
    textarea.setAttribute('aria-hidden', 'true');
    Object.assign(textarea.style, { position: 'fixed', inset: '0 auto auto -10000px', opacity: '0' });
    parent.appendChild(textarea);
    textarea.select?.();
    let copied = false;
    try {
        copied = Boolean(documentRef.execCommand?.('copy'));
    } finally {
        textarea.remove?.();
        try {
            selection?.removeAllRanges?.();
            for (const range of ranges) selection?.addRange?.(range);
        } catch {
            // Selection restoration is best-effort on older WebKit builds.
        }
        if (active?.isConnected) active.focus?.({ preventScroll: true });
    }
    if (!copied) throw new Error('无法写入剪贴板');
    return true;
}

export class InteractionDiagnostics {
    constructor({
        documentRef = globalThis.document,
        windowRef = globalThis.window,
        navigatorRef = globalThis.navigator,
        storage = globalThis.localStorage,
        now = () => Date.now(),
        monotonicNow = () => globalThis.performance?.now?.() ?? Date.now(),
        setTimer = globalThis.setTimeout,
        clearTimer = globalThis.clearTimeout,
    } = {}) {
        this.document = documentRef;
        this.window = windowRef;
        this.navigator = navigatorRef;
        this.storage = storage;
        this.now = now;
        this.monotonicNow = monotonicNow;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.events = [];
        this.listeners = [];
        this.activePointer = null;
        this.lastUserState = null;
        this.lastSelectionAt = -Infinity;
        this.lastClipboardActivityAt = -Infinity;
        this.lastUnconfirmedActivityAt = -Infinity;
        this.analysisTimer = null;
        this.started = false;
    }

    start() {
        if (this.started) return true;
        if (!this.document?.addEventListener || !this.window?.addEventListener) return false;
        this.started = true;
        for (const type of ['copy', 'cut', 'paste', 'contextmenu']) {
            this.listen(this.document, type, event => this.onClipboardEvent(event), true);
        }
        this.listen(this.document, 'selectionchange', event => this.onSelectionChange(event), true);
        for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click']) {
            this.listen(this.document, type, event => this.onPointerEvent(event, 'capture'), true);
            this.listen(this.document, type, event => this.onPointerEvent(event, 'bubble'), false);
        }
        for (const type of ['gotpointercapture', 'lostpointercapture']) {
            this.listen(this.document, type, event => this.record(type, {
                pointerId: finite(event.pointerId),
                target: describeSafeElement(event.target),
            }), true);
        }
        this.listen(this.window, 'error', event => this.onError(event), true);
        this.listen(this.window, 'unhandledrejection', event => this.onError(event), true);
        return true;
    }

    listen(target, type, handler, capture) {
        target.addEventListener(type, handler, capture);
        this.listeners.push([target, type, handler, capture]);
    }

    record(type, details = {}) {
        this.events.push({ at: this.now(), type, ...details });
        if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT);
    }

    onClipboardEvent(event) {
        this.lastClipboardActivityAt = this.monotonicNow();
        this.record(event.type, { target: describeSafeElement(event.target) });
    }

    onSelectionChange() {
        const now = this.monotonicNow();
        if (now - this.lastSelectionAt < 180) return;
        this.lastSelectionAt = now;
        this.lastClipboardActivityAt = now;
        this.record('selectionchange');
    }

    createPointerState(event) {
        const x = finite(event.clientX, Number.NaN);
        const y = finite(event.clientY, Number.NaN);
        const inspected = inspectElementChain(event.target, this.window);
        return {
            pointerId: finite(event.pointerId),
            pointerType: safeToken(event.pointerType, 16) || 'unknown',
            startedAt: this.monotonicNow(),
            target: describeSafeElement(event.target),
            path: safePath(event),
            hitStack: safeHitStack(this.document, x, y),
            point: Number.isFinite(x) && Number.isFinite(y) ? [Math.round(x), Math.round(y)] : undefined,
            actionable: isLikelyControl(event.target),
            blocker: detectBlocker(this.document, event),
            issues: inspected.issues,
            elementState: inspected.chain,
            popups: inspectPopups(this.document, this.window),
            phases: {},
            targetElement: event.target,
        };
    }

    matchingState(event) {
        if (!this.activePointer) return null;
        const age = this.monotonicNow() - this.activePointer.startedAt;
        if (age > ERROR_WINDOW_MS) return null;
        if (event.type === 'click') return this.activePointer;
        const pointerId = finite(event.pointerId);
        return pointerId === this.activePointer.pointerId ? this.activePointer : null;
    }

    onPointerEvent(event, phase) {
        if (!this.started) return;
        if (event.type !== 'pointercancel' && Number.isFinite(event.button) && event.button > 0) return;
        if (event.type === 'pointerdown' && phase === 'capture') {
            this.activePointer = this.createPointerState(event);
        }
        const state = this.matchingState(event);
        if (!state) return;
        const phaseName = event.type === 'pointerdown' ? 'down'
            : event.type === 'pointerup' ? 'up'
                : event.type === 'pointercancel' ? 'cancel' : 'click';
        state.phases[`${phaseName}${phase === 'capture' ? 'Capture' : 'Bubble'}`] = true;
        if (phase === 'bubble' && event.defaultPrevented) state.phases[`${phaseName}DefaultPrevented`] = true;
        this.record(`${event.type}:${phase}`, {
            target: describeSafeElement(event.target),
            defaultPrevented: Boolean(event.defaultPrevented),
        });

        if (event.type === 'pointercancel') {
            if (phase === 'bubble') this.activePointer = null;
            return;
        }
        if (event.type === 'pointerup' && phase === 'capture') {
            this.scheduleAnalysis(state);
            this.measureMainThreadDelay(state);
        }
        if (event.type === 'click') {
            this.lastUserState = state;
            if (phase === 'capture') this.scheduleAnalysis(state);
            if (phase === 'bubble') this.measureMainThreadDelay(state);
        }
    }

    measureMainThreadDelay(state) {
        const scheduledAt = this.monotonicNow();
        this.setTimer(() => {
            if (!this.started) return;
            const delayMs = Math.round(this.monotonicNow() - scheduledAt);
            if (delayMs >= BUSY_THRESHOLD_MS) {
                this.persistAnomaly('main-thread-busy', state, { delayMs });
            }
        }, 0);
    }

    scheduleAnalysis(state) {
        if (this.analysisTimer !== null) this.clearTimer(this.analysisTimer);
        this.analysisTimer = this.setTimer(() => {
            this.analysisTimer = null;
            if (!this.started || this.activePointer !== state) return;
            try {
                const target = state.targetElement;
                if (target?.hasPointerCapture?.(state.pointerId)) state.pointerCaptureStuck = true;
            } catch {
                // Pointer capture support differs across WebKit versions.
            }
            const kind = classifyInteractionAnomaly(state);
            if (kind) {
                this.persistAnomaly(kind, state);
                return;
            }
            const sinceClipboard = this.monotonicNow() - this.lastClipboardActivityAt;
            if (state.actionable && state.phases.clickBubble
                && sinceClipboard >= 0 && sinceClipboard <= CLIPBOARD_CORRELATION_MS) {
                this.persistAnomaly('unconfirmed', state, { sinceClipboardMs: Math.round(sinceClipboard) });
            }
        }, CLICK_WAIT_MS);
    }

    onError(event) {
        const error = errorDescriptor(event);
        this.record(error.type, error);
        const state = this.lastUserState || this.activePointer;
        if (!state || this.monotonicNow() - state.startedAt > ERROR_WINDOW_MS) return;
        this.persistAnomaly('business-exception', state, { error });
    }

    persistAnomaly(kind, state, extra = {}) {
        if (kind === 'unconfirmed') {
            if (this.lastClipboardActivityAt <= this.lastUnconfirmedActivityAt) return;
            const previous = storageRead(this.storage);
            const previousAt = Date.parse(previous?.recordedAt || '');
            if (previous?.kind && previous.kind !== 'unconfirmed'
                && Number.isFinite(previousAt) && this.now() - previousAt < 30000) return;
            this.lastUnconfirmedActivityAt = this.lastClipboardActivityAt;
        }
        const report = {
            schema: 1,
            recordedAt: new Date(this.now()).toISOString(),
            kind,
            environment: Number(this.navigator?.maxTouchPoints || 0) > 0 ? 'touch' : 'desktop',
            pointer: state ? {
                pointerType: state.pointerType,
                target: state.target,
                path: state.path,
                hitStack: state.hitStack,
                point: state.point,
                actionable: state.actionable,
                blocker: state.blocker,
                issues: state.issues,
                phases: state.phases,
                pointerCaptureStuck: Boolean(state.pointerCaptureStuck),
                elementState: state.elementState,
                popups: state.popups,
            } : null,
            ...extra,
            events: this.events.slice(-PERSISTED_EVENT_LIMIT),
        };
        storageWrite(this.storage, report);
        console.info('[Cloud Lounge Accelerator] 交互诊断已保存', {
            kind: report.kind,
            target: report.pointer?.target,
        });
    }

    getReport() {
        return storageRead(this.storage);
    }

    getSummary() {
        const report = this.getReport();
        if (!report) return '等待异常证据';
        const labels = {
            'hit-blocker': '点击命中遮罩',
            'propagation-stopped': '事件传播中断',
            'click-missing': '未生成 click',
            'control-disabled': '控件被禁用',
            'control-not-hittable': '控件不可命中',
            'pointer-capture-residual': '指针捕获残留',
            'business-exception': '业务处理异常',
            'main-thread-busy': '主线程繁忙',
            unconfirmed: 'click 已到达，无法确认',
        };
        return `${labels[report.kind] || '无法确认'} · ${report.recordedAt || '已保存'}`;
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        for (const [target, type, handler, capture] of this.listeners) {
            target.removeEventListener?.(type, handler, capture);
        }
        this.listeners = [];
        if (this.analysisTimer !== null) this.clearTimer(this.analysisTimer);
        this.analysisTimer = null;
        this.activePointer = null;
        this.lastUserState = null;
    }
}
