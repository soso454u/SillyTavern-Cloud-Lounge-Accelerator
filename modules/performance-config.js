const API_URL = '/api/plugins/cloud-lounge-accelerator/performance';

export class PerformanceConfigController {
    constructor({ getRequestHeaders = () => ({ 'Content-Type': 'application/json' }) } = {}) {
        this.getRequestHeaders = getRequestHeaders;
        this.status = null;
    }

    async refresh() {
        const pendingRestart = this.status?.restartRequired === true;
        try {
            const response = await fetch(API_URL, { credentials: 'same-origin', cache: 'no-store' });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || !payload.ok) throw new Error(payload.error || '服务端插件未连接');
            this.status = { available: true, ...payload, restartRequired: pendingRestart || payload.restartRequired === true };
        } catch (error) {
            this.status = {
                available: false,
                settings: { keepAlive: null, lazyCharacters: null },
                error: error instanceof Error ? error.message : String(error),
            };
        }
        return this.status;
    }

    async set(setting, enabled) {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: this.getRequestHeaders(),
            credentials: 'same-origin',
            cache: 'no-store',
            body: JSON.stringify({ setting, enabled }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) throw new Error(payload.error || '性能设置保存失败');
        this.status = { available: true, ...payload };
        return this.status;
    }
}
