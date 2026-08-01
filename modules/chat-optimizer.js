import {
    chooseAdaptiveChatLimit,
    detectSwipeAxis,
    estimateRenderComplexity,
    getAdaptiveBatchSize,
    measureChatPayload,
    selectLiveMessageIndexes,
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

export class ChatOptimizer {
    constructor({ eventSource, eventTypes, chat = [], isGenerating = () => false, scheduler, saveSettings, onStatus = null }) {
        this.eventSource = eventSource;
        this.eventTypes = eventTypes;
        this.chat = chat;
        this.isGenerating = isGenerating;
        this.scheduler = scheduler;
        this.saveSettings = saveSettings;
        this.onStatus = onStatus;
        this.started = false;
        this.powerUser = null;
        this.originalTruncation = null;
        this.chatElement = null;
        this.domObserver = null;
        this.eventHandlers = [];
        this.autoLoadRunning = false;
        this.lastAutoLoadAt = 0;
        this.highlightLibrary = null;
        this.originalHighlight = null;
        this.highlightWrapper = null;
        this.highlightObserver = null;
        this.touchState = null;
        this.swipeSuppressUntil = 0;
        this.heavyHtmlMode = false;
        this.renderOptimizationActive = false;
        this.pendingMetrics = null;
        this.generation = 0;
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
        this.bind(this.eventTypes.CHAT_CHANGED, () => {
            this.inspectPayload(this.chat);
            this.refreshChatBindings();
        });
        this.bind(this.eventTypes.MORE_MESSAGES_LOADED, () => this.refreshRenderState());
        this.refreshChatBindings();
        await this.installHighlighter(generation);
        if (!this.started || generation !== this.generation) return;
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
        this.chatElement?.removeEventListener('scroll', this.onScroll);
        this.chatElement?.removeEventListener('click', this.onHistoryClick, true);
        this.domObserver?.disconnect();
        this.chatElement = document.querySelector('#chat');
        if (!this.chatElement || !this.started) return;
        this.onScroll ||= () => {
            if (this.scrollFrame) return;
            this.scrollFrame = requestAnimationFrame(() => {
                this.scrollFrame = null;
                this.refreshLiveMessages();
                void this.maybeLoadEarlier();
            });
        };
        this.onHistoryClick ||= event => {
            const button = event.target instanceof Element ? event.target.closest('#show_more_messages') : null;
            if (!button || !this.started) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            void this.loadEarlier(this.chooseLoadBatch());
        };
        this.chatElement.addEventListener('scroll', this.onScroll, { passive: true });
        this.chatElement.addEventListener('click', this.onHistoryClick, true);
        this.domObserver = new MutationObserver(() => {
            this.refreshRenderState();
            this.observeCodeBlocks();
        });
        this.domObserver.observe(this.chatElement, { childList: true, subtree: true });
        this.refreshRenderState();
        this.observeCodeBlocks();
    }

    getComplexity() {
        const chat = this.chatElement;
        if (!chat) return 0;
        return estimateRenderComplexity({
            domNodes: chat.querySelectorAll('*').length,
            htmlLength: chat.innerHTML.length,
            richElements: chat.querySelectorAll('details, table, pre, svg, iframe').length,
        });
    }

    chooseLoadBatch() {
        const constrained = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
        return this.heavyHtmlMode || constrained || this.getComplexity() >= 900 ? 2 : 4;
    }

    refreshRenderState() {
        const messages = this.chatElement ? [...this.chatElement.querySelectorAll('.mes')] : [];
        const active = this.started && (this.heavyHtmlMode || messages.length >= 20 || this.getComplexity() >= 900);
        this.renderOptimizationActive = active;
        document.body?.classList.toggle('cla-chat-optimized', active);
        if (!active) {
            for (const message of messages) message.classList.remove('cla-render-live');
            return;
        }

        this.refreshLiveMessages(messages);
    }

    refreshLiveMessages(messages = this.chatElement ? [...this.chatElement.querySelectorAll('.mes')] : []) {
        if (!this.renderOptimizationActive) return;
        for (const message of messages) message.classList.remove('cla-render-live');
        const indexes = selectLiveMessageIndexes(
            messages.map(message => isVisible(message, this.chatElement)),
            { generating: Boolean(this.isGenerating?.()) },
        );
        indexes.forEach(index => messages[index]?.classList.add('cla-render-live'));
    }

    async maybeLoadEarlier() {
        if (!this.chatElement || this.autoLoadRunning || this.chatElement.scrollTop > 160) return;
        if (performance.now() - this.lastAutoLoadAt < 700) return;
        const firstId = Number(this.chatElement.querySelector('.mes[mesid]')?.getAttribute('mesid'));
        if (!Number.isInteger(firstId) || firstId <= 0) return;
        await this.loadEarlier(this.chooseLoadBatch());
    }

    getAnchor() {
        if (!this.chatElement) return null;
        const rootRect = this.chatElement.getBoundingClientRect();
        const element = [...this.chatElement.querySelectorAll('.mes[mesid]')]
            .find(message => message.getBoundingClientRect().bottom >= rootRect.top);
        const messageId = Number(element?.getAttribute('mesid'));
        return element && Number.isInteger(messageId)
            ? { messageId, top: element.getBoundingClientRect().top }
            : null;
    }

    async loadEarlier(requestedCount) {
        if (this.autoLoadRunning) return { completed: 0 };
        const firstId = Number(this.chatElement?.querySelector('.mes[mesid]')?.getAttribute('mesid'));
        if (!Number.isInteger(firstId) || firstId <= 0) return { completed: 0 };
        this.autoLoadRunning = true;
        this.lastAutoLoadAt = performance.now();
        let completed = 0;
        let batch = 2;
        let previousFrameMs = 0;
        try {
            const api = await import('../../../../../script.js');
            if (typeof api.showMoreMessages !== 'function') throw new Error('官方显示更多接口不可用');
            const total = Math.min(firstId, Math.max(1, requestedCount));
            while (completed < total && this.started) {
                const anchor = this.getAnchor();
                const count = Math.min(batch, total - completed);
                const startedAt = performance.now();
                await api.showMoreMessages(count);
                await this.scheduler.yield(1);
                if (anchor) {
                    const anchorElement = this.chatElement?.querySelector(`.mes[mesid="${anchor.messageId}"]`);
                    if (anchorElement) this.chatElement.scrollTop += anchorElement.getBoundingClientRect().top - anchor.top;
                }
                completed += count;
                previousFrameMs = performance.now() - startedAt;
                batch = Math.min(3, getAdaptiveBatchSize({
                    complexity: this.getComplexity(),
                    previousFrameMs,
                    currentBatch: batch,
                }));
            }
            return { completed };
        } finally {
            this.autoLoadRunning = false;
        }
    }

    async installHighlighter(generation = this.generation) {
        try {
            const library = await import('../../../../../lib.js');
            if (!this.started || generation !== this.generation) return;
            const hljs = library.hljs;
            if (!hljs?.highlightElement || this.highlightWrapper) return;
            this.highlightLibrary = hljs;
            this.originalHighlight = hljs.highlightElement;
            this.highlightWrapper = element => {
                if (!(element instanceof Element) || !element.closest('#chat') || !this.started) {
                    return this.originalHighlight.call(hljs, element);
                }
                this.queueHighlight(element);
                return undefined;
            };
            hljs.highlightElement = this.highlightWrapper;
            this.highlightObserver = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    this.highlightObserver.unobserve(entry.target);
                    this.queueHighlight(entry.target, true);
                }
            }, { root: this.chatElement, rootMargin: '180px 0px' });
            this.observeCodeBlocks();
        } catch (error) {
            console.debug(LOG_PREFIX, '代码延迟高亮不可用', error);
        }
    }

    queueHighlight(element, force = false) {
        if (!this.started || element.dataset.claHighlighted === '1' || !this.originalHighlight) return;
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
        if (!this.highlightLibrary || !this.started) return;
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
        for (const [name, handler] of this.eventHandlers) this.eventSource.removeListener(name, handler);
        this.eventHandlers = [];
        this.chatElement?.removeEventListener('scroll', this.onScroll);
        this.chatElement?.removeEventListener('click', this.onHistoryClick, true);
        this.chatElement = null;
        this.domObserver?.disconnect();
        this.domObserver = null;
        if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
        this.scrollFrame = null;
        document.body?.classList.remove('cla-chat-optimized');
        this.renderOptimizationActive = false;
        document.querySelectorAll('.cla-render-live').forEach(element => element.classList.remove('cla-render-live'));
        this.highlightObserver?.disconnect();
        if (this.highlightLibrary && this.highlightWrapper && this.highlightLibrary.highlightElement === this.highlightWrapper) {
            this.highlightLibrary.highlightElement = this.originalHighlight;
        }
        this.highlightLibrary = null;
        this.highlightWrapper = null;
        this.originalHighlight = null;
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

export function isHeavyHtmlCodeText({ text = '', classNames = [] } = {}) {
    if (typeof text !== 'string' || text.length < 4000) return false;
    const classes = new Set(Array.from(classNames, value => String(value).toLowerCase()));
    const declaredHtml = classes.has('language-html') || classes.has('lang-html');
    const fullDocument = /<!doctype\s+html\b/i.test(text) || /<html\b/i.test(text);
    return declaredHtml && fullDocument;
}

function isHeavyHtmlCode(element) {
    if (!(element instanceof Element)) return false;
    const pre = element.closest('pre');
    return isHeavyHtmlCodeText({
        text: element.textContent || '',
        classNames: [...element.classList, ...(pre?.classList || [])],
    });
}
