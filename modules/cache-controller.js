import { CLIENT_VERSION, connectionAllowsWarmup } from '../client-core.js';
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

export function serverVersionMatchesClient(version) {
    return typeof version === 'string' && version === CLIENT_VERSION;
}

export class CacheController {
    constructor({ onStatus = null } = {}) {
        this.onStatus = onStatus;
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
            const response = await fetch(`${API_BASE}/health`, { credentials: 'same-origin', cache: 'no-store' });
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

    async readNavigationSignature() {
        const options = { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'follow' };
        const response = await fetch(new URL('/', location.href), options);
        if (response.status !== 200 || response.headers.has('www-authenticate') || response.headers.has('proxy-authenticate')) return '';
        const validator = response.headers.get('etag') || response.headers.get('last-modified') || '';
        return validator ? `${CLIENT_VERSION}:${validator}` : CLIENT_VERSION;
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
        const registration = await this.register();
        if (generation !== this.generation) {
            if (registration && this.isOurs(registration)) await registration.unregister();
            return null;
        }
        const signature = await this.readNavigationSignature();
        if (generation !== this.generation) return null;
        if (signature) await this.message('VERSION_SIGNATURE', { signature });
        this.scheduleWarmup(signature || CLIENT_VERSION, force);
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
