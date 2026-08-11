import { classifyStartupRequest } from '../client-core.js';

const FETCH_TTL_MS = 20000;
const LOG_PREFIX = '[Cloud Lounge Accelerator]';
const BACKGROUND_NOTICE_MS = 1800;
const RECOVERY_NOTICE_MS = 3200;

function cloneResponse(response) {
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

function describeRequest(input, init = {}) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const url = new URL(isRequest ? input.url : String(input), location.href);
    const method = String(init.method || (isRequest ? input.method : 'GET')).toUpperCase();
    const body = init.body;
    const reusableBody = body == null || typeof body === 'string' || body instanceof URLSearchParams;
    return {
        url,
        method,
        body: body == null ? '' : String(body),
        headers: init.headers || (isRequest ? input.headers : undefined),
        credentials: init.credentials || (isRequest ? input.credentials : ''),
        cache: init.cache || (isRequest ? input.cache : ''),
        mode: init.mode || (isRequest ? input.mode : ''),
        reusable: !isRequest && reusableBody && !init.signal,
    };
}

function fingerprint(descriptor) {
    return [
        descriptor.method,
        descriptor.url.href,
        descriptor.body,
        serializeHeaders(descriptor.headers),
        descriptor.credentials,
        descriptor.cache,
        descriptor.mode,
    ].join('\n');
}

export class StartupOptimizer {
    constructor({ eventSource, eventTypes, getCurrentChatId = () => undefined, onChatPayload = null, onStatus = null }) {
        this.eventSource = eventSource;
        this.eventTypes = eventTypes;
        this.getCurrentChatId = getCurrentChatId;
        this.onChatPayload = onChatPayload;
        this.onStatus = onStatus;
        this.nativeFetch = null;
        this.fetchWrapper = null;
        this.entries = new Map();
        this.recentSnapshots = new Map();
        this.recentPending = new Map();
        this.recentGeneration = 0;
        this.timers = new Set();
        this.handlers = [];
        this.banner = null;
        this.bannerTimer = null;
        this.recoveringWelcome = false;
        this.onOnline = () => void this.recoverWelcomeScreen();
        this.started = false;
        this.startupFeatures = true;
    }

    start({ startupFeatures = true } = {}) {
        this.startupFeatures = Boolean(startupFeatures);
        if (this.started) return;
        this.started = true;
        this.installFetchCoordinator();
        window.addEventListener('online', this.onOnline);
        this.bind(this.eventTypes.SETTINGS_LOADED, () => this.onSettingsLoaded());
        this.bind(this.eventTypes.APP_READY, () => this.onAppReady());
        if (this.startupFeatures) this.onStatus?.('页面启动优化已启用');
    }

    bind(name, handler) {
        if (!name) return;
        this.eventSource.on(name, handler);
        this.handlers.push([name, handler]);
    }

    async onSettingsLoaded() {
        if (!this.started || !this.startupFeatures) return;
        try {
            const loaderModule = await import('../../../../action-loader.js');
            const handle = loaderModule.loader?.active?.().find(item => item.slug === 'app-init');
            if (!handle || !this.started) return;
            await loaderModule.loader.hide(handle);
            document.body?.classList.add('cla-early-ui');
            this.showBackgroundNotice('正在后台加载最近聊天…');
        } catch (error) {
            console.debug(LOG_PREFIX, '提前显示界面不可用，保留酒馆原生启动流程', error);
        }
    }

    onAppReady() {
        document.body?.classList.remove('cla-early-ui');
        this.entries.clear();
        if (this.getCurrentChatId?.() != null || document.querySelector('#chat .welcomePanel')) {
            this.removeBackgroundNotice();
        } else {
            void this.recoverWelcomeScreen();
        }
    }

    showBackgroundNotice(message, duration = BACKGROUND_NOTICE_MS) {
        if (!this.started) return;
        if (!this.banner?.isConnected) {
            this.banner = document.createElement('div');
            this.banner.className = 'cla-background-init-banner';
            this.banner.setAttribute('role', 'status');
            this.banner.setAttribute('aria-live', 'polite');
            const spinner = document.createElement('span');
            spinner.className = 'cla-background-init-spinner';
            spinner.setAttribute('aria-hidden', 'true');
            const text = document.createElement('span');
            text.dataset.claBackgroundNotice = '';
            this.banner.append(spinner, text);
            document.body?.append(this.banner);
        }
        const text = this.banner?.querySelector('[data-cla-background-notice]');
        if (text) text.textContent = message;
        clearTimeout(this.bannerTimer);
        this.bannerTimer = setTimeout(() => this.removeBackgroundNotice(), duration);
    }

    removeBackgroundNotice() {
        clearTimeout(this.bannerTimer);
        this.bannerTimer = null;
        this.banner?.remove();
        this.banner = null;
    }

    async recoverWelcomeScreen() {
        if (!this.started || this.getCurrentChatId?.() != null || this.recoveringWelcome) return;
        if (document.querySelector('#chat .welcomePanel')) {
            this.removeBackgroundNotice();
            return;
        }
        this.showBackgroundNotice('正在后台读取最近聊天…');
        this.recoveringWelcome = true;
        try {
            const module = await import('../../../../welcome-screen.js');
            await module.openWelcomeScreen?.({ force: true });
            if (document.querySelector('#chat .welcomePanel')) this.removeBackgroundNotice();
        } catch (error) {
            console.debug(LOG_PREFIX, '最近聊天读取失败，等待联网后重试', error);
            this.showBackgroundNotice('最近聊天暂未载入 · 网络恢复后自动重试', RECOVERY_NOTICE_MS);
        } finally {
            this.recoveringWelcome = false;
        }
    }

    installFetchCoordinator() {
        if (this.fetchWrapper) return;
        const nativeFetch = window.fetch.bind(window);
        this.nativeFetch = nativeFetch;
        this.fetchWrapper = async (input, init = {}) => {
            let descriptor;
            try {
                descriptor = describeRequest(input, init);
            } catch {
                return nativeFetch(input, init);
            }
            const policy = classifyStartupRequest({ pathname: descriptor.url.pathname, method: descriptor.method });
            if (policy === 'observe-chat') {
                const response = await nativeFetch(input, init);
                await this.inspectChatResponse(cloneResponse(response));
                return response;
            }
            if (policy === 'stale-recent' && this.startupFeatures && descriptor.reusable) {
                return this.fetchRecentChats(nativeFetch, input, init, descriptor);
            }
            if (!this.startupFeatures) return nativeFetch(input, init);
            if (policy === 'invalidate') {
                const response = await nativeFetch(input, init);
                if (response.ok) {
                    this.entries.clear();
                    this.recentGeneration += 1;
                    this.recentSnapshots.clear();
                    this.recentPending.clear();
                }
                return response;
            }
            if (policy !== 'reuse' || !descriptor.reusable) return nativeFetch(input, init);

            const key = fingerprint(descriptor);
            const now = performance.now();
            const existing = this.entries.get(key);
            if (existing?.expiresAt > now) return cloneResponse(await existing.promise);
            const promise = nativeFetch(input, init);
            this.entries.set(key, { promise, expiresAt: now + FETCH_TTL_MS });
            const timer = setTimeout(() => {
                if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
                this.timers.delete(timer);
            }, FETCH_TTL_MS + 100);
            this.timers.add(timer);
            try {
                const response = await promise;
                if (!response.ok) this.entries.delete(key);
                return cloneResponse(response);
            } catch (error) {
                this.entries.delete(key);
                throw error;
            }
        };
        window.fetch = this.fetchWrapper;
    }

    async fetchRecentChats(nativeFetch, input, init, descriptor) {
        const key = fingerprint(descriptor);
        const cached = this.recentSnapshots.get(key);
        if (cached) {
            this.refreshRecentChats(nativeFetch, input, init, key);
            return cloneResponse(cached);
        }

        let pending = this.recentPending.get(key);
        if (!pending) {
            const generation = this.recentGeneration;
            pending = nativeFetch(input, init).then(response => {
                if (response.ok && this.started && generation === this.recentGeneration) {
                    this.recentSnapshots.set(key, cloneResponse(response));
                }
                return response;
            }).finally(() => {
                if (this.recentPending.get(key) === pending) this.recentPending.delete(key);
            });
            this.recentPending.set(key, pending);
        }
        return cloneResponse(await pending);
    }

    refreshRecentChats(nativeFetch, input, init, key) {
        if (this.recentPending.has(key)) return;
        const generation = this.recentGeneration;
        const pending = nativeFetch(input, init).then(response => {
            if (response.ok && this.started && generation === this.recentGeneration) {
                this.recentSnapshots.set(key, cloneResponse(response));
            }
        }).catch(error => {
            console.debug(LOG_PREFIX, '最近聊天后台刷新失败，继续使用本次会话缓存', error);
        }).finally(() => {
            if (this.recentPending.get(key) === pending) this.recentPending.delete(key);
        });
        this.recentPending.set(key, pending);
    }

    async inspectChatResponse(response) {
        if (!response?.ok || typeof this.onChatPayload !== 'function') return;
        try {
            const payload = await response.json();
            const messages = Array.isArray(payload) ? payload : (Array.isArray(payload?.chat) ? payload.chat : []);
            this.onChatPayload(messages);
        } catch (error) {
            console.debug(LOG_PREFIX, '聊天复杂度旁路分析失败', error);
        }
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        window.removeEventListener('online', this.onOnline);
        if (this.fetchWrapper && window.fetch === this.fetchWrapper) window.fetch = this.nativeFetch;
        for (const [name, handler] of this.handlers) this.eventSource.removeListener(name, handler);
        this.handlers = [];
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        this.entries.clear();
        this.recentGeneration += 1;
        this.recentSnapshots.clear();
        this.recentPending.clear();
        this.fetchWrapper = null;
        this.nativeFetch = null;
        document.body?.classList.remove('cla-early-ui');
        this.removeBackgroundNotice();
        this.recoveringWelcome = false;
        this.startupFeatures = true;
    }
}
