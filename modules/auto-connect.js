const BUTTONS = { openai: 'api_button_openai', novel: 'api_button_novel', kobold: 'api_button', textgenerationwebui: 'api_button_textgenerationwebui' };

// One native connection attempt at startup and per key change; never a retry loop.
export class AutoConnectController {
    constructor({ scriptApi, isGenerating = () => false, isSecretBusy = () => false,
        documentRef = globalThis.document, delay = 500,
        loadApi = () => import('../../../../secrets.js') } = {}) {
        Object.assign(this, { scriptApi, isGenerating, isSecretBusy, document: documentRef, delay, loadApi });
        this.started = false; this.generation = 0; this.listeners = [];
        this.onKey = key => {
            if (key !== this.secretApi?.resolveSecretKey?.()) return;
            this.request('key');
        };
        this.onFinished = () => { if (this.pending) this.schedule(); };
        this.onClick = event => {
            if (this.clicking) return;
            if (event.target?.closest?.('.api_loading')) { this.cancel(); return; }
            const button = event.target?.closest?.('.api_button');
            if (button && Object.values(BUTTONS).includes(button.id)) {
                this.lastAttempt = this.signature(); this.cancel();
            }
        };
    }

    async start() {
        if (this.started) return;
        const generation = ++this.generation;
        try {
            const api = await this.loadApi();
            if (generation !== this.generation) return;
            if (typeof api.resolveSecretKey !== 'function') return;
            this.secretApi = api;
        } catch (error) { console.debug('[Cloud Lounge Accelerator] 自动连接不可用', error); return; }
        this.lastAttempt = null;
        this.started = true;
        const types = this.scriptApi.event_types || {};
        for (const name of ['SECRET_ROTATED', 'SECRET_WRITTEN', 'SECRET_DELETED']) this.listen(types[name], this.onKey);
        for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) this.listen(types[name], this.onFinished);
        this.document.addEventListener('click', this.onClick, true);
        this.request('startup');
    }

    listen(name, fn) {
        if (!name) return;
        this.scriptApi.eventSource?.on(name, fn); this.listeners.push([name, fn]);
    }
    button() { return this.document.getElementById(BUTTONS[this.scriptApi.main_api]); }
    signature() {
        const key = this.secretApi?.resolveSecretKey?.();
        const state = this.secretApi?.secret_state?.[key];
        const id = Array.isArray(state) ? state.find(secret => secret.active)?.id : '';
        return JSON.stringify([this.scriptApi.main_api, key, id,
            this.document.getElementById('chat_completion_source')?.value,
            this.document.getElementById('custom_api_url_text')?.value]);
    }
    loading(button = this.button()) { return button?.disabled || button?.classList.contains('disabled'); }
    connected() { return !!this.scriptApi.online_status && this.scriptApi.online_status !== 'no_connection'; }

    request(reason) {
        if (!this.started) return;
        const signature = this.signature();
        if (this.lastAttempt === signature || this.connected()) return;
        // Native auto-connect/connection profiles may already cover this change.
        if (this.loading()) { this.lastAttempt = signature; this.cancel(); return; }
        this.pending = { signature, reason, since: Date.now() };
        this.schedule();
    }
    schedule() {
        clearTimeout(this.timer);
        if (this.started && this.pending) this.timer = setTimeout(() => { this.timer = null; this.run(); }, this.delay);
    }
    run() {
        const pending = this.pending;
        if (!this.started || !pending) return;
        if (pending.signature !== this.signature() || this.connected()) { this.cancel(); return; }
        const button = this.button();
        if (!button || this.loading(button)) { this.lastAttempt = pending.signature; this.cancel(); return; }
        if (this.isGenerating() || this.isSecretBusy()) {
            // Deferred only while local work is active, not after API failures.
            if (Date.now() - pending.since < 30000) this.schedule();
            return;
        }
        const api = this.scriptApi.main_api;
        const key = this.secretApi.resolveSecretKey();
        const state = this.secretApi.secret_state?.[key];
        const hasSecret = Array.isArray(state) ? state.some(secret => secret.active) : !!state;
        if (api === 'openai' && key === this.secretApi.SECRET_KEYS?.CUSTOM) {
            const url = this.document.getElementById('custom_api_url_text')?.value;
            try { if (!['http:', 'https:'].includes(new URL(url).protocol)) { this.cancel(); return; } }
            catch { this.cancel(); return; }
        } else if (['openai', 'novel'].includes(api) && !hasSecret) {
            // Let native validation handle keyless/proxy providers only when a
            // proxy is configured; missing credentials should not cause alerts.
            if (!this.document.getElementById('openai_reverse_proxy')?.value) { this.cancel(); return; }
        }
        this.lastAttempt = pending.signature; this.pending = null;
        this.clicking = true;
        try { button.click(); }
        finally { this.clicking = false; }
    }
    cancel() { clearTimeout(this.timer); this.timer = null; this.pending = null; }
    stop() {
        this.started = false; this.generation++; this.cancel();
        this.document?.removeEventListener('click', this.onClick, true);
        for (const [name, fn] of this.listeners) this.scriptApi.eventSource?.removeListener(name, fn);
        this.listeners = [];
    }
}
