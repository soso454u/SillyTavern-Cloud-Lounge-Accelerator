import { estimateRenderComplexity, getAdaptiveBatchSize, prioritizeMessageDescriptors } from '../client-core.js';

const CONTROL_SELECTOR = [
    '.regex_editor',
    '#regex_container',
    '#bulk_enable_regex',
    '#bulk_disable_regex',
    '#bulk_delete_regex',
    '#regex_preset_apply',
].join(',');

export class RegexRefreshController {
    constructor({ chat, reloadCurrentChat, scheduler, onStatus = null }) {
        this.chat = chat;
        this.reloadCurrentChat = reloadCurrentChat;
        this.scheduler = scheduler;
        this.onStatus = onStatus;
        this.started = false;
        this.signature = '';
        this.editorWasOpen = false;
        this.dirty = false;
        this.refreshing = false;
        this.checkTimer = null;
        this.flushTimer = null;
        this.observer = null;
        this.onInteraction = this.onInteraction.bind(this);
    }

    async start() {
        if (this.started) return;
        this.started = true;
        document.addEventListener('input', this.onInteraction, false);
        document.addEventListener('change', this.onInteraction, false);
        document.addEventListener('click', this.onInteraction, false);
        document.addEventListener('cla-regex-dirty', this.onInteraction, false);
        this.observer = new MutationObserver(() => {
            const editorOpen = Boolean(document.querySelector('.regex_editor'));
            if (this.editorWasOpen && !editorOpen) this.queueSignatureCheck(250);
            this.editorWasOpen = editorOpen;
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
        this.signature = await this.readSignature().catch(() => '');
    }

    onInteraction(event) {
        const target = event.target instanceof Element ? event.target : null;
        if (event.type === 'cla-regex-dirty' || target?.closest(CONTROL_SELECTOR)) this.queueSignatureCheck();
    }

    queueSignatureCheck(delay = 400) {
        clearTimeout(this.checkTimer);
        this.checkTimer = setTimeout(async () => {
            if (!this.started) return;
            try {
                const next = await this.readSignature();
                if (next && this.signature && next !== this.signature) this.markDirty();
                this.signature = next;
            } catch (error) {
                console.debug('[Cloud Lounge Accelerator] 正则状态检查失败', error);
            }
        }, delay);
    }

    async readSignature() {
        const engine = await import('../../../regex/engine.js');
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

    markDirty() {
        this.dirty = true;
        clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => {
            if (!this.started || document.querySelector('.regex_editor')) {
                this.markDirty();
                return;
            }
            void this.reapply({ automatic: true });
        }, 650);
    }

    getDescriptors() {
        const root = document.querySelector('#chat');
        if (!root) return [];
        const rootRect = root.getBoundingClientRect();
        const elements = [...root.querySelectorAll('.mes[mesid]')];
        const recent = new Set(elements.slice(-5));
        return prioritizeMessageDescriptors(elements.map(element => {
            const messageId = Number(element.getAttribute('mesid'));
            const rect = element.getBoundingClientRect();
            return {
                element,
                messageId,
                visible: rect.bottom >= rootRect.top && rect.top <= rootRect.bottom,
                recent: recent.has(element),
                complexity: estimateRenderComplexity({
                    domNodes: element.querySelectorAll('*').length,
                    htmlLength: element.innerHTML.length,
                    richElements: element.querySelectorAll('details, table, pre, svg, iframe').length,
                }),
            };
        }).filter(item => Number.isInteger(item.messageId) && this.chat[item.messageId]));
    }

    async reapply({ automatic = false } = {}) {
        if (this.refreshing) return { skipped: true };
        this.refreshing = true;
        this.dirty = false;
        clearTimeout(this.flushTimer);
        const startedAt = performance.now();
        let completed = 0;
        let failed = 0;
        try {
            const api = await import('../../../../../script.js');
            if (typeof api.updateMessageBlock !== 'function') throw new Error('当前酒馆不支持局部消息刷新');
            const descriptors = this.getDescriptors();
            if (!descriptors.length) return { completed: 0, failed: 0, elapsedMs: 0 };
            let batch = 4;
            let previousFrameMs = 0;
            for (let cursor = 0; cursor < descriptors.length;) {
                await this.scheduler.yield(descriptors[cursor].visible ? 0 : (descriptors[cursor].recent ? 1 : 2));
                const frameStart = performance.now();
                batch = getAdaptiveBatchSize({
                    complexity: descriptors[cursor].complexity,
                    previousFrameMs,
                    currentBatch: batch,
                });
                for (let count = 0; cursor < descriptors.length && count < batch; count += 1, cursor += 1) {
                    const descriptor = descriptors[cursor];
                    try {
                        api.updateMessageBlock(descriptor.messageId, this.chat[descriptor.messageId], { rerenderMessage: true });
                    } catch (error) {
                        failed += 1;
                        console.debug('[Cloud Lounge Accelerator] 局部刷新消息失败', descriptor.messageId, error);
                    }
                    completed += 1;
                    if (performance.now() - frameStart >= 11) {
                        cursor += 1;
                        break;
                    }
                }
                previousFrameMs = performance.now() - frameStart;
            }
            if (failed > 0) await this.reloadCurrentChat();
            this.onStatus?.('chat', failed ? '已回退完整刷新' : '自动');
            return { completed, failed, elapsedMs: performance.now() - startedAt, automatic };
        } catch (error) {
            if (error?.name === 'AbortError') return { cancelled: true, completed, failed };
            await this.reloadCurrentChat();
            this.onStatus?.('chat', '已回退完整刷新');
            if (!automatic) throw error;
            return { completed, failed: failed + 1, fallback: true, elapsedMs: performance.now() - startedAt };
        } finally {
            this.refreshing = false;
            if (this.started && this.dirty) this.markDirty();
        }
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        document.removeEventListener('input', this.onInteraction, false);
        document.removeEventListener('change', this.onInteraction, false);
        document.removeEventListener('click', this.onInteraction, false);
        document.removeEventListener('cla-regex-dirty', this.onInteraction, false);
        this.observer?.disconnect();
        this.observer = null;
        clearTimeout(this.checkTimer);
        clearTimeout(this.flushTimer);
        this.checkTimer = null;
        this.flushTimer = null;
        this.dirty = false;
    }
}
