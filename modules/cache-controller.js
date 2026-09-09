import { CLIENT_VERSION, connectionAllowsWarmup } from '../client-core.js';
import { isIosFamily } from '../utils/device-profile.js';
import { cancelIdle, requestIdle } from '../utils/feature-detection.js';

const PLUGIN_ID = 'cloud-lounge-accelerator';
const API_BASE = `/api/plugins/${PLUGIN_ID}`;
const CACHE_PREFIXES = ['cloud-lounge-static-', 'cloud-lounge-static-v2-'];
const WARM_KEY = 'cloud-lounge-accelerator:last-warm-signature';
const CORE_URLS = Object.freeze([
    '/scripts/extensions/regex/dropdown.html',
    '/scripts/extensions/regex/editor.html',
    '/scripts/extensions/regex/debugger.html',
    '/scripts/extensions/regex/debugger.css',
    '/scripts/templates/themeDelete.html',
    '/scripts/templates/themeImportWarning.html',
]);
const HTTP_CACHE_PROBE_URLS = Object.freeze(['/style.css', '/script.js']);
const MIN_NATIVE_CACHE_SECONDS = 300;

export function serverVersionMatchesClient(version) {
    return typeof version === 'string' && version === CLIENT_VERSION;
}

function readHeader(headers, name) {
    if (typeof headers?.get === 'function') return headers.get(name) || '';
    if (!headers || typeof headers !== 'object') return '';
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return entry ? String(entry[1]) : '';
}

export function hasReliableNativeHttpCache(headers, {
    minimumFreshSeconds = MIN_NATIVE_CACHE_SECONDS,
    now = Date.now(),
} = {}) {
    const cacheControl = readHeader(headers, 'cache-control');
    if (/(?:^|,)\s*(?:no-store|no-cache)(?:\s*(?:,|$|=))/i.test(cacheControl)) return false;

    const age = Math.max(0, Number.parseInt(readHeader(headers, 'age'), 10) || 0);
    const maxAgeMatch = cacheControl.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i);
    if (maxAgeMatch) return Number.parseInt(maxAgeMatch[1], 10) - age >= minimumFreshSeconds;

    const expiresAt = Date.parse(readHeader(headers, 'expires'));
    if (!Number.isFinite(expiresAt)) return false;
    const serverDate = Date.parse(readHeader(headers, 'date'));
    const baseline = Number.isFinite(serverDate) ? serverDate : now;
    return (expiresAt - baseline) / 1000 - age >= minimumFreshSeconds;
}

export function isIOSStandaloneEnvironment({
    userAgent = '',
    platform = '',
    maxTouchPoints = 0,
    standalone = false,
    displayModeStandalone = false,
} = {}) {
    return isIosFamily({ userAgent, platform, maxTouchPoints })
        && (standalone === true || displayModeStandalone === true);
}

export function isIOSStandalone() {
    return isIOSStandaloneEnvironment({
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        maxTouchPoints: navigator.maxTouchPoints,
        standalone: navigator.standalone,
        displayModeStandalone: window.matchMedia?.('(display-mode: standalone)')?.matches,
    });
}

export class CacheController {
    constructor({
        onStatus = null,
        detectIOSStandalone = isIOSStandalone,
        fetchImpl = (...args) => fetch(...args),
    } = {}) {
        this.onStatus = onStatus;
        this.detectIOSStandalone = detectIOSStandalone;
        this.fetchImpl = fetchImpl;
        this.registration = undefined;
        this.health = null;
        this.state = 'unknown';
        this.stats = null;
        this.idleHandle = null;
        this.generation = 0;
    }

    isSupported() {
        return window.isSecureContext && 'serviceWorker' in navigator && 'caches' in window;
    }

    async probe({ force = false } = {}) {
        if (!this.isSupported()) {
            this.state = 'unsupported';
            return null;
        }
        if (!force && this.health) return this.health;
        try {
            const response = await this.fetchImpl(`${API_BASE}/health`, { credentials: 'same-origin', cache: 'no-store' });
            if (!response.ok) {
                this.state = response.status === 404 ? 'missing' : 'error';
                return null;
            }
            const payload = await response.json();
            if (!payload?.ok) throw new Error('服务端健康检查返回无效');
            this.health = payload;
            this.state = serverVersionMatchesClient(payload.version) ? 'available' : 'version-mismatch';
            return payload;
        } catch {
            this.state = 'missing';
            return null;
        }
    }

    async findRegistration({ refresh = false } = {}) {
        if (!('serviceWorker' in navigator)) return null;
        if (!refresh && this.registration !== undefined) return this.registration;
        const scope = new URL('/', location.href).href;
        const registrations = await navigator.serviceWorker.getRegistrations();
        this.registration = registrations.find(item => item.scope === scope) || null;
        return this.registration;
    }

    isOurs(registration) {
        const worker = registration?.active || registration?.waiting || registration?.installing;
        return Boolean(worker?.scriptURL?.includes(`${API_BASE}/service-worker.js`));
    }

    async register() {
        if (!await this.probe()) return null;
        const existing = await this.findRegistration({ refresh: true });
        if (existing && !this.isOurs(existing)) throw new Error('站点根路径已有其他 Service Worker，未覆盖');
        this.registration = await navigator.serviceWorker.register(`${API_BASE}/service-worker.js?v=${CLIENT_VERSION}`, {
            scope: '/',
            updateViaCache: 'none',
        });
        await this.registration.update();
        return this.registration;
    }

    async probeNativeHttpCache() {
        try {
            const responses = await Promise.all(HTTP_CACHE_PROBE_URLS.map(url => this.fetchImpl(url, {
                method: 'HEAD',
                credentials: 'same-origin',
                cache: 'no-store',
            })));
            return responses.every(response => response.ok && hasReliableNativeHttpCache(response.headers));
        } catch {
            return false;
        }
    }

    workerFor(registration) {
        return registration?.active || registration?.waiting || registration?.installing || navigator.serviceWorker.controller;
    }

    async message(type, payload = {}, timeout = 20000) {
        const registration = await this.findRegistration();
        if (!registration || !this.isOurs(registration)) throw new Error('页面缓存尚未启用');
        const worker = this.workerFor(registration);
        if (!worker) throw new Error('页面缓存尚未激活');
        return new Promise((resolve, reject) => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => reject(new Error('页面缓存响应超时')), timeout);
            channel.port1.onmessage = event => {
                clearTimeout(timer);
                event.data?.ok ? resolve(event.data) : reject(new Error(event.data?.error || '页面缓存操作失败'));
            };
            worker.postMessage({ type, ...payload }, [channel.port2]);
        });
    }

    collectWarmUrls() {
        const urls = new Set(CORE_URLS);
        for (const entry of performance.getEntriesByType?.('resource') || []) {
            try {
                const url = new URL(entry.name, location.href);
                if (url.origin === location.origin) urls.add(url.href);
            } catch {
                // Ignore malformed performance entries.
            }
        }
        return [...urls];
    }

    readVersionSignature() {
        return typeof this.health?.appSignature === 'string' && this.health.appSignature
            ? this.health.appSignature
            : CLIENT_VERSION;
    }

    async startAfterLogin({ force = false } = {}) {
        const generation = ++this.generation;
        if (!await this.probe({ force })) {
            this.onStatus?.('cache', this.state === 'unsupported' ? '需要 HTTPS' : '仅 UI 模式');
            return null;
        }
        if (this.state === 'version-mismatch') {
            await this.retireIncompatibleWorker();
            this.onStatus?.('cache', '已停用（服务端需更新）');
            return null;
        }
        if (this.detectIOSStandalone() && this.health?.basicAuthMode === true) {
            await this.retireIncompatibleWorker();
            this.state = 'ios-basic-auth';
            this.onStatus?.('cache', '已停用（iOS 主屏幕 + Basic Auth）');
            return null;
        }
        if (await this.probeNativeHttpCache()) {
            await this.retireIncompatibleWorker();
            this.state = 'native-http-cache';
            this.onStatus?.('cache', '原生缓存');
            return null;
        }
        const registration = await this.register();
        if (generation !== this.generation) {
            if (registration && this.isOurs(registration)) await registration.unregister();
            return null;
        }
        const signature = this.readVersionSignature();
        if (generation !== this.generation) return null;
        await this.message('VERSION_SIGNATURE', { signature });
        this.scheduleWarmup(signature, force);
        this.onStatus?.('cache', '正常');
        return this.registration;
    }

    scheduleWarmup(signature, force = false) {
        this.cancelWarmup();
        if (!force && localStorage.getItem(WARM_KEY) === signature) return;
        if (document.hidden || !connectionAllowsWarmup(navigator.connection)) return;
        this.idleHandle = requestIdle(async () => {
            this.idleHandle = null;
            try {
                await this.message('WARM', { urls: this.collectWarmUrls() }, 30000);
                localStorage.setItem(WARM_KEY, signature);
            } catch (error) {
                console.debug('[Cloud Lounge Accelerator] 自动预热未完成', error);
            }
        }, 2500);
    }

    cancelWarmup() {
        if (this.idleHandle !== null) cancelIdle(this.idleHandle);
        this.idleHandle = null;
    }

    async refreshStats() {
        try {
            this.stats = await this.message('STATS');
        } catch {
            this.stats = null;
        }
        return this.stats;
    }

    async clearOwnCaches() {
        if (!('caches' in window)) return 0;
        const names = await caches.keys();
        const ownNames = names.filter(name => CACHE_PREFIXES.some(prefix => name.startsWith(prefix)));
        const results = await Promise.all(ownNames.map(name => caches.delete(name)));
        return results.filter(Boolean).length;
    }

    async retireIncompatibleWorker() {
        this.cancelWarmup();
        const registration = await this.findRegistration({ refresh: true });
        if (registration && this.isOurs(registration)) await registration.unregister();
        this.registration = undefined;
        localStorage.removeItem(WARM_KEY);
        return this.clearOwnCaches();
    }

    async stop({ clear = true } = {}) {
        this.generation += 1;
        this.cancelWarmup();
        const registration = await this.findRegistration({ refresh: true });
        if (registration && this.isOurs(registration)) await registration.unregister();
        this.registration = undefined;
        if (clear) await this.clearOwnCaches();
    }

    async repair() {
        this.cancelWarmup();
        await this.stop({ clear: true });
        localStorage.removeItem(WARM_KEY);
        const registration = await this.startAfterLogin({ force: true });
        if (!registration) return { warmed: 0, skipped: true, state: this.state };
        const result = await this.message('WARM', { urls: this.collectWarmUrls() }, 30000);
        await this.refreshStats();
        return result;
    }

    getStatus() {
        if (this.state === 'native-http-cache') {
            return {
                state: this.state,
                cache: '原生缓存',
                server: '正常',
                entries: null,
                warning: false,
                overall: '浏览器原生缓存',
            };
        }
        if (this.state === 'ios-basic-auth') {
            return {
                state: this.state,
                cache: '已停用',
                server: '正常',
                entries: null,
                compatibility: 'iOS 主屏幕 + Basic Auth',
                warning: false,
                overall: 'iOS 兼容模式',
            };
        }
        if (this.state === 'version-mismatch') {
            return {
                state: this.state,
                cache: '已停用（服务端需更新）',
                server: `需更新（${this.health?.version || '未知版本'}）`,
                entries: null,
                warning: true,
                overall: '服务端插件需更新',
            };
        }
        return {
            state: this.state,
            cache: this.state === 'available' ? '正常' : (this.state === 'unsupported' ? '需要 HTTPS' : '仅 UI 模式'),
            server: this.state === 'available' ? '正常' : '未连接',
            entries: this.stats?.entries ?? null,
        };
    }
}
