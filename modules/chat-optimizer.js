import {
    CHAT_PAGE_SIZE,
    normalizeChatPageSize,
    detectSwipeAxis,
} from '../client-core.js';

const CODE_SELECTOR = '.mes pre code';
const LOG_PREFIX = '[Cloud Lounge Accelerator]';
const ORIGINAL_TRUNCATION_KEY = 'cloud-lounge-accelerator:original-chat-truncation';
const MAX_HIGHLIGHT_CHARS = 20000;

function isRecentCode(element) {
    const message = element.closest('.mes');
    if (!message) return false;
    let newer = 0;
    for (let sibling = message.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
        if (sibling.matches('.mes') && ++newer === 3) return false;
    }
    return true;
}

function getRenderedChatTail(chatElement, expectedLastId) {
    if (!chatElement || !Number.isInteger(expectedLastId) || expectedLastId < 0) return null;
    let lastMessage = chatElement.lastElementChild;
    while (lastMessage && !lastMessage.matches('.mes[mesid]')) lastMessage = lastMessage.previousElementSibling;
    return Number(lastMessage?.getAttribute?.('mesid')) === expectedLastId ? lastMessage : null;
}

export function hasRenderedChatTail(chatElement, expectedLastId) {
    return Boolean(getRenderedChatTail(chatElement, expectedLastId));
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
        importChatApi = () => import('../../../../../script.js'),
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
        this.importChatApi = importChatApi;
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
        this.queuedHighlights = new WeakSet();
        this.highlightJobs = null;
        this.deferredHighlights = new Map();
        this.addedCodeRoots = new Set();
        this.observedHighlights = new Set();
        this.collapseHandlers = new WeakMap();
        this.scanAllCode = false;
        this.codeObservationStarted = false;
        this.highlightPointerId = null;
        this.highlightObserver = null;
        this.codeScanJob = null;
        this.generationEndTimer = null;
        this.touchState = null;
        this.swipeSuppressUntil = 0;
        this.chatPageSize = CHAT_PAGE_SIZE;
        this.generation = 0;
        this.bottomSettleTimers = new Set();
        this.bottomSettleCleanup = null;
        this.activeChatKey = null;
        this.historyAnchor = null;
        this.historyAnchorFrame = null;
        this.historyAnchorTimers = new Set();
    }

    async start({ legacyTruncation = null, chatPageSize = this.chatPageSize } = {}) {
        this.setPageSize(chatPageSize);
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
            this.powerUser.chat_truncation = this.chatPageSize;
        } catch (error) {
            console.debug(LOG_PREFIX, '官方聊天截断接口不可用', error);
        }
        if (!this.started || generation !== this.generation) return;
        this.bind(this.eventTypes.CHAT_CHANGED, () => this.handleChatChanged());
        this.bind(this.eventTypes.MORE_MESSAGES_LOADED, () => this.handleMoreMessagesLoaded());
        this.refreshChatBindings();
        this.installHistoryAnchorGuard();
        this.installSwipeGuard();
        await this.installHighlighter(generation);
    }

    startCodeObservation() {
        if (!this.started || this.codeObservationStarted) return;
        this.codeObservationStarted = true;
        this.bind(this.eventTypes.GENERATION_STARTED, () => this.pauseCodeScanning());
        this.bind(this.eventTypes.GENERATION_STOPPED, () => this.refreshAfterGeneration());
        this.bind(this.eventTypes.GENERATION_ENDED, () => this.refreshAfterGeneration());
        this.refreshChatBindings(true);
        this.onStatus?.('chat', '自动');
    }

    bind(name, handler) {
        if (!name) return;
        this.eventSource.on(name, handler);
        this.eventHandlers.push([name, handler]);
    }

    setPageSize(value) {
        this.chatPageSize = normalizeChatPageSize(value);
        if (this.powerUser && this.started) this.powerUser.chat_truncation = this.chatPageSize;
        return this.chatPageSize;
    }

    refreshChatBindings(rescan = false) {
        const chatElement = document.querySelector('#chat');
        if (this.chatElement !== chatElement) {
            this.pauseCodeScanning();
            this.chatElement = chatElement;
            rescan = true;
        }
        if (!rescan || !this.chatElement || !this.codeObservationStarted || !this.originalHighlight) return;
        this.domObserver ??= new MutationObserver(records => this.collectAddedCode(records));
        this.resumeCodeObservation();
        this.queueCodeScan(true);
    }

    collectAddedCode(records) {
        if (this.isGenerating?.()) return;
        let removedElements = false;
        for (const { target, addedNodes, removedNodes } of records) {
            // Native copy icons and the highlighter's spans are inside code.
            if (target.closest?.('code')) continue;
            if (!this.scanAllCode && !this.addedCodeRoots.has(target)) {
                for (const node of addedNodes) {
                    if (node.nodeType === 1) this.addedCodeRoots.add(node);
                }
            }
            removedElements ||= removedNodes.length > 0;
        }
        if (removedElements) {
            for (const element of this.observedHighlights) {
                if (this.chatElement?.contains(element)) continue;
                this.highlightObserver?.unobserve(element);
                this.observedHighlights.delete(element);
            }
            for (const element of this.deferredHighlights.keys()) {
                if (!this.chatElement?.contains(element)) this.deferredHighlights.delete(element);
            }
        }
        this.queueCodeScan();
    }

    pauseCodeScanning() {
        this.domObserver?.disconnect();
        this.highlightJobs?.abort();
        this.highlightJobs = null;
        this.queuedHighlights = new WeakSet();
        this.highlightObserver?.disconnect();
        this.highlightObserver = null;
        this.observedHighlights.clear();
        this.deferredHighlights.clear();
        this.addedCodeRoots.clear();
        this.scanAllCode = false;
        this.codeScanJob?.abort();
        this.codeScanJob = null;
    }

    resumeCodeObservation() {
        if (this.chatElement && this.started && !this.isGenerating?.()) {
            this.domObserver?.observe(this.chatElement, { childList: true, subtree: true });
        }
    }

    deferHighlight(element, force = false) {
        this.deferredHighlights.set(element, force || this.deferredHighlights.get(element) === true);
    }

    highlightBlocked() {
        return this.highlightPointerId !== null || this.hasActiveChatSelection();
    }

    queueCodeScan(scanAll = false) {
        if (!this.codeObservationStarted || this.isGenerating?.()) return;
        this.scanAllCode ||= scanAll;
        if (this.codeScanJob) return;
        if (!this.scanAllCode && !this.deferredHighlights.size && !this.addedCodeRoots.size) return;
        if (this.highlightBlocked()) return;
        const job = this.codeScanJob = new AbortController();
        void this.scheduler.schedule(deadline => {
            if (this.isGenerating?.() || this.highlightBlocked()) return;
            this.observeCodeBlocks(deadline);
        }, { priority: 3, signal: job.signal }).catch(error => {
            if (error?.name !== 'AbortError') console.debug(LOG_PREFIX, '代码块扫描失败', error);
        }).finally(() => {
            if (this.codeScanJob !== job) return;
            this.codeScanJob = null;
            this.queueCodeScan();
        });
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
            this.refreshChatBindings(true);
        };
        waitForUnlock();
    }

    handleChatChanged() {
        if (this.powerUser) this.powerUser.chat_truncation = this.chatPageSize;
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
            if (event.target?.closest?.('#chat') && event.button <= 0 && event.isPrimary !== false) {
                this.highlightPointerId = event.pointerId;
            }
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
        this.onCodePointerEnd = event => {
            if (this.highlightPointerId === null || event.pointerId !== this.highlightPointerId) return;
            this.highlightPointerId = null;
            this.queueCodeScan();
        };
        this.onCodeSelectionChange = () => this.queueCodeScan();
        this.onCodeVisibilityChange = () => {
            this.highlightPointerId = null;
            if (!document.hidden) this.queueCodeScan();
        };
        document.addEventListener('pointerdown', this.onHistoryPointerDown, true);
        document.addEventListener('click', this.onHistoryClick, true);
        document.addEventListener('wheel', this.onHistoryUserInput, { passive: true, capture: true });
        document.addEventListener('keydown', this.onHistoryUserInput, true);
        document.addEventListener('pointerup', this.onCodePointerEnd, true);
        document.addEventListener('pointercancel', this.onCodePointerEnd, true);
        document.addEventListener('selectionchange', this.onCodeSelectionChange);
        document.addEventListener('visibilitychange', this.onCodeVisibilityChange);
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
        let swipeTail = null;
        const snapToBottom = () => {
            if (!this.started || this.chatElement !== chatElement) return;
            const tail = getRenderedChatTail(chatElement, expectedLastId);
            if (!tail) return;
            if (swipeTail !== tail) {
                this.refreshSwipeButtons?.(true, false);
                swipeTail = tail;
            }
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
                    if (!this.isGenerating?.() && !element.dataset.claHighlighted
                        && !this.queuedHighlights.has(element) && !this.observedHighlights.has(element)) {
                        this.deferHighlight(element);
                        this.queueCodeScan();
                    }
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
                    this.chatElement?.querySelectorAll(CODE_SELECTOR).forEach(element => {
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
        } catch (error) {
            console.debug(LOG_PREFIX, '代码延迟高亮不可用', error);
        }
    }

    queueHighlight(element, force = false) {
        if (!this.started || element.dataset.claHighlighted === '1' || !this.originalHighlight
            || this.queuedHighlights.has(element)) return;
        // Streaming can replace these nodes on the next chunk. Rediscover
        // only the surviving markup once generation has finished.
        if (this.isGenerating?.()) return;
        if (this.highlightBlocked()) {
            this.deferHighlight(element, force);
            return;
        }
        this.deferredHighlights.delete(element);
        if (this.observedHighlights.has(element) && !force) return;
        const recent = isRecentCode(element);
        if (!recent) this.collapseOldCode(element);
        if (!force && !recent && typeof IntersectionObserver === 'function') {
            this.highlightObserver ??= new IntersectionObserver((entries, observer) => {
                if (this.highlightObserver !== observer) return;
                for (const { target, isIntersecting } of entries) {
                    if (!isIntersecting || !this.observedHighlights.delete(target)) continue;
                    observer.unobserve(target);
                    if (this.chatElement?.contains(target)) this.queueHighlight(target, true);
                }
            }, { root: this.chatElement, rootMargin: '180px 0px' });
            this.observedHighlights.add(element);
            this.highlightObserver.observe(element);
            return;
        }
        if (this.observedHighlights.delete(element)) this.highlightObserver?.unobserve(element);
        const queued = this.queuedHighlights;
        queued.add(element);
        this.highlightJobs ??= new AbortController();
        const { signal } = this.highlightJobs;
        void this.scheduler.schedule(async () => {
            if (signal.aborted) return;
            if (!element.isConnected || !this.chatElement?.contains(element) || element.dataset.claHighlighted === '1') return;
            if (this.isGenerating?.()) return;
            if (this.highlightBlocked()) {
                this.deferHighlight(element, true);
                return;
            }
            if (!element.hasAttribute('data-highlighted')) {
                const text = element.textContent || '';
                if (text.length > MAX_HIGHLIGHT_CHARS || isHeavyHtmlCodeText({ text })) {
                    element.dataset.claHighlighted = '1';
                    element.dataset.claHeavyHtml = '1';
                    element.dataset.highlighted = 'yes';
                    return;
                }
                const copyButtons = element.querySelectorAll('.code-copy');
                try {
                    this.originalHighlight.call(this.highlightLibrary, element);
                } finally {
                    // highlight.js replaces innerHTML. Restore the same native
                    // button nodes and handlers instead of recreating them.
                    for (const button of copyButtons) {
                        if (!element.contains(button)) element.appendChild(button);
                    }
                }
            }
            element.dataset.claHighlighted = '1';
            const pre = element.closest('pre');
            if (pre && !element.querySelector('.code-copy')) {
                const api = await this.importChatApi();
                if (signal.aborted || !this.chatElement?.contains(element) || this.isGenerating?.()) return;
                // The native helper highlights and adds buttons to every block
                // it receives. Scope it to this one pre; never remove or replace
                // sibling copy buttons that may currently have focus/capture.
                if (!element.querySelector('.code-copy')) api.addCopyToCodeBlocks?.(pre);
            }
        }, { priority: force || recent ? 1 : 3, signal }).catch(error => {
            if (error?.name !== 'AbortError') console.debug(LOG_PREFIX, '延迟高亮失败', error);
        }).finally(() => queued.delete(element));
    }

    hasActiveChatSelection() {
        const selection = document.getSelection?.();
        return Boolean(selection && !selection.isCollapsed && this.chatElement?.contains?.(selection.anchorNode));
    }

    collapseOldCode(element) {
        const pre = element.closest('pre');
        if (!pre || pre.dataset.claCollapsible === '1') return;
        pre.dataset.claCollapsible = '1';
        pre.classList.add('cla-code-collapsed');
        const expand = () => {
            this.collapseHandlers.delete(pre);
            if (!this.started || !this.chatElement?.contains(element)) return;
            pre.classList.remove('cla-code-collapsed');
            this.queueHighlight(element, true);
        };
        this.collapseHandlers.set(pre, expand);
        pre.addEventListener('click', expand, { once: true });
    }

    observeCodeBlocks(deadline) {
        if (this.scanAllCode) {
            this.scanAllCode = false;
            this.addedCodeRoots.clear();
            for (let node = this.chatElement?.lastElementChild; node; node = node.previousElementSibling) {
                this.addedCodeRoots.add(node);
            }
        }
        for (const [element, force] of this.deferredHighlights) {
            if (performance.now() >= deadline) return;
            this.deferredHighlights.delete(element);
            if (this.chatElement?.contains(element)) this.queueHighlight(element, force);
        }
        for (const node of this.addedCodeRoots) {
            if (performance.now() >= deadline) break;
            this.addedCodeRoots.delete(node);
            if (!this.chatElement?.contains(node)) continue;
            if (node.matches(CODE_SELECTOR) && !node.dataset.claHighlighted) this.deferHighlight(node);
            for (const code of node.querySelectorAll(CODE_SELECTOR)) {
                if (!code.dataset.claHighlighted) this.deferHighlight(code);
            }
        }
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
        this.codeObservationStarted = false;
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
        if (this.highlightLibrary) {
            for (const [name, wrapper] of this.highlightWrappers) {
                if (this.highlightLibrary[name] === wrapper) this.highlightLibrary[name] = this.originalHighlights.get(name);
            }
        }
        this.highlightLibrary = null;
        this.originalHighlight = null;
        this.originalHighlights.clear();
        this.highlightWrappers.clear();
        this.highlightPointerId = null;
        document.querySelectorAll('[data-cla-collapsible]').forEach(element => {
            const handler = this.collapseHandlers.get(element);
            if (handler) element.removeEventListener('click', handler);
            element.classList.remove('cla-code-collapsed');
            delete element.dataset.claCollapsible;
        });
        this.collapseHandlers = new WeakMap();
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
        document.removeEventListener('pointerup', this.onCodePointerEnd, true);
        document.removeEventListener('pointercancel', this.onCodePointerEnd, true);
        document.removeEventListener('selectionchange', this.onCodeSelectionChange);
        document.removeEventListener('visibilitychange', this.onCodeVisibilityChange);
        if (this.powerUser && Number.isFinite(this.originalTruncation)) {
            this.powerUser.chat_truncation = this.originalTruncation;
            this.saveSettings?.();
        }
        localStorage.removeItem(ORIGINAL_TRUNCATION_KEY);
        this.powerUser = null;
        this.originalTruncation = null;
    }
}

export function isHeavyHtmlCodeText({ text = '' } = {}) {
    if (typeof text !== 'string') return false;
    return /<(?:!doctype\s+html|html)\b/i.test(text)
        && (text.length >= 2500 || /<(?:style|script|head)\b/i.test(text));
}
