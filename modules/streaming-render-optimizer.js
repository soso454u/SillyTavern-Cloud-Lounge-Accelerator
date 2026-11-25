import { detectRenderProfile, matchesMedia } from '../utils/device-profile.js';
import { getComplexityInterval, measureRenderComplexity } from './render-complexity.js';

// Limit expensive native preview passes, never the incoming token stream.
// Native finalization always calls onProgressStreaming(id, fullText, true).
const PREVIEW_INTERVAL_MS = { desktop: 1000 / 30, balanced: 80, webkit: 100 };
const SCROLL_INTERVAL_MS = 250;
const SCROLL_SETTLE_MS = 200;
const MAX_INERTIA_MS = 800;
const TOKEN_TASK_BUDGET_MS = 12;
const SLOW_FRAME_MS = 50;

export class StreamingRenderOptimizer {
    constructor({
        eventSource, eventTypes = {}, getStreamingProcessor = () => null,
        documentRef = globalThis.document, navigatorRef = globalThis.navigator,
        matchMedia = globalThis.matchMedia, now = () => performance.now(),
        requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
        cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis),
        yieldToMain = () => new Promise(resolve => setTimeout(resolve, 0)),
    } = {}) {
        Object.assign(this, { eventSource, eventTypes, getStreamingProcessor, now, requestFrame, cancelFrame, yieldToMain });
        this.document = documentRef;
        this.navigator = navigatorRef;
        this.matchMedia = matchMedia;
        this.started = false;
        this.handlers = [];
        this.current = null;
        this.touch = null;
        this.scrollingUntil = 0;
        this.scrollDeadline = 0;
        this.interactingUntil = 0;
        this.report = { observedPreviews: 0, skippedPreviews: 0, maxPreviewMs: 0, lastPreviewMs: 0, maxRecoveryMs: 0 };
        this.onToken = async () => {
            this.attach();
            const state = this.current;
            if (!state || this.document?.hidden || typeof this.requestFrame !== 'function') return;
            this.watchFrame(state);
            // An SSE burst may keep resolving promises without returning to a
            // browser task, even when previews are skipped. Yield cooperatively
            // only when a requested frame is still waiting after the budget.
            if (state.frameId !== null && this.now() - state.frameStartedAt >= TOKEN_TASK_BUDGET_MS) {
                this.report.tokenYields = (this.report.tokenYields || 0) + 1;
                await this.yieldToMain();
            }
        };
        this.onVisibilityChange = () => this.cancelPendingFrame(this.current);
        this.onEnd = () => this.detach();
        this.onChatChange = () => this.detach();
        this.onPointerInput = () => {
            if (this.current) this.interactingUntil = this.now() + 180;
        };
        this.onTouchStart = event => {
            const touch = event.touches?.length === 1 && event.touches[0];
            const chat = event.target?.closest?.('#chat');
            this.touch = touch && chat
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
            const chat = event.target?.closest?.('#chat');
            if (chat) this.noteScrollInput();
        };
        this.onScroll = event => {
            // Native autoscroll must not put an idle preview in the scroll tier.
            if (event.target?.id !== 'chat' || !this.scrollingUntil) return;
            const now = this.now();
            if (now < this.scrollingUntil) {
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
        this.attach();
    }

    inputHandlers() {
        return [
            ['touchstart', this.onTouchStart], ['touchmove', this.onTouchMove],
            ['touchend', this.onTouchEnd], ['touchcancel', this.onTouchEnd],
            ['wheel', this.onWheel], ['scroll', this.onScroll],
            ['pointerdown', this.onPointerInput], ['pointerup', this.onPointerInput],
            ['visibilitychange', this.onVisibilityChange],
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
            frameId: null, frameStartedAt: 0,
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
            if (preview && optimizer.current === state) {
                state.messageId = messageId;
                // Formatting time alone excludes subsequent browser layout and
                // helper iframe work. Size the recovery from actual output too,
                // including regex-inserted HTML that is absent from raw tokens.
                let complexityInterval = 0;
                try {
                    const root = optimizer.document?.querySelector?.(`#chat .mes[mesid="${messageId}"] .mes_text`);
                    const sample = measureRenderComplexity(root, optimizer.document);
                    complexityInterval = getComplexityInterval(sample, optimizer.profile);
                    optimizer.report.renderComplexity = sample;
                } catch {
                    // Optional sampling must never fail a native render.
                }
                const finishedAt = optimizer.now();
                const cost = Math.max(0, finishedAt - now);
                const interval = finishedAt < optimizer.scrollingUntil ? SCROLL_INTERVAL_MS : optimizer.interval;
                const recovery = Math.max(interval, complexityInterval, Math.min(1000, cost * 2));
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
        for (const [type, handler] of this.inputHandlers()) {
            this.document?.addEventListener(type, handler, { passive: true, capture: true });
        }
    }

    detach() {
        const state = this.current;
        this.cancelPendingFrame(state);
        if (state && state.processor.onProgressStreaming === state.wrapper) {
            if (state.ownDescriptor) Object.defineProperty(state.processor, 'onProgressStreaming', state.ownDescriptor);
            else delete state.processor.onProgressStreaming;
        }
        this.current = null;
        if (!state) return;
        for (const [type, handler] of this.inputHandlers()) this.document?.removeEventListener(type, handler, true);
        this.touch = null;
        this.scrollingUntil = 0;
        this.scrollDeadline = 0;
        this.interactingUntil = 0;
    }

    getReport() {
        return { ...this.report, attached: Boolean(this.current),
            timing: 'native-preview-including-awaited-work', version: 3 };
    }

    watchFrame(state) {
        if (state.frameId !== null) return;
        state.frameStartedAt = this.now();
        state.frameId = this.requestFrame(() => {
            state.frameId = null;
            if (this.current !== state || this.document?.hidden) return;
            const now = this.now();
            const delay = Math.max(0, now - state.frameStartedAt);
            this.report.maxFrameWaitMs = Math.max(this.report.maxFrameWaitMs || 0, Math.round(delay));
            // Includes browser work that happens after the awaited formatter:
            // layout, theme effects and extension work on ordinary cards too.
            if (delay > SLOW_FRAME_MS && state.messageId !== null) {
                const recovery = Math.min(1000, delay * 2);
                state.nextAt = Math.max(state.nextAt, now + recovery);
                this.report.maxRecoveryMs = Math.max(this.report.maxRecoveryMs, Math.round(recovery));
            }
        });
    }

    cancelPendingFrame(state) {
        if (state?.frameId == null) return;
        this.cancelFrame?.(state.frameId);
        state.frameId = null;
    }

    stop() {
        this.started = false;
        this.detach();
        for (const [name, handler] of this.handlers) this.eventSource?.removeListener(name, handler);
        this.handlers = [];

    }
}
