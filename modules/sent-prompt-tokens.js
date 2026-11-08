const GENERATE_PATH = '/api/backends/chat-completions/generate';
const NATIVE_VALUE = 'data-cla-sent-token-native';

function textMessage(message) {
    const content = Array.isArray(message.content)
        ? message.content.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n')
        : message.content;
    if (typeof content !== 'string' || !content) return null;
    return {
        role: message.role,
        content,
        ...(typeof message.name === 'string' && message.name && { name: message.name }),
    };
}

function promptOrigins(collection, chat) {
    const groups = collection?.getCollection?.();
    const origins = new WeakMap();
    // Native squashing can flatten or merge groups before this event. Only
    // attribute history when the grouped collection still matches the prompt.
    if (!Array.isArray(groups) || !groups.some(group => typeof group?.getCollection === 'function')) return origins;
    const ordered = groups.flatMap(group => {
        const history = group.identifier === 'chatHistory';
        return (group.getCollection?.() || [group])
            .filter(message => message.content || message.tool_calls)
            .map(message => ({ message, history }));
    });
    if (ordered.length !== chat.length) return origins;
    ordered.forEach(({ message, history }, index) => {
        const outgoing = chat[index];
        if (outgoing && outgoing.role === message.role && outgoing.content === message.content
            && (outgoing.name || '') === (message.name || '') && outgoing.tool_calls === (message.tool_calls || undefined)) {
            origins.set(outgoing, history);
        }
    });
    return origins;
}

export class SentPromptTokens {
    constructor({ manager, model, tokenizerModel, eventSource, eventTypes, getCurrentChatId, getRequestHeaders, fetchTarget = globalThis }) {
        Object.assign(this, { manager, model, tokenizerModel, eventSource, eventTypes, getCurrentChatId, getRequestHeaders, fetchTarget });
        this.listeners = [];
        this.labels = new Map();
    }

    start() {
        const { eventTypes: types, eventSource: events } = this;
        if (!types.CHAT_COMPLETION_SETTINGS_READY || !events?.on || !events.removeListener
            || !this.tokenizerModel || typeof this.fetchTarget.fetch !== 'function') return;
        this.started = true;
        this.bind(types.CHAT_COMPLETION_PROMPT_READY, ({ chat, dryRun } = {}) => {
            if (dryRun === false && Array.isArray(chat)) this.origins = promptOrigins(this.manager.messages, chat);
        }, true);
        this.bind(types.CHAT_COMPLETION_SETTINGS_READY, settings => {
            if (settings?.type === 'quiet' || !Array.isArray(settings?.messages)) return;
            this.pending = { settings, origins: this.origins, scope: this.scope() };
            this.origins = null;
            this.watchDispatch();
        });
        for (const type of [types.CHAT_CHANGED, types.OAI_PRESET_CHANGED_AFTER]) {
            this.bind(type, () => { this.clear(); this.render(); });
        }
        for (const type of [types.GENERATION_STOPPED, types.GENERATION_ENDED]) {
            this.bind(type, () => this.clearPending());
        }

        this.render();
    }

    watchDispatch() {
        if (this.fetchWrapper) return;
        const previous = this.previousFetch = this.fetchTarget.fetch;
        const observer = this;
        // Arm the observer only between the native settings event and dispatch.
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
        this.pending = this.origins = null;
        if (this.fetchWrapper && this.fetchTarget.fetch === this.fetchWrapper) this.fetchTarget.fetch = this.previousFetch;
        this.fetchWrapper = null;
        this.previousFetch = null;
    }

    bind(type, handler, first = false) {
        if (!type) return;
        if (first && typeof this.eventSource.makeFirst === 'function') this.eventSource.makeFirst(type, handler);
        else this.eventSource.on(type, handler);
        this.listeners.push([type, handler]);
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
        this.clearPending();
        if (!pending?.scope.chat || !this.isCurrent(pending.scope)) return;
        const tokenizerModel = this.tokenizerModel();
        this.job?.abort();
        const job = this.job = new AbortController();
        this.snapshot = { scope: pending.scope, counting: true };
        // The native request is already dispatched. Never wait for tokenization,
        // read the generation response body, or change the returned promise.
        void Promise.resolve(response).then(async result => {
            if (!result.ok || job.signal.aborted || !this.isCurrent(pending.scope)) return;
            const { messages, type, model, chat_completion_source: source } = JSON.parse(body);
            if (type !== pending.settings.type || model !== pending.settings.model || source !== pending.settings.chat_completion_source
                || !Array.isArray(messages) || JSON.stringify(messages) !== JSON.stringify(pending.settings.messages)) return;
            const text = messages.map(textMessage);
            const origins = pending.settings.messages.map(message => pending.origins?.get(message));
            const history = origins.every(value => value !== undefined) ? text.filter((_, index) => origins[index]).filter(Boolean) : null;
            const [total, past] = await Promise.allSettled([
                this.count(text.filter(Boolean), tokenizerModel, job.signal),
                history === null ? null : this.count(history, tokenizerModel, job.signal),
            ]);
            if (job.signal.aborted || !this.isCurrent(pending.scope)) return;
            this.snapshot = {
                scope: pending.scope,
                total: total.status === 'fulfilled' ? total.value : null,
                history: past.status === 'fulfilled' ? past.value : null,
            };
        }).finally(() => {
            if (this.job !== job) return;
            this.job = null;
            if (this.snapshot?.counting) this.snapshot = null;
            this.render();
        }).catch(() => {});
        this.render();
    }

    async count(messages, model, signal) {
        if (!messages.length) return 0;
        if (!model) throw new Error('Tokenizer unavailable');
        const response = await this.fetchTarget.fetch(`/api/tokenizers/openai/count?model=${encodeURIComponent(model)}`, {
            method: 'POST', headers: this.getRequestHeaders(), body: JSON.stringify(messages), signal,
        });
        if (!response.ok) throw new Error('Tokenizer request failed');
        const { token_count: count } = await response.json();
        if (!Number.isFinite(count) || count < 0) throw new Error('Invalid token count');
        return count;
    }

    render() {
        if (!this.started) return;
        const snapshot = this.snapshot && this.isCurrent(this.snapshot.scope) ? this.snapshot : null;
        const container = this.manager.containerElement;
        const total = container?.querySelector('[data-i18n="Total Tokens:"]')?.parentElement;
        const history = this.manager.listElement?.querySelector(':scope > [data-pm-identifier="chatHistory"] > .prompt_manager_prompt_tokens');
        for (const [native, label] of this.labels) {
            if (native === total || native === history) continue;
            native.removeAttribute(NATIVE_VALUE);
            label.remove();
            this.labels.delete(native);
        }
        this.label(total, snapshot?.counting ? '最近发送 · 计数中…'
            : Number.isFinite(snapshot?.total) ? `最近发送 · 输入约 ${snapshot.total.toLocaleString()}` : '最近发送 · —',
        '最近一次聊天请求的消息文本估算，媒体、工具定义与服务商额外开销另计。');
        this.label(history, Number.isFinite(snapshot?.history) ? `约 ${snapshot.history.toLocaleString()}` : '—',
            '最近一次聊天请求中可确认属于过往信息的文本估算。', 'cla-sent-history-tokens');
    }

    label(native, text, title, className = 'cla-sent-total-tokens') {
        if (!native) return;
        let label = this.labels.get(native);
        if (!label) {
            label = native.ownerDocument.createElement('span');
            label.className = className;
            label.title = title;
            native.setAttribute(NATIVE_VALUE, '');
            native.after(label);
            this.labels.set(native, label);
        }
        label.textContent = text;
    }

    clear() {
        this.job?.abort();
        this.job = this.snapshot = null;
        this.clearPending();
    }

    stop() {
        this.started = false;
        this.clear();
        for (const [type, handler] of this.listeners) this.eventSource.removeListener(type, handler);
        this.listeners = [];
        for (const [native, label] of this.labels) {
            native.removeAttribute(NATIVE_VALUE);
            label.remove();
        }
        this.labels.clear();
    }
}
