import { detectRenderProfile, matchesMedia } from '../utils/device-profile.js';

// Limit expensive native preview passes, never the incoming token stream.
// Native finalization always calls onProgressStreaming(id, fullText, true).
const PREVIEW_INTERVAL_MS = { desktop: 1000 / 30, balanced: 50, webkit: 50 };
const SCROLL_INTERVAL_MS = 125;
const SCROLL_SETTLE_MS = 200;
const MAX_INERTIA_MS = 800;

export class StreamingRenderOptimizer {
    constructor({
        eventSource, eventTypes = {}, getStreamingProcessor = () => null,
        documentRef = globalThis.document, navigatorRef = globalThis.navigator,
        matchMedia = globalThis.matchMedia, now = () => performance.now(),
    } = {}) {
        Object.assign(this, { eventSource, eventTypes, getStreamingProcessor, now });
        this.document = documentRef;
        this.navigator = navigatorRef;
        this.matchMedia = matchMedia;
        this.started = false;
        this.handlers = [];
        this.current = null;
        this.touch = null;
        this.scrollingUntil = 0;
        this.scrollDeadline = 0;
        this.onToken = () => this.attach();
        this.onEnd = () => this.detach();
        this.onTouchStart = event => {
            const touch = event.touches?.length === 1 && event.touches[0];
            this.touch = touch && event.target?.closest?.('#chat')
                ? { id: touch.identifier, x: touch.clientX, y: touch.clientY } : null;
        };
        this.onTouchMove = event => {
            const touch = event.touches?.length === 1 && event.touches[0];
            if (!touch) this.touch = null;
            if (!this.touch || !touch || touch.identifier !== this.touch.id) return;
            if (Math.hypot(touch.clientX - this.touch.x, touch.clientY - this.touch.y) >= 10) {
                this.noteScrollInput();
            }
        };
        this.onTouchEnd = () => { this.touch = null; };
        this.onWheel = event => {
            if (event.target?.closest?.('#chat')) this.noteScrollInput();
        };
        this.onScroll = event => {
            // Native autoscroll must not put an idle preview in the scroll tier.
            const now = this.now();
            if (event.target?.id === 'chat' && now < this.scrollingUntil) {
                this.scrollingUntil = Math.min(this.scrollDeadline, now + SCROLL_SETTLE_MS);
            }
        };
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
        for (const [name, handler] of [
            [this.eventTypes.STREAM_TOKEN_RECEIVED, this.onToken],
            [this.eventTypes.GENERATION_ENDED, this.onEnd],
            [this.eventTypes.GENERATION_STOPPED, this.onEnd],
            [this.eventTypes.CHAT_CHANGED, this.onEnd],
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
            if (preview && messageId === state.messageId && now < state.nextAt) return;
            // Do not retain skipped text/DOM or schedule a delayed replay that
            // could overwrite a final render, tool call, stop or new chat.
            const result = await state.original.apply(this, args);
            if (preview) {
                state.messageId = messageId;
                const cost = Math.max(0, optimizer.now() - now);
                const interval = now < optimizer.scrollingUntil ? SCROLL_INTERVAL_MS : optimizer.interval;
                // Leave time between expensive formatting passes for input and
                // painting. Native lower FPS settings continue to win.
                state.nextAt = now + Math.max(interval, Math.min(125, cost * 3));
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
    }

    detach() {
        const state = this.current;
        if (state && state.processor.onProgressStreaming === state.wrapper) {
            if (state.ownDescriptor) Object.defineProperty(state.processor, 'onProgressStreaming', state.ownDescriptor);
            else delete state.processor.onProgressStreaming;
        }
        this.current = null;
    }

    stop() {
        this.started = false;
        this.detach();
        for (const [name, handler] of this.handlers) this.eventSource?.removeListener(name, handler);
        this.handlers = [];
        for (const [type, handler] of this.inputHandlers()) this.document?.removeEventListener(type, handler, true);
        this.touch = null;
        this.scrollingUntil = 0;
        this.scrollDeadline = 0;
    }
}
