import { detectRenderProfile, matchesMedia } from '../utils/device-profile.js';

// Limit expensive native preview passes, never the incoming token stream.
// Native finalization always calls onProgressStreaming(id, fullText, true).
const PREVIEW_INTERVAL_MS = { desktop: 1000 / 30, balanced: 80, webkit: 100 };
const SCROLL_INTERVAL_MS = 250;
const SCROLL_SETTLE_MS = 200;
const MAX_INERTIA_MS = 800;

export class StreamingRenderOptimizer {
    constructor({
        eventSource, eventTypes = {}, getStreamingProcessor = () => null,
        documentRef = globalThis.document, navigatorRef = globalThis.navigator,
        matchMedia = globalThis.matchMedia, now = () => performance.now(),
        setTimeoutRef = (callback, delay) => globalThis.setTimeout(callback, delay),
        clearTimeoutRef = id => globalThis.clearTimeout(id),
    } = {}) {
        Object.assign(this, { eventSource, eventTypes, getStreamingProcessor, now });
        this.document = documentRef;
        this.navigator = navigatorRef;
        this.matchMedia = matchMedia;
        this.setTimeout = setTimeoutRef;
        this.clearTimeout = clearTimeoutRef;
        this.started = false;
        this.handlers = [];
        this.current = null;
        this.touch = null;
        this.scrollingUntil = 0;
        this.scrollDeadline = 0;
        this.interactingUntil = 0;
        this.report = { observedPreviews: 0, skippedPreviews: 0, maxPreviewMs: 0, lastPreviewMs: 0, maxRecoveryMs: 0 };
        this.onToken = () => this.attach();
        this.onEnd = () => this.detach();
        this.onChatChange = () => { this.detach(); this.clearScrollPaint(); };
        this.onVisibility = () => {
            if (this.document?.hidden) this.clearScrollPaint();
        };
        this.onPointerInput = () => {
            if (this.current) this.interactingUntil = this.now() + 180;
        };
        this.onTouchStart = event => {
            const touch = event.touches?.length === 1 && event.touches[0];
            const chat = event.target?.closest?.('#chat');
            this.touch = touch && chat
                ? { id: touch.identifier, x: touch.clientX, y: touch.clientY, chat } : null;
        };
        this.onTouchMove = event => {
            const touch = event.touches?.length === 1 && event.touches[0];
            if (!touch) this.touch = null;
            if (!this.touch || !touch || touch.identifier !== this.touch.id) return;
            if (Math.hypot(touch.clientX - this.touch.x, touch.clientY - this.touch.y) >= 10) {
                this.noteScrollInput();
                this.noteScrollPaint(this.touch.chat);
            }
        };
        this.onTouchEnd = () => { this.touch = null; };
        this.onWheel = event => {
            const chat = event.target?.closest?.('#chat');
            if (chat) { this.noteScrollInput(); this.noteScrollPaint(chat); }
        };
        this.onScroll = event => {
            // Native autoscroll must not put an idle preview in the scroll tier.
            const now = this.now();
            if (event.target?.id === 'chat' && now < this.scrollingUntil) {
                this.scrollingUntil = Math.min(this.scrollDeadline, now + SCROLL_SETTLE_MS);
            }
            if (event.target?.id === 'chat') this.noteScrollPaint(event.target);
        };
    }

    noteScrollPaint(chat) {
        // Share the existing passive input listeners. This also works when no
        // generation is running; no message scan, layout read or scroll write.
        if (!this.started || this.profile === 'desktop' || !chat?.classList || this.document?.hidden) return;
        if (this.scrollChat !== chat) {
            this.clearScrollPaint();
            this.scrollChat = chat;
            chat.classList.add('cla-chat-scrolling');
        }
        this.clearTimeout(this.scrollTimer);
        this.scrollTimer = this.setTimeout(() => this.clearScrollPaint(), SCROLL_SETTLE_MS);
    }

    clearScrollPaint() {
        this.clearTimeout(this.scrollTimer);
        this.scrollTimer = null;
        this.scrollChat?.classList.remove('cla-chat-scrolling');
        this.scrollChat = null;
    }

    noteScrollInput() {
        const now = this.now();
        this.scrollingUntil = now + SCROLL_SETTLE_MS;
        this.scrollDeadline = now + MAX_INERTIA_MS;
    }

    start() {
        if (this.started) return;
        this.started = true;
        const profile = detectRenderProfile({
            userAgent: this.navigator?.userAgent, platform: this.navigator?.platform,
            maxTouchPoints: this.navigator?.maxTouchPoints,
            coarsePointer: matchesMedia('(pointer: coarse)', this.matchMedia),
        });
        this.interval = PREVIEW_INTERVAL_MS[profile];
        this.profile = profile;
        this.report.profile = profile;
        for (const [name, handler] of [
            [this.eventTypes.STREAM_TOKEN_RECEIVED, this.onToken],
            [this.eventTypes.GENERATION_ENDED, this.onEnd],
            [this.eventTypes.GENERATION_STOPPED, this.onEnd],
            [this.eventTypes.CHAT_CHANGED, this.onChatChange],
        ]) {
            if (!name) continue;
            this.eventSource?.on(name, handler);
            this.handlers.push([name, handler]);
        }
        for (const [type, handler] of this.inputHandlers()) {
            this.document?.addEventListener(type, handler, { passive: true, capture: true });
        }
        this.attach();
    }

    inputHandlers() {
        return [
            ['touchstart', this.onTouchStart], ['touchmove', this.onTouchMove],
            ['touchend', this.onTouchEnd], ['touchcancel', this.onTouchEnd],
            ['wheel', this.onWheel], ['scroll', this.onScroll],
            ['pointerdown', this.onPointerInput], ['pointerup', this.onPointerInput],
            ['visibilitychange', this.onVisibility],
        ];
    }

    attach() {
        if (!this.started) return;
        const processor = this.getStreamingProcessor();
        if (processor === this.current?.processor) return;
        this.detach();
        // Unknown/native-incompatible implementations retain their own path.
        if (!processor || processor.type === 'impersonate'
            || typeof processor.onProgressStreaming !== 'function'
            || typeof processor.finalizeIntermediaryMessage !== 'function') return;
        const ownDescriptor = Object.getOwnPropertyDescriptor(processor, 'onProgressStreaming');
        if (ownDescriptor && (!('value' in ownDescriptor) || !ownDescriptor.writable)) return;
        if (!ownDescriptor && !Object.isExtensible(processor)) return;
        const state = {
            processor, ownDescriptor, original: processor.onProgressStreaming,
            nextAt: -Infinity, messageId: null,
        };
        const optimizer = this;
        state.wrapper = async function (...args) {
            const [messageId, text, isFinal] = args;
            const now = optimizer.now();
            const preview = optimizer.started && optimizer.current === state
                && this === processor && !isFinal && Number.isInteger(messageId)
                && messageId >= 0 && typeof text === 'string';
            if (preview && ((messageId === state.messageId && now < state.nextAt) || now < optimizer.interactingUntil)) {
                optimizer.report.skippedPreviews += 1;
                return;
            }
            // Do not retain skipped text/DOM or schedule a delayed replay that
            // could overwrite a final render, tool call, stop or new chat.
            const result = await state.original.apply(this, args);
            if (preview) {
                state.messageId = messageId;
                const finishedAt = optimizer.now();
                const cost = Math.max(0, finishedAt - now);
                const interval = finishedAt < optimizer.scrollingUntil ? SCROLL_INTERVAL_MS : optimizer.interval;
                const recovery = Math.max(interval, Math.min(1000, cost * 2));
                // Recovery starts AFTER native formatting finishes. A costly
                // pass must never consume its own idle interval and immediately
                // start another pass (the old start-time deadline did that).
                state.nextAt = finishedAt + recovery;
                optimizer.report.observedPreviews += 1;
                optimizer.report.lastPreviewMs = Math.round(cost);
                optimizer.report.maxPreviewMs = Math.max(optimizer.report.maxPreviewMs, Math.round(cost));
                optimizer.report.maxRecoveryMs = Math.max(optimizer.report.maxRecoveryMs, Math.round(recovery));
            } else if (isFinal) {
                state.nextAt = -Infinity;
                state.messageId = null;
            }
            return result;
        };
        try {
            processor.onProgressStreaming = state.wrapper;
        } catch {
            return;
        }
        this.current = state;
        if (this.profile !== 'desktop') {
            this.lightChat = this.document?.querySelector?.('#chat');
            this.lightChat?.classList?.add?.('cla-streaming-light');
        }
    }

    detach() {
        this.lightChat?.classList?.remove?.('cla-streaming-light');
        this.lightChat = null;
        const state = this.current;
        if (state && state.processor.onProgressStreaming === state.wrapper) {
            if (state.ownDescriptor) Object.defineProperty(state.processor, 'onProgressStreaming', state.ownDescriptor);
            else delete state.processor.onProgressStreaming;
        }
        this.current = null;
    }

    getReport() {
        return { ...this.report, attached: Boolean(this.current), scrollReliefActive: Boolean(this.scrollChat),
            timing: 'native-preview-including-awaited-work', version: 2 };
    }

    stop() {
        this.started = false;
        this.detach();
        this.clearScrollPaint();
        for (const [name, handler] of this.handlers) this.eventSource?.removeListener(name, handler);
        this.handlers = [];
        for (const [type, handler] of this.inputHandlers()) this.document?.removeEventListener(type, handler, true);
        this.touch = null;
        this.scrollingUntil = 0;
        this.scrollDeadline = 0;
        this.interactingUntil = 0;
    }
}
