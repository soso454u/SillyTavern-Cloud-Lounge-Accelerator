const GENERATE_PATH = '/api/backends/chat-completions/generate';

function tokenizerMessage(message) {
    const content = Array.isArray(message?.content)
        ? message.content.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n')
        : message?.content;
    if (typeof content !== 'string' || !content) return null;
    return {
        role: message.role,
        content,
        ...(typeof message.name === 'string' && message.name && { name: message.name }),
    };
}

// Use the outgoing messages as the input for a separate, local token count.
// The native request, response, prompt budget and per-row counts stay intact.
export class SentPromptTotal {
    constructor({ manager, model, tokenizerModel, eventSource, eventTypes, getCurrentChatId, getRequestHeaders, fetchTarget = globalThis }) {
        Object.assign(this, { manager, model, tokenizerModel, eventSource, eventTypes, getCurrentChatId, getRequestHeaders, fetchTarget });
        this.listeners = [];
    }

    start() {
        const types = this.eventTypes;
        if (!types?.CHAT_COMPLETION_SETTINGS_READY || !this.eventSource?.on || !this.eventSource.removeListener
            || !this.tokenizerModel || typeof this.fetchTarget.fetch !== 'function') return;
        this.started = true;
        this.bind(types.CHAT_COMPLETION_SETTINGS_READY, settings => {
            if (settings?.type === 'quiet' || !Array.isArray(settings?.messages)) return;
            const scope = this.scope();
            if (scope.chat == null) return;
            this.pending = { settings, scope };
            this.watchDispatch();
        });
        for (const type of [types.CHAT_CHANGED, types.OAI_PRESET_CHANGED_AFTER]) {
            this.bind(type, () => this.clear());
        }
        for (const type of [types.GENERATION_STOPPED, types.GENERATION_ENDED]) {
            this.bind(type, () => this.clearPending());
        }
    }

    bind(type, handler) {
        if (!type) return;
        this.eventSource.on(type, handler);
        this.listeners.push([type, handler]);
    }

    watchDispatch() {
        if (this.fetchWrapper) return;
        const observer = this;
        const previous = this.previousFetch = this.fetchTarget.fetch;
        const wrapper = function (input, init) {
            const response = previous.apply(this, arguments);
            if (observer.fetchWrapper === wrapper && input === GENERATE_PATH && init?.method === 'POST'
                && typeof init.body === 'string' && !init.signal?.aborted) {
                try { observer.observe(response, init.body); } catch { observer.clearPending(); }
            }
            return response;
        };
        this.fetchWrapper = wrapper;
        this.fetchTarget.fetch = wrapper;
    }

    clearPending() {
        this.pending = null;
        if (this.fetchWrapper && this.fetchTarget.fetch === this.fetchWrapper) this.fetchTarget.fetch = this.previousFetch;
        this.fetchWrapper = null;
        this.previousFetch = null;
    }

    scope() {
        return { chat: this.getCurrentChatId(), prompts: this.manager.serviceSettings?.prompts, model: this.model() };
    }

    isCurrent(scope) {
        const current = this.scope();
        return current.chat === scope.chat && current.prompts === scope.prompts && current.model === scope.model;
    }

    observe(response, body) {
        const pending = this.pending;
        // An unrelated background request can use the same endpoint.
        if (!pending || JSON.stringify(pending.settings) !== body) return;
        this.clearPending();
        if (!this.isCurrent(pending.scope)) return;
        const model = this.tokenizerModel();
        if (!model) return;
        this.job?.abort();
        const job = this.job = new AbortController();
        const current = () => !job.signal.aborted && this.isCurrent(pending.scope);
        void Promise.resolve(response).then(async result => {
            if (!result.ok || !current()) return;
            const { messages } = JSON.parse(body);
            const text = messages.map(tokenizerMessage).filter(Boolean);
            const count = text.length ? await this.count(text, model, job.signal) : 0;
            if (!current()) return;
            this.snapshot = { scope: pending.scope, count };
            this.render();
        }).finally(() => {
            if (this.job === job) this.job = null;
        }).catch(() => {});
    }

    async count(messages, model, signal) {
        const response = await this.fetchTarget.fetch(`/api/tokenizers/openai/count?model=${encodeURIComponent(model)}`, {
            method: 'POST', headers: this.getRequestHeaders(), body: JSON.stringify(messages), signal,
        });
        if (!response.ok) throw new Error('Tokenizer request failed');
        const { token_count: count } = await response.json();
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid token count');
        return count;
    }

    render() {
        if (!this.started) return;
        if (!this.snapshot || !this.isCurrent(this.snapshot.scope)) {
            this.restoreHeader();
            return;
        }
        const caption = this.manager.containerElement?.querySelector('[data-i18n="Total Tokens:"]');
        const number = caption?.nextSibling;
        if (this.header?.node !== number) this.restoreHeader();
        if (number?.nodeType !== 3) return;
        if (!this.header || number.data !== this.header.written) {
            const spacing = /^(\s*)\d+(\s*)$/.exec(number.data);
            if (!spacing) return;
            this.header = { node: number, native: number.data, before: spacing[1], after: spacing[2] };
        }
        const written = this.header.before + String(this.snapshot.count) + this.header.after;
        this.header.written = written;
        if (number.data !== written) number.data = written;
    }

    restoreHeader() {
        const header = this.header;
        this.header = null;
        if (header && header.node.data === header.written) header.node.data = header.native;
    }

    clear() {
        this.job?.abort();
        this.job = this.snapshot = null;
        this.clearPending();
        this.restoreHeader();
    }

    stop() {
        this.started = false;
        this.clear();
        for (const [type, handler] of this.listeners) this.eventSource.removeListener(type, handler);
        this.listeners = [];
    }
}
