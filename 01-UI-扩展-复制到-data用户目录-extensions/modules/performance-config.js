const API_URL = '/api/plugins/cloud-lounge-accelerator/performance';
const STATUS_TTL_MS = 5000;

export class PerformanceConfigController {
    constructor({
        getRequestHeaders = () => ({ 'Content-Type': 'application/json' }),
        fetchImpl = (...args) => fetch(...args),
        now = () => Date.now(),
    } = {}) {
        this.getRequestHeaders = getRequestHeaders;
        this.fetchImpl = fetchImpl;
        this.now = now;
        this.status = null;
        this.statusReadAt = -Infinity;
        this.pendingRefresh = null;
        this.generation = 0;
    }

    refresh({ force = false } = {}) {
        if (!force && this.status && this.now() - this.statusReadAt < STATUS_TTL_MS) return Promise.resolve(this.status);
        if (this.pendingRefresh) return this.pendingRefresh;
        const promise = this.readStatus(this.generation).finally(() => {
            if (this.pendingRefresh === promise) this.pendingRefresh = null;
        });
        this.pendingRefresh = promise;
        return promise;
    }

    async readStatus(generation) {
        const pendingRestart = this.status?.restartRequired === true;
        let status;
        try {
            const response = await this.fetchImpl(API_URL, { credentials: 'same-origin', cache: 'no-store' });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || !payload.ok) throw new Error(payload.error || '服务端插件未连接');
            status = { available: true, ...payload, restartRequired: pendingRestart || payload.restartRequired === true };
        } catch (error) {
            status = {
                available: false,
                settings: { keepAlive: null, lazyCharacters: null, chatCompression: null },
                error: error instanceof Error ? error.message : String(error),
            };
        }
        if (generation === this.generation) {
            this.status = status;
            this.statusReadAt = this.now();
        }
        return this.status;
    }

    async set(setting, enabled) {
        const response = await this.fetchImpl(API_URL, {
            method: 'POST',
            headers: this.getRequestHeaders(),
            credentials: 'same-origin',
            cache: 'no-store',
            body: JSON.stringify({ setting, enabled }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) throw new Error(payload.error || '性能设置保存失败');
        this.generation += 1;
        this.pendingRefresh = null;
        this.status = { available: true, ...payload };
        this.statusReadAt = this.now();
        return this.status;
    }
}
