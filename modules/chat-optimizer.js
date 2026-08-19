import {
    chooseAdaptiveChatLimit,
    detectSwipeAxis,
    measureChatPayload,
} from '../client-core.js';

const CODE_SELECTOR = '#chat .mes pre code';
const LOG_PREFIX = '[Cloud Lounge Accelerator]';
const ORIGINAL_TRUNCATION_KEY = 'cloud-lounge-accelerator:original-chat-truncation';

function isVisible(element, root) {
    if (!(element instanceof Element) || !(root instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    return rect.bottom >= rootRect.top && rect.top <= rootRect.bottom;
}

export function hasRenderedChatTail(chatElement, expectedLastId) {
    if (!chatElement || !Number.isInteger(expectedLastId) || expectedLastId < 0) return false;
    const messages = chatElement.querySelectorAll?.('.mes[mesid]') || [];
    const lastMessage = messages[messages.length - 1];
    return Number(lastMessage?.getAttribute?.('mesid')) === expectedLastId;
}

export class ChatOptimizer {
    constructor({
        eventSource,
        eventTypes,
        chat = [],
        isGenerating = () => false,
        getCurrentChatId = () => true,
        scheduler,
        saveSettings,
        scrollToBottom = null,
        refreshSwipeButtons = null,
        onStatus = null,
    }) {
        this.eventSource = eventSource;
        this.eventTypes = eventTypes;
        this.chat = chat;
        this.isGenerating = isGenerating;
        this.getCurrentChatId = getCurrentChatId;
        this.scheduler = scheduler;
        this.saveSettings = saveSettings;
        this.scrollToBottom = scrollToBottom;
        this.refreshSwipeButtons = refreshSwipeButtons;
        this.onStatus = onStatus;
        this.started = false;
        this.powerUser = null;
        this.originalTruncation = null;
        this.chatElement = null;
        this.domObserver = null;
        this.eventHandlers = [];
        this.highlightLibrary = null;
        this.originalHighlight = null;
        this.originalHighlights = new Map();
        this.highlightWrappers = new Map();
        this.highlightObserver = null;
        this.codeScanTimer = null;
        this.codeScanFrame = null;
        this.generationEndTimer = null;
        this.touchState = null;
        this.swipeSuppressUntil = 0;
        this.heavyHtmlMode = false;
        this.pendingMetrics = null;
        this.generation = 0;
        this.bottomSettleTimers = new Set();
        this.bottomSettleCleanup = null;
        this.activeChatKey = null;
        this.historyAnchor = null;
        this.historyAnchorFrame = null;
        this.historyAnchorTimers = new Set();
    }

    async start({ legacyTruncation = null } = {}) {
        if (this.started) return;
        this.started = true;
        const generation = ++this.generation;
        try {
            const module = await import('../../../../power-user.js');
            if (!this.started || generation !== this.generation) return;
            this.powerUser = module.power_user;
            const storedTruncation = Number(localStorage.getItem(ORIGINAL_TRUNCATION_KEY));
            const restoredTruncation = Number.isFinite(legacyTruncation)
                ? legacyTruncation
                : (Number.isFinite(storedTruncation) && storedTruncation > 0 ? storedTruncation : null);
            if (Number.isFinite(legacyTruncation)) {
                this.powerUser.chat_truncation = legacyTruncation;
                this.saveSettings?.();
            }
            this.originalTruncation = Number.isFinite(restoredTruncation)
                ? restoredTruncation
                : (Number.isFinite(this.powerUser?.chat_truncation) ? this.powerUser.chat_truncation : 100);
            localStorage.setItem(ORIGINAL_TRUNCATION_KEY, String(this.originalTruncation));
            const initialMetrics = this.pendingMetrics || (Array.isArray(this.chat) && this.chat.length
                ? measureChatPayload(this.chat)
                : { averageTextLength: 1200, richMarkerCount: 3, heavyHtmlCount: 0, maxHtmlLength: 0 });
            this.pendingMetrics = null;
            this.applyMetrics(initialMetrics);
        } catch (error) {
            console.debug(LOG_PREFIX, '官方聊天截断接口不可用', error);
        }
        this.bind(this.eventTypes.CHAT_CHANGED, () => this.handleChatChanged());
        this.bind(this.eventTypes.MORE_MESSAGES_LOADED, () => this.handleMoreMessagesLoaded());
        this.bind(this.eventTypes.GENERATION_STARTED, () => this.pauseCodeScanning());
        this.bind(this.eventTypes.GENERATION_STOPPED, () => this.refreshAfterGeneration());
        this.bind(this.eventTypes.GENERATION_ENDED, () => this.refreshAfterGeneration());
        this.refreshChatBindings();
        await this.installHighlighter(generation);
        if (!this.started || generation !== this.generation) return;
        this.installHistoryAnchorGuard();
        this.installSwipeGuard();
        this.onStatus?.('chat', '自动');
    }

    bind(name, handler) {
        if (!name) return;
        this.eventSource.on(name, handler);
        this.eventHandlers.push([name, handler]);
    }

    inspectPayload(messages) {
        if (!this.started) return;
        const metrics = measureChatPayload(messages);
        if (!this.powerUser) {
            this.pendingMetrics = metrics;
            return;
        }
        this.applyMetrics(metrics);
    }

    applyMetrics(metrics) {
        if (!this.powerUser || !this.started) return;
        this.heavyHtmlMode = Number(metrics?.heavyHtmlCount) > 0 || Number(metrics?.maxHtmlLength) >= 10000;
        const limit = chooseAdaptiveChatLimit({
            ...metrics,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory,
        });
        this.powerUser.chat_truncation = limit;
    }

    refreshChatBindings() {
        this.domObserver?.disconnect();
        this.chatElement = document.querySelector('#chat');
        if (!this.chatElement || !this.started) return;
        this.domObserver = new MutationObserver(() => {
            if (this.isGenerating?.()) return;
            this.queueCodeScan();
        });
        this.domObserver.observe(this.chatElement, { childList: true, subtree: true });
        if (!this.isGenerating?.()) this.queueCodeScan(0);
    }

    pauseCodeScanning() {
        clearTimeout(this.codeScanTimer);
        this.codeScanTimer = null;
        if (this.codeScanFrame !== null) cancelAnimationFrame(this.codeScanFrame);
        this.codeScanFrame = null;
    }

    queueCodeScan(delay = 180) {
        if (!this.started || this.isGenerating?.()) return;
        clearTimeout(this.codeScanTimer);
        this.codeScanTimer = setTimeout(() => {
            this.codeScanTimer = null;
            if (!this.started || this.isGenerating?.()) return;
            if (this.codeScanFrame !== null) cancelAnimationFrame(this.codeScanFrame);
            this.codeScanFrame = requestAnimationFrame(() => {
                this.codeScanFrame = null;
                if (!this.started || this.isGenerating?.()) return;
                this.observeCodeBlocks();
            });
        }, delay);
    }

    refreshAfterGeneration() {
        clearTimeout(this.generationEndTimer);
        const waitForUnlock = () => {
            this.generationEndTimer = null;
            if (!this.started) return;
            if (this.isGenerating?.()) {
                this.generationEndTimer = setTimeout(waitForUnlock, 80);
                return;
            }
            this.queueCodeScan(0);
        };
        waitForUnlock();
    }

    handleChatChanged() {
        this.inspectPayload(this.chat);
        this.refreshChatBindings();

        const chatId = this.getCurrentChatId?.();
        const nextChatKey = chatId == null ? null : String(chatId);
        if (nextChatKey === null) {
            this.activeChatKey = null;
            this.cancelInitialBottom();
            this.cancelHistoryAnchor();
            return;
        }
        if (nextChatKey === this.activeChatKey) return;

        this.cancelHistoryAnchor();
        this.activeChatKey = nextChatKey;
        this.settleInitialBottom();
    }

    handleMoreMessagesLoaded() {
        const chatId = this.getCurrentChatId?.();
        this.activeChatKey = chatId == null ? null : String(chatId);
        this.cancelInitialBottom();
        this.settleHistoryAnchor();
    }

    installHistoryAnchorGuard() {
        this.onHistoryPointerDown = event => {
            if (event.target?.closest?.('#show_more_messages')) {
                this.captureHistoryAnchor();
                return;
            }
            this.cancelHistoryAnchor();
        };
        this.onHistoryClick = event => {
            if (event.target?.closest?.('#show_more_messages')) {
                if (!this.historyAnchor) this.captureHistoryAnchor();
                return;
            }
            this.cancelHistoryAnchor();
        };
        this.onHistoryUserInput = () => this.cancelHistoryAnchor();
        document.addEventListener('pointerdown', this.onHistoryPointerDown, true);
        document.addEventListener('click', this.onHistoryClick, true);
        document.addEventListener('wheel', this.onHistoryUserInput, { passive: true, capture: true });
        document.addEventListener('keydown', this.onHistoryUserInput, true);
    }

    captureHistoryAnchor() {
        this.cancelInitialBottom();
        this.cancelHistoryAnchor();
        const chatElement = this.chatElement;
        const anchor = chatElement?.querySelector?.('.mes[mesid]');
        const top = Number(anchor?.getBoundingClientRect?.().top);
        const chatId = this.getCurrentChatId?.();
        if (!chatElement || !Number.isFinite(top) || chatId == null) return;
        this.historyAnchor = {
            anchor,
            chatElement,
            chatKey: String(chatId),
            top,
        };
    }

    restoreHistoryAnchor() {
        const state = this.historyAnchor;
        if (!state || !this.started || this.chatElement !== state.chatElement || state.anchor?.isConnected === false) {
            this.cancelHistoryAnchor();
            return;
        }
        const chatId = this.getCurrentChatId?.();
        if (chatId == null || String(chatId) !== state.chatKey) {
            this.cancelHistoryAnchor();
            return;
        }
        const currentTop = Number(state.anchor?.getBoundingClientRect?.().top);
        if (!Number.isFinite(currentTop)) {
            this.cancelHistoryAnchor();
            return;
        }
        const delta = currentTop - state.top;
        if (Math.abs(delta) <= 0.5) return;
        const currentScrollTop = Number(state.chatElement.scrollTop || 0);
        state.chatElement.scrollTop = Math.max(0, currentScrollTop + delta);
    }

    settleHistoryAnchor() {
        if (!this.historyAnchor) return;
        this.restoreHistoryAnchor();
        this.historyAnchorFrame = requestAnimationFrame(() => {
            this.historyAnchorFrame = null;
            this.restoreHistoryAnchor();
        });
        const schedule = (callback, delay) => {
            const timer = setTimeout(() => {
                this.historyAnchorTimers.delete(timer);
                callback();
            }, delay);
            this.historyAnchorTimers.add(timer);
        };
        // SillyTavern starts its media watcher after debounce_timeout.short
        // (200ms), then accepts loads for another 1000ms. Keep the DOM message
        // anchor stable across that exact upstream window, then release it.
        for (const delay of [80, 240, 600, 1100, 1280]) schedule(() => this.restoreHistoryAnchor(), delay);
        schedule(() => this.cancelHistoryAnchor(), 1400);
    }

    cancelHistoryAnchor() {
        if (this.historyAnchorFrame !== null) cancelAnimationFrame(this.historyAnchorFrame);
        this.historyAnchorFrame = null;
        for (const timer of this.historyAnchorTimers) clearTimeout(timer);
        this.historyAnchorTimers.clear();
        this.historyAnchor = null;
    }

    cancelInitialBottom() {
        for (const timer of this.bottomSettleTimers) clearTimeout(timer);
        this.bottomSettleTimers.clear();
        const cleanup = this.bottomSettleCleanup;
        this.bottomSettleCleanup = null;
        cleanup?.();
    }

    settleInitialBottom() {
        this.cancelInitialBottom();
        const chatElement = this.chatElement;
        if (!chatElement || !this.started || this.getCurrentChatId?.() == null) return;

        const expectedLastId = this.chat.length - 1;
        const cancelByUser = () => this.cancelInitialBottom();
        const cancelEvents = ['touchstart', 'pointerdown', 'wheel', 'click'];
        for (const type of cancelEvents) chatElement.addEventListener(type, cancelByUser, { passive: true, once: true });
        this.bottomSettleCleanup = () => {
            for (const type of cancelEvents) chatElement.removeEventListener(type, cancelByUser);
        };

        const schedule = (callback, delay) => {
            const timer = setTimeout(() => {
                this.bottomSettleTimers.delete(timer);
                callback();
            }, delay);
            this.bottomSettleTimers.add(timer);
        };
        const snapToBottom = () => {
            if (!this.started || this.chatElement !== chatElement) return;
            if (!hasRenderedChatTail(chatElement, expectedLastId)) return;
            this.refreshSwipeButtons?.(true, false);
            // Keep the settling frame fully owned here so a queued native rAF cannot
            // fire after MORE_MESSAGES_LOADED has cancelled the initial auto-scroll.
            this.scrollToBottom?.({ waitForFrame: false });
            chatElement.scrollTo?.(0, chatElement.scrollHeight);
        };

        for (const delay of [0, 80, 220, 500, 900]) schedule(snapToBottom, delay);
        schedule(() => this.cancelInitialBottom(), 1100);
    }

    async installHighlighter(generation = this.generation) {
        try {
            const library = await import('../../../../../lib.js');
            if (!this.started || generation !== this.generation) return;
            const hljs = library.hljs;
            if (!hljs || this.highlightWrappers.size > 0) return;
            const originalHighlight = typeof hljs.highlightElement === 'function'
                ? hljs.highlightElement
                : hljs.highlightBlock;
            if (typeof originalHighlight !== 'function') return;
            this.highlightLibrary = hljs;
            this.originalHighlight = originalHighlight;
            for (const name of ['highlightElement', 'highlightBlock']) {
                const original = hljs[name];
                if (typeof original !== 'function') continue;
                const wrapper = element => {
                    if (!(element instanceof Element) || !element.closest('#chat') || !this.started) {
                        return original.call(hljs, element);
                    }
                    this.queueHighlight(element);
                    return undefined;
                };
                this.originalHighlights.set(name, original);
                this.highlightWrappers.set(name, wrapper);
                hljs[name] = wrapper;
            }
            if (typeof hljs.highlightAll === 'function') {
                const original = hljs.highlightAll;
                const wrapper = (...args) => {
                    if (!this.started) return original.apply(hljs, args);
                    if (this.isGenerating?.()) return undefined;
                    const temporaryMarks = [];
                    document.querySelectorAll(CODE_SELECTOR).forEach(element => {
                        this.queueHighlight(element);
                        if (!element.hasAttribute('data-highlighted')) {
                            element.dataset.highlighted = 'yes';
                            temporaryMarks.push(element);
                        }
                    });
                    try {
                        return original.apply(hljs, args);
                    } finally {
                        temporaryMarks.forEach(element => {
                            if (element.dataset.claHighlighted !== '1') delete element.dataset.highlighted;
                        });
                    }
                };
                this.originalHighlights.set('highlightAll', original);
                this.highlightWrappers.set('highlightAll', wrapper);
                hljs.highlightAll = wrapper;
            }
            this.highlightObserver = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    this.highlightObserver.unobserve(entry.target);
                    this.queueHighlight(entry.target, true);
                }
            }, { root: this.chatElement, rootMargin: '180px 0px' });
            this.queueCodeScan(0);
        } catch (error) {
            console.debug(LOG_PREFIX, '代码延迟高亮不可用', error);
        }
    }

    queueHighlight(element, force = false) {
        if (!this.started || element.dataset.claHighlighted === '1' || !this.originalHighlight) return;
        if (this.isGenerating?.()) {
            element.dataset.claHighlightPending = '1';
            return;
        }
        const messages = [...document.querySelectorAll('#chat .mes')];
        const recent = messages.slice(-3).includes(element.closest('.mes'));
        if (isHeavyHtmlCode(element)) {
            if (!recent) this.collapseOldCode(element);
            element.dataset.claHighlighted = '1';
            element.dataset.claHeavyHtml = '1';
            element.dataset.highlighted = 'yes';
            delete element.dataset.claHighlightPending;
            this.highlightObserver?.unobserve(element);
            return;
        }
        if (!recent) this.collapseOldCode(element);
        if (!force && !recent && !isVisible(element, this.chatElement)) {
            element.dataset.claHighlightPending = '1';
            this.highlightObserver?.observe(element);
            return;
        }
        void this.scheduler.schedule(async () => {
            if (!element.isConnected || element.dataset.claHighlighted === '1') return;
            if (this.isGenerating?.()) {
                element.dataset.claHighlightPending = '1';
                return;
            }
            this.originalHighlight.call(this.highlightLibrary, element);
            element.dataset.claHighlighted = '1';
            delete element.dataset.claHighlightPending;
            const message = element.closest('.mes');
            if (message) {
                const api = await import('../../../../../script.js');
                message.querySelectorAll('.code-copy').forEach(button => button.remove());
                api.addCopyToCodeBlocks?.(message);
            }
        }, { priority: recent ? 1 : 3 }).catch(error => {
            if (error?.name !== 'AbortError') console.debug(LOG_PREFIX, '延迟高亮失败', error);
        });
    }

    collapseOldCode(element) {
        const pre = element.closest('pre');
        if (!pre || pre.dataset.claCollapsible === '1') return;
        pre.dataset.claCollapsible = '1';
        pre.classList.add('cla-code-collapsed');
        pre.addEventListener('click', () => {
            pre.classList.remove('cla-code-collapsed');
            this.queueHighlight(element, true);
        }, { once: true });
    }

    observeCodeBlocks() {
        if (!this.highlightLibrary || !this.started || this.isGenerating?.()) return;
        document.querySelectorAll(CODE_SELECTOR).forEach(element => this.queueHighlight(element));
    }

    installSwipeGuard() {
        this.onTouchStart = event => {
            const touch = event.touches?.[0];
            if (!touch || !event.target.closest?.('#chat .mes')) return;
            this.touchState = { x: touch.clientX, y: touch.clientY, axis: 'pending' };
        };
        this.onTouchMove = event => {
            if (!this.touchState) return;
            const touch = event.touches?.[0];
            if (!touch) return;
            this.touchState.axis = detectSwipeAxis({
                deltaX: touch.clientX - this.touchState.x,
                deltaY: touch.clientY - this.touchState.y,
            });
        };
        this.onTouchEnd = () => {
            if (this.touchState?.axis === 'vertical') this.swipeSuppressUntil = performance.now() + 220;
            this.touchState = null;
        };
        this.onSwipeClick = event => {
            if (performance.now() > this.swipeSuppressUntil) return;
            if (event.target instanceof Element && event.target.closest('.swipe_left, .swipe_right')) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        };
        document.addEventListener('touchstart', this.onTouchStart, { passive: true, capture: true });
        document.addEventListener('touchmove', this.onTouchMove, { passive: true, capture: true });
        document.addEventListener('touchend', this.onTouchEnd, { passive: true, capture: true });
        document.addEventListener('touchcancel', this.onTouchEnd, { passive: true, capture: true });
        document.addEventListener('click', this.onSwipeClick, true);
    }

    async stop() {
        if (!this.started) return;
        this.started = false;
        this.generation += 1;
        this.cancelInitialBottom();
        this.cancelHistoryAnchor();
        this.activeChatKey = null;
        for (const [name, handler] of this.eventHandlers) this.eventSource.removeListener(name, handler);
        this.eventHandlers = [];
        this.chatElement = null;
        this.domObserver?.disconnect();
        this.domObserver = null;
        this.pauseCodeScanning();
        clearTimeout(this.generationEndTimer);
        this.generationEndTimer = null;
        this.highlightObserver?.disconnect();
        if (this.highlightLibrary) {
            for (const [name, wrapper] of this.highlightWrappers) {
                if (this.highlightLibrary[name] === wrapper) this.highlightLibrary[name] = this.originalHighlights.get(name);
            }
        }
        this.highlightLibrary = null;
        this.originalHighlight = null;
        this.originalHighlights.clear();
        this.highlightWrappers.clear();
        document.querySelectorAll('[data-cla-collapsible]').forEach(element => {
            element.classList.remove('cla-code-collapsed');
            delete element.dataset.claCollapsible;
        });
        document.querySelectorAll('[data-cla-heavy-html]').forEach(element => {
            delete element.dataset.claHighlighted;
            delete element.dataset.claHeavyHtml;
            delete element.dataset.highlighted;
        });
        document.removeEventListener('touchstart', this.onTouchStart, true);
        document.removeEventListener('touchmove', this.onTouchMove, true);
        document.removeEventListener('touchend', this.onTouchEnd, true);
        document.removeEventListener('touchcancel', this.onTouchEnd, true);
        document.removeEventListener('click', this.onSwipeClick, true);
        document.removeEventListener('pointerdown', this.onHistoryPointerDown, true);
        document.removeEventListener('click', this.onHistoryClick, true);
        document.removeEventListener('wheel', this.onHistoryUserInput, true);
        document.removeEventListener('keydown', this.onHistoryUserInput, true);
        if (this.powerUser && Number.isFinite(this.originalTruncation)) {
            this.powerUser.chat_truncation = this.originalTruncation;
            this.saveSettings?.();
        }
        localStorage.removeItem(ORIGINAL_TRUNCATION_KEY);
        this.powerUser = null;
        this.originalTruncation = null;
        this.heavyHtmlMode = false;
        this.pendingMetrics = null;
    }
}

export function isHeavyHtmlCodeText({ text = '' } = {}) {
    if (typeof text !== 'string') return false;
    const fullDocument = /<!doctype\s+html\b/i.test(text) || /<html\b/i.test(text);
    const hasPageParts = /<style\b/i.test(text) || /<script\b/i.test(text) || /<head\b/i.test(text);
    return fullDocument && (hasPageParts || text.length >= 2500);
}

function isHeavyHtmlCode(element) {
    if (!(element instanceof Element)) return false;
    return isHeavyHtmlCodeText({
        text: element.textContent || '',
    });
}
