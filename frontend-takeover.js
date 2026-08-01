import {
    chooseAdaptiveChatLimit,
    classifyTakeoverRequest,
    detectSwipeAxis,
    measureChatPayload,
} from './client-core.js';

const LOG_PREFIX = '[Cloud Lounge Accelerator Takeover]';
const FETCH_TTL_MS = 20000;
const RICH_CODE_SELECTOR = '#chat .mes pre code';

function safeClone(response) {
    try {
        return response.clone();
    } catch {
        return response;
    }
}

function serializeHeaders(headers) {
    try {
        return [...new Headers(headers || {}).entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, value]) => `${name}:${value}`)
            .join('|');
    } catch {
        return '';
    }
}

function getRequestDescriptor(input, init = {}) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const url = new URL(isRequest ? input.url : String(input), location.href);
    const method = String(init.method || (isRequest ? input.method : 'GET')).toUpperCase();
    const body = init.body;
    const serializableBody = body == null || typeof body === 'string' || body instanceof URLSearchParams;
    return {
        url,
        method,
        body: body == null ? '' : String(body),
        headers: init.headers || (isRequest ? input.headers : undefined),
        credentials: init.credentials || (isRequest ? input.credentials : ''),
        cache: init.cache || (isRequest ? input.cache : ''),
        mode: init.mode || (isRequest ? input.mode : ''),
        redirect: init.redirect || (isRequest ? input.redirect : ''),
        referrer: init.referrer || (isRequest ? input.referrer : ''),
        integrity: init.integrity || (isRequest ? input.integrity : ''),
        reusable: !isRequest && serializableBody && !init.signal,
    };
}

function requestFingerprint(descriptor) {
    return [
        descriptor.method,
        descriptor.url.href,
        descriptor.body,
        serializeHeaders(descriptor.headers),
        descriptor.credentials,
        descriptor.cache,
        descriptor.mode,
        descriptor.redirect,
        descriptor.referrer,
        descriptor.integrity,
    ].join('\n');
}

function isElementVisible(element, root) {
    if (!(element instanceof Element) || !(root instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    return rect.bottom >= rootRect.top && rect.top <= rootRect.bottom;
}

export class FrontendTakeoverController {
    constructor({
        settings,
        scheduler,
        eventSource,
        eventTypes,
        chat,
        refreshRegex,
        loadEarlier,
        reloadChat,
        persistSettings,
        loadSettings,
        onStatus,
    }) {
        this.settings = settings;
        this.scheduler = scheduler;
        this.eventSource = eventSource;
        this.eventTypes = eventTypes;
        this.chat = chat;
        this.refreshRegex = refreshRegex;
        this.loadEarlier = loadEarlier;
        this.reloadChat = reloadChat;
        this.persistSettings = persistSettings;
        this.loadSettings = loadSettings;
        this.onStatus = onStatus;
        this.started = false;
        this.safeMode = new URLSearchParams(location.search).get('cla-safe') === '1';
        this.nativeFetch = null;
        this.fetchWrapper = null;
        this.fetchEntries = new Map();
        this.fetchExpiryTimers = new Set();
        this.eventHandlers = [];
        this.regexObserver = null;
        this.regexCheckTimer = null;
        this.regexRefreshTimer = null;
        this.regexSignature = '';
        this.regexEditorWasOpen = false;
        this.chatElement = null;
        this.scrollQueued = false;
        this.autoLoadRunning = false;
        this.lastAutoLoadAt = 0;
        this.blankWatchdog = null;
        this.originalHighlight = null;
        this.highlightWrapper = null;
        this.highlightObserver = null;
        this.highlightPaused = false;
        this.touchState = null;
        this.swipeSuppressUntil = 0;
        this.earlyBanner = null;
        this.powerUser = null;
        this.originalChatTruncation = null;
        this.adaptiveApplied = false;
        this.errorCount = 0;
        this.tripped = false;
        this.longTaskObserver = null;
        this.uiTakeoversInstalled = false;
    }

    async start() {
        if (this.started) return true;
        if (this.safeMode || !this.settings.takeoverEnabled) {
            this.onStatus?.(this.safeMode ? 'safe' : 'native', this.safeMode ? '本次安全模式：已跳过全局前端接管' : '酒馆原生流程');
            return false;
        }
        this.started = true;
        this.tripped = false;
        this.errorCount = 0;
        this.onStatus?.('starting', '强力前端接管正在启动');
        this.#installFetchCoordinator();
        this.#bindEvents();
        this.#installLongTaskObserver();
        if (document.querySelector('#chat') && !document.querySelector('#loader')) this.#onAppReady();
        this.onStatus?.('active', '强力前端接管已启用');
        return true;
    }

    updateSettings(settings) {
        this.settings = settings;
        this.scheduler.setBudget({ balanced: 8, strong: 10, extreme: 12 }[settings.takeoverIntensity] || 10);
        if (!settings.collapseOldCode) {
            document.querySelectorAll('[data-cla-collapsible]').forEach(element => {
                element.classList.remove('cla-code-collapsed');
                delete element.dataset.claCollapsible;
            });
        } else {
            this.#observePendingCodeBlocks();
        }
        if (this.adaptiveApplied && !settings.adaptiveChatLimit) void this.#restoreAdaptiveLimit();
        if (!settings.takeoverEnabled && this.started) this.stop({ reason: '已恢复酒馆原生流程' });
    }

    setRegexRefreshing(value) {
        this.highlightPaused = value === true;
        if (!this.highlightPaused) this.#observePendingCodeBlocks();
    }

    pauseTasks() {
        this.scheduler.cancelAll('用户暂停了当前前端任务');
        this.onStatus?.('paused', '当前前端任务已暂停；新操作仍可继续');
    }

    async stop({ reason = '酒馆原生流程已恢复', circuit = false } = {}) {
        if (!this.started && !circuit) return;
        this.started = false;
        this.tripped ||= circuit;
        if (circuit) {
            this.settings.takeoverEnabled = false;
            this.persistSettings?.();
        }
        this.scheduler.cancelAll(reason);
        if (this.fetchWrapper && window.fetch === this.fetchWrapper) window.fetch = this.nativeFetch;
        this.fetchEntries.clear();
        for (const timer of this.fetchExpiryTimers) clearTimeout(timer);
        this.fetchExpiryTimers.clear();
        this.fetchWrapper = null;
        this.nativeFetch = null;
        for (const [eventName, handler] of this.eventHandlers) this.eventSource.removeListener(eventName, handler);
        this.eventHandlers = [];
        this.regexObserver?.disconnect();
        this.regexObserver = null;
        if (this.regexInteractionHandler) {
            document.removeEventListener('input', this.regexInteractionHandler, false);
            document.removeEventListener('change', this.regexInteractionHandler, false);
            document.removeEventListener('click', this.regexInteractionHandler, false);
        }
        this.regexInteractionHandler = null;
        this.uiTakeoversInstalled = false;
        clearTimeout(this.regexCheckTimer);
        clearTimeout(this.regexRefreshTimer);
        clearTimeout(this.blankWatchdog);
        this.#removeHistoryListeners();
        this.#removeSwipeGuard();
        this.#restoreHighlighter();
        this.longTaskObserver?.disconnect();
        this.longTaskObserver = null;
        this.#removeEarlyBanner();
        await this.#restoreAdaptiveLimit();
        document.body?.classList.remove('cla-early-ui', 'cla-takeover-active');
        this.onStatus?.(circuit ? 'circuit' : 'native', circuit ? '接管连续异常，已自动熔断并恢复原生流程' : reason);
    }

    recordError(error, context = '') {
        if (error?.name === 'AbortError') return;
        this.errorCount += 1;
        console.error(LOG_PREFIX, context, error);
        this.onStatus?.('warning', `接管异常 ${this.errorCount} / 3${context ? ` · ${context}` : ''}`);
        if (this.errorCount >= 3 && !this.tripped) void this.stop({ circuit: true });
    }

    #bindEvent(eventName, handler) {
        if (!eventName) return;
        this.eventSource.on(eventName, handler);
        this.eventHandlers.push([eventName, handler]);
    }

    #bindEvents() {
        this.#bindEvent(this.eventTypes.SETTINGS_LOADED, () => this.#onSettingsLoaded());
        this.#bindEvent(this.eventTypes.APP_READY, () => this.#onAppReady());
        this.#bindEvent(this.eventTypes.CHAT_CHANGED, () => this.#onChatChanged());
        this.#bindEvent(this.eventTypes.MORE_MESSAGES_LOADED, () => this.#observePendingCodeBlocks());
        for (const name of [
            'CHARACTER_EDITED', 'CHARACTER_DELETED', 'CHARACTER_DUPLICATED', 'CHARACTER_RENAMED',
            'PERSONA_CREATED', 'PERSONA_UPDATED', 'PERSONA_RENAMED', 'PERSONA_DELETED', 'FORCE_SET_BACKGROUND',
        ]) {
            this.#bindEvent(this.eventTypes[name], () => this.#invalidateReusableRequests());
        }
    }

    async #onSettingsLoaded() {
        try {
            const latestSettings = this.loadSettings?.();
            if (latestSettings) this.updateSettings(latestSettings);
            const powerUserModule = await import('../../power-user.js');
            this.powerUser = powerUserModule.power_user;
            this.#applyAdaptiveLimit({ averageTextLength: 1200, richMarkerCount: 3 });
            if (this.settings.requestPrefetch) void this.#prefetchInitializationRequests();
            if (this.settings.earlyUi) await this.#revealEarlyUi();
        } catch (error) {
            this.recordError(error, '设置加载接管');
        }
    }

    #onAppReady() {
        document.body?.classList.add('cla-takeover-active');
        document.body?.classList.remove('cla-early-ui');
        this.#removeEarlyBanner();
        if (!this.uiTakeoversInstalled) {
            this.uiTakeoversInstalled = true;
            this.#installRegexWatcher();
            this.#installSmoothHistoryProxy();
            this.#installSwipeGuard();
            void this.#installChatHighlighter();
        }
        this.#findChatElement();
        this.#observePendingCodeBlocks();
        this.onStatus?.('active', '强力前端接管已就绪');
    }

    #onChatChanged() {
        this.autoLoadRunning = false;
        clearTimeout(this.regexRefreshTimer);
        if (this.settings.regexAutoRefresh) {
            void this.#readRegexSignature().then(signature => { this.regexSignature = signature; }).catch(() => {});
        }
        this.#findChatElement();
        this.#observePendingCodeBlocks();
        clearTimeout(this.blankWatchdog);
        this.blankWatchdog = setTimeout(async () => {
            if (!this.started || !this.chat?.length || document.querySelector('#chat .mes')) return;
            try {
                this.onStatus?.('warning', '检测到聊天区域持续空白，正在退回原生完整读取');
                await this.reloadChat();
            } catch (error) {
                this.recordError(error, '聊天空白恢复');
            }
        }, 8000);
    }

    async #revealEarlyUi() {
        const loaderModule = await import('../../action-loader.js');
        const initHandle = loaderModule.loader.active().find(handle => handle.slug === 'app-init');
        if (!initHandle) return;
        await loaderModule.loader.hide(initHandle);
        document.body?.classList.add('cla-early-ui');
        this.earlyBanner = document.createElement('div');
        this.earlyBanner.className = 'cla-background-init-banner';
        this.earlyBanner.textContent = '酒馆界面已可操作 · 角色、背景和扩展仍在后台初始化';
        document.body.append(this.earlyBanner);
    }

    #removeEarlyBanner() {
        this.earlyBanner?.remove();
        this.earlyBanner = null;
    }

    #installFetchCoordinator() {
        if (this.fetchWrapper) return;
        const nativeFetch = window.fetch.bind(window);
        this.nativeFetch = nativeFetch;
        this.fetchWrapper = async (input, init = {}) => {
            let descriptor;
            try {
                descriptor = getRequestDescriptor(input, init);
            } catch {
                return nativeFetch(input, init);
            }
            const policy = classifyTakeoverRequest({ pathname: descriptor.url.pathname, method: descriptor.method });
            if (policy === 'observe-chat') {
                const response = await nativeFetch(input, init);
                void this.#analyzeChatResponse(safeClone(response));
                return response;
            }
            if (policy === 'invalidate') {
                const response = await nativeFetch(input, init);
                if (response.ok) this.#invalidateReusableRequests();
                return response;
            }
            if (policy !== 'reuse' || !descriptor.reusable || !this.settings.requestPrefetch) {
                return nativeFetch(input, init);
            }

            const key = requestFingerprint(descriptor);
            const now = performance.now();
            const cached = this.fetchEntries.get(key);
            if (cached && cached.expiresAt > now) {
                try {
                    return safeClone(await cached.promise);
                } catch {
                    this.fetchEntries.delete(key);
                    return nativeFetch(input, init);
                }
            }

            const promise = nativeFetch(input, init);
            this.fetchEntries.set(key, { promise, expiresAt: now + FETCH_TTL_MS });
            const expiryTimer = setTimeout(() => {
                if (this.fetchEntries.get(key)?.promise === promise) this.fetchEntries.delete(key);
                this.fetchExpiryTimers.delete(expiryTimer);
            }, FETCH_TTL_MS + 100);
            this.fetchExpiryTimers.add(expiryTimer);
            try {
                const response = await promise;
                if (!response.ok) this.fetchEntries.delete(key);
                return safeClone(response);
            } catch {
                this.fetchEntries.delete(key);
                return nativeFetch(input, init);
            }
        };
        window.fetch = this.fetchWrapper;
    }

    #invalidateReusableRequests() {
        this.fetchEntries.clear();
    }

    async #prefetchInitializationRequests() {
        try {
            const api = await import('../../../../script.js');
            if (typeof api.getRequestHeaders !== 'function') return;
            const requests = [
                ['/api/avatars/get', { method: 'POST', headers: api.getRequestHeaders({ omitContentType: true }) }],
                ['/api/characters/all', { method: 'POST', headers: api.getRequestHeaders(), body: JSON.stringify({}) }],
                ['/api/backgrounds/all', { method: 'POST', headers: api.getRequestHeaders(), body: JSON.stringify({}) }],
            ];
            await Promise.allSettled(requests.map(async ([url, options]) => {
                let timer;
                try {
                    await Promise.race([
                        window.fetch(url, options),
                        new Promise((_, reject) => {
                            timer = setTimeout(() => reject(new DOMException('预取超时', 'TimeoutError')), 4500);
                        }),
                    ]);
                } catch (error) {
                    this.#invalidateReusableRequests();
                    throw error;
                } finally {
                    clearTimeout(timer);
                }
            }));
        } catch (error) {
            console.debug(LOG_PREFIX, '初始化预取已回退原生流程', error);
        }
    }

    async #analyzeChatResponse(response) {
        if (!this.settings.adaptiveChatLimit || !response?.ok) return;
        try {
            const payload = await response.json();
            const messages = Array.isArray(payload) ? payload : (Array.isArray(payload?.chat) ? payload.chat : []);
            this.#applyAdaptiveLimit(measureChatPayload(messages));
        } catch (error) {
            console.debug(LOG_PREFIX, '聊天复杂度预判失败，保留当前截断值', error);
        }
    }

    #applyAdaptiveLimit(metrics) {
        if (!this.powerUser || !this.settings.adaptiveChatLimit) return;
        if (!Number.isFinite(this.originalChatTruncation)) {
            this.originalChatTruncation = Number.isFinite(this.settings.adaptivePreviousChatTruncation)
                ? this.settings.adaptivePreviousChatTruncation
                : (Number.isFinite(this.powerUser.chat_truncation) ? this.powerUser.chat_truncation : 100);
            this.settings.adaptivePreviousChatTruncation = this.originalChatTruncation;
        }
        this.adaptiveApplied = true;
        const limit = chooseAdaptiveChatLimit({
            ...metrics,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory,
            intensity: this.settings.takeoverIntensity,
        });
        this.powerUser.chat_truncation = limit;
        this.settings.longChatLimit = [8, 10, 15, 20, 30].includes(limit) ? limit : (limit <= 10 ? 10 : 15);
        this.persistSettings?.();
    }

    async #restoreAdaptiveLimit() {
        if (!this.powerUser || !Number.isFinite(this.originalChatTruncation)) return;
        this.powerUser.chat_truncation = this.originalChatTruncation;
        this.originalChatTruncation = null;
        this.adaptiveApplied = false;
        this.settings.adaptivePreviousChatTruncation = null;
        this.persistSettings?.();
        try {
            const api = await import('../../../../script.js');
            api.saveSettingsDebounced?.();
        } catch (error) {
            console.debug(LOG_PREFIX, '恢复原聊天截断值失败', error);
        }
    }

    #installRegexWatcher() {
        const onInteraction = event => {
            if (!this.settings.regexAutoRefresh) return;
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest('#regex_test_mode')) return;
            if (target.closest('.regex_editor')) {
                this.regexEditorWasOpen = true;
                return;
            }
            if (target.matches('.disable_regex, .enable_scoped')
                || target.closest('#bulk_enable_regex, #bulk_disable_regex, #bulk_delete_regex, #regex_preset_apply')) {
                this.#queueRegexSignatureCheck();
            }
        };
        document.addEventListener('input', onInteraction, false);
        document.addEventListener('change', onInteraction, false);
        document.addEventListener('click', onInteraction, false);
        this.regexInteractionHandler = onInteraction;

        this.regexObserver = new MutationObserver(() => {
            const editorOpen = Boolean(document.querySelector('.regex_editor'));
            if (this.regexEditorWasOpen && !editorOpen) this.#queueRegexSignatureCheck(350);
            this.regexEditorWasOpen = editorOpen;
        });
        this.regexObserver.observe(document.body, { childList: true, subtree: true });
        void this.#readRegexSignature().then(signature => { this.regexSignature = signature; });
    }

    #queueRegexSignatureCheck(delay = 450) {
        clearTimeout(this.regexCheckTimer);
        this.regexCheckTimer = setTimeout(async () => {
            try {
                const signature = await this.#readRegexSignature();
                if (signature && this.regexSignature && signature !== this.regexSignature) this.#markRegexDirty();
                this.regexSignature = signature;
            } catch (error) {
                this.recordError(error, '正则状态检查');
            }
        }, delay);
    }

    async #readRegexSignature() {
        const engine = await import('../../regex/engine.js');
        const types = Object.values(engine.SCRIPT_TYPES || {});
        return JSON.stringify(types.map(type => (engine.getScriptsByType?.(type) || []).map(script => ({
            id: script.id,
            disabled: script.disabled,
            findRegex: script.findRegex,
            replaceString: script.replaceString,
            placement: script.placement,
            markdownOnly: script.markdownOnly,
            promptOnly: script.promptOnly,
        }))));
    }

    #markRegexDirty() {
        if (!this.settings.regexAutoRefresh) return;
        clearTimeout(this.regexRefreshTimer);
        this.regexRefreshTimer = setTimeout(async () => {
            if (!this.started || document.querySelector('.regex_editor')) {
                this.#markRegexDirty();
                return;
            }
            try {
                await this.scheduler.schedule(() => this.refreshRegex(), { priority: 1 });
            } catch (error) {
                this.recordError(error, '正则合并刷新');
            }
        }, 650);
    }

    #findChatElement() {
        if (this.chatElement) this.#removeHistoryListeners();
        this.chatElement = document.querySelector('#chat');
        if (!this.chatElement || !this.started) return;
        this.chatElement.addEventListener('scroll', this.historyScrollHandler, { passive: true });
        this.chatElement.addEventListener('click', this.historyClickHandler, true);
    }

    #installSmoothHistoryProxy() {
        this.historyScrollHandler = () => {
            if (!this.settings.autoLoadOlder || this.scrollQueued) return;
            this.scrollQueued = true;
            void this.scheduler.schedule(() => {
                this.scrollQueued = false;
                void this.#maybeAutoLoadEarlier();
            }, { priority: 0 }).catch(error => {
                this.scrollQueued = false;
                if (error?.name !== 'AbortError') this.recordError(error, '顶部滚动检测');
            });
        };
        this.historyClickHandler = event => {
            const button = event.target instanceof Element ? event.target.closest('#show_more_messages') : null;
            if (!button || !this.started) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            void this.#runSmoothHistoryLoad(this.settings.autoLoadBatch, true);
        };
        this.#findChatElement();
    }

    #removeHistoryListeners() {
        this.chatElement?.removeEventListener('scroll', this.historyScrollHandler);
        this.chatElement?.removeEventListener('click', this.historyClickHandler, true);
        this.chatElement = null;
    }

    async #maybeAutoLoadEarlier() {
        if (!this.chatElement || this.autoLoadRunning) return;
        if (this.chatElement.scrollTop > this.settings.autoLoadDistance) return;
        if (performance.now() - this.lastAutoLoadAt < this.settings.autoLoadCooldown) return;
        const firstId = Number(this.chatElement.querySelector('.mes[mesid]')?.getAttribute('mesid'));
        if (!Number.isInteger(firstId) || firstId <= 0) return;
        await this.#runSmoothHistoryLoad(this.settings.autoLoadBatch, false);
    }

    async #runSmoothHistoryLoad(count, manual) {
        if (this.autoLoadRunning) return;
        this.autoLoadRunning = true;
        this.lastAutoLoadAt = performance.now();
        try {
            await this.loadEarlier(count, { source: manual ? 'manual-proxy' : 'auto' });
        } catch (error) {
            this.recordError(error, '旧消息分帧补载');
            try {
                const api = await import('../../../../script.js');
                await api.showMoreMessages?.();
            } catch (fallbackError) {
                this.recordError(fallbackError, '原生显示更多回退');
            }
        } finally {
            this.autoLoadRunning = false;
        }
    }

    async #installChatHighlighter() {
        if (!this.settings.deferChatHighlight) return;
        try {
            const library = await import('../../../../lib.js');
            const hljs = library.hljs;
            if (!hljs || typeof hljs.highlightElement !== 'function') return;
            this.originalHighlight = hljs.highlightElement;
            this.highlightWrapper = element => {
                if (!(element instanceof Element) || !element.closest('#chat') || !this.started || !this.settings.deferChatHighlight) {
                    return this.originalHighlight.call(hljs, element);
                }
                this.#queueChatHighlight(element, hljs);
                return undefined;
            };
            hljs.highlightElement = this.highlightWrapper;
            this.highlightLibrary = hljs;
            this.highlightObserver = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    this.highlightObserver.unobserve(entry.target);
                    this.#queueChatHighlight(entry.target, hljs, true);
                }
            }, { root: document.querySelector('#chat'), rootMargin: '160px 0px' });
            this.#observePendingCodeBlocks();
        } catch (error) {
            this.recordError(error, '聊天代码高亮代理');
        }
    }

    #queueChatHighlight(element, hljs, force = false) {
        const message = element.closest('.mes');
        const messages = [...document.querySelectorAll('#chat .mes')];
        const recent = messages.slice(-3).includes(message);
        if (this.settings.collapseOldCode && !recent) this.#collapseCodeBlock(element, hljs);
        if (element.dataset.claHighlighted === '1') return;
        if (element.dataset.highlighted === 'yes' && !force) {
            element.dataset.claHighlighted = '1';
            return;
        }
        if (this.settings.skipOldHighlight && !recent && !force) {
            element.dataset.claHighlightPending = '1';
            return;
        }
        const chatElement = document.querySelector('#chat');
        if (!force && !recent && (this.highlightPaused || !isElementVisible(element, chatElement))) {
            element.dataset.claHighlightPending = '1';
            this.highlightObserver?.observe(element);
            return;
        }
        element.dataset.claHighlightPending = '1';
        void this.scheduler.schedule(() => {
            if (!element.isConnected || element.dataset.claHighlighted === '1') return;
            this.originalHighlight.call(hljs, element);
            element.dataset.claHighlighted = '1';
            delete element.dataset.claHighlightPending;
            const message = element.closest('.mes');
            if (message) {
                void import('../../../../script.js').then(api => {
                    message.querySelectorAll('.code-copy').forEach(button => button.remove());
                    api.addCopyToCodeBlocks?.(message);
                }).catch(error => this.recordError(error, '恢复代码复制按钮'));
            }
        }, { priority: recent ? 1 : 3 }).catch(error => {
            if (error?.name !== 'AbortError') this.recordError(error, '延迟代码高亮');
        });
    }

    #collapseCodeBlock(element, hljs) {
        const pre = element.closest('pre');
        if (!pre || pre.dataset.claCollapsible === '1') return;
        pre.dataset.claCollapsible = '1';
        pre.classList.add('cla-code-collapsed');
        pre.addEventListener('click', () => {
            pre.classList.remove('cla-code-collapsed');
            if (this.started && this.originalHighlight) this.#queueChatHighlight(element, hljs, true);
        }, { once: true });
    }

    #observePendingCodeBlocks() {
        if (!this.highlightLibrary || !this.started) return;
        document.querySelectorAll(RICH_CODE_SELECTOR).forEach(element => this.#queueChatHighlight(element, this.highlightLibrary));
    }

    #restoreHighlighter() {
        this.highlightObserver?.disconnect();
        this.highlightObserver = null;
        if (this.highlightLibrary && this.highlightWrapper && this.highlightLibrary.highlightElement === this.highlightWrapper) {
            this.highlightLibrary.highlightElement = this.originalHighlight;
        }
        this.highlightLibrary = null;
        this.highlightWrapper = null;
        this.originalHighlight = null;
        document.querySelectorAll('[data-cla-highlight-pending], [data-cla-highlighted]').forEach(element => {
            delete element.dataset.claHighlightPending;
            delete element.dataset.claHighlighted;
        });
        document.querySelectorAll('.cla-code-collapsed').forEach(element => element.classList.remove('cla-code-collapsed'));
        document.querySelectorAll('[data-cla-collapsible]').forEach(element => delete element.dataset.claCollapsible);
    }

    #installSwipeGuard() {
        this.touchStartHandler = event => {
            if (!this.settings.mobileSwipeGuard || event.touches.length !== 1) return;
            const touch = event.touches[0];
            this.touchState = { x: touch.clientX, y: touch.clientY, axis: 'pending' };
        };
        this.touchMoveHandler = event => {
            if (!this.touchState || event.touches.length !== 1) return;
            const touch = event.touches[0];
            if (this.touchState.axis === 'pending' || this.touchState.axis === 'ambiguous') {
                this.touchState.axis = detectSwipeAxis({
                    deltaX: touch.clientX - this.touchState.x,
                    deltaY: touch.clientY - this.touchState.y,
                    minimum: 10,
                    ratio: 1.4,
                });
            }
            if (this.touchState.axis === 'vertical') event.stopImmediatePropagation();
        };
        this.touchEndHandler = () => {
            if (this.touchState?.axis === 'vertical') this.swipeSuppressUntil = performance.now() + 220;
            this.touchState = null;
        };
        this.swipeClickHandler = event => {
            if (performance.now() > this.swipeSuppressUntil) return;
            if (event.target instanceof Element && event.target.closest('.swipe_left, .swipe_right')) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        };
        document.addEventListener('touchstart', this.touchStartHandler, true);
        document.addEventListener('touchmove', this.touchMoveHandler, { capture: true, passive: true });
        document.addEventListener('touchend', this.touchEndHandler, true);
        document.addEventListener('click', this.swipeClickHandler, true);
    }

    #removeSwipeGuard() {
        document.removeEventListener('touchstart', this.touchStartHandler, true);
        document.removeEventListener('touchmove', this.touchMoveHandler, true);
        document.removeEventListener('touchend', this.touchEndHandler, true);
        document.removeEventListener('click', this.swipeClickHandler, true);
        this.touchState = null;
    }

    #installLongTaskObserver() {
        if (!('PerformanceObserver' in window)) return;
        try {
            this.longTaskObserver = new PerformanceObserver(list => {
                if (list.getEntries().some(entry => entry.duration >= 50)) this.scheduler.pauseNextFrame();
            });
            this.longTaskObserver.observe({ type: 'longtask', buffered: true });
        } catch {
            this.longTaskObserver = null;
        }
    }
}
