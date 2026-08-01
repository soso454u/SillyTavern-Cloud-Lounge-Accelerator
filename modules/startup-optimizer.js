import { classifyStartupRequest } from '../client-core.js';

const FETCH_TTL_MS = 20000;
const LOG_PREFIX = '[Cloud Lounge Accelerator]';

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
    constructor({ eventSource, eventTypes, onChatPayload = null, onStatus = null }) {
        this.eventSource = eventSource;
        this.eventTypes = eventTypes;
        this.onChatPayload = onChatPayload;
        this.onStatus = onStatus;
        this.nativeFetch = null;
        this.fetchWrapper = null;
        this.entries = new Map();
        this.timers = new Set();
        this.handlers = [];
        this.banner = null;
        this.started = false;
        this.startupFeatures = true;
    }

    start({ startupFeatures = true } = {}) {
        this.startupFeatures = Boolean(startupFeatures);
        if (this.started) return;
        this.started = true;
        this.installFetchCoordinator();
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
        void this.prefetchInitializationRequests();
        try {
            const loaderModule = await import('../../../../action-loader.js');
            const handle = loaderModule.loader?.active?.().find(item => item.slug === 'app-init');
            if (!handle || !this.started) return;
            await loaderModule.loader.hide(handle);
            document.body?.classList.add('cla-early-ui');
            this.banner = document.createElement('div');
            this.banner.className = 'cla-background-init-banner';
            this.banner.textContent = '酒馆界面已可操作 · 其余内容正在后台初始化';
            document.body.append(this.banner);
        } catch (error) {
            console.debug(LOG_PREFIX, '提前显示界面不可用，保留酒馆原生启动流程', error);
        }
    }

    onAppReady() {
        document.body?.classList.remove('cla-early-ui');
        this.banner?.remove();
        this.banner = null;
        this.entries.clear();
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
            if (!this.startupFeatures) return nativeFetch(input, init);
            if (policy === 'invalidate') {
                const response = await nativeFetch(input, init);
                if (response.ok) this.entries.clear();
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

    async prefetchInitializationRequests() {
        try {
            const api = await import('../../../../../script.js');
            if (!this.started || typeof api.getRequestHeaders !== 'function') return;
            const requests = [
                ['/api/avatars/get', { method: 'POST', headers: api.getRequestHeaders({ omitContentType: true }) }],
                ['/api/characters/all', { method: 'POST', headers: api.getRequestHeaders(), body: '{}' }],
                ['/api/backgrounds/all', { method: 'POST', headers: api.getRequestHeaders(), body: '{}' }],
            ];
            await Promise.allSettled(requests.map(([url, options]) => window.fetch(url, options)));
        } catch (error) {
            console.debug(LOG_PREFIX, '初始化预取不可用，保留酒馆原生请求', error);
        }
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        if (this.fetchWrapper && window.fetch === this.fetchWrapper) window.fetch = this.nativeFetch;
        for (const [name, handler] of this.handlers) this.eventSource.removeListener(name, handler);
        this.handlers = [];
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        this.entries.clear();
        this.fetchWrapper = null;
        this.nativeFetch = null;
        document.body?.classList.remove('cla-early-ui');
        this.banner?.remove();
        this.banner = null;
        this.startupFeatures = true;
    }
}
