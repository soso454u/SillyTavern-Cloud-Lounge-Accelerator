import { estimateRenderComplexity, getAdaptiveBatchSize, prioritizeMessageDescriptors } from '../client-core.js';
import { createRegexSnapshot, diffRegexSnapshots, planRegexRefresh } from './regex-impact.js';

const CONTROL_SELECTOR = [
    '.regex_editor',
    '#regex_container',
    '#bulk_enable_regex',
    '#bulk_disable_regex',
    '#bulk_delete_regex',
    '#regex_preset_apply',
].join(',');

const LOG_PREFIX = '[Cloud Lounge Accelerator]';

const REGEX_LISTS = '#saved_regex_scripts, #saved_scoped_scripts, #saved_preset_scripts';

export class RegexRefreshController {
    constructor({
        chat, eventSource, eventTypes, getCurrentChatId = () => undefined,
        isGenerating = () => false, scheduler, onStatus = null,
        importChatApi = () => import('../../../../../script.js'),
    }) {
        this.chat = chat;
        this.eventSource = eventSource;
        this.eventTypes = eventTypes;
        this.getCurrentChatId = getCurrentChatId;
        this.isGenerating = isGenerating;
        this.importChatApi = importChatApi;
        this.generation = 0;
        this.scheduler = scheduler;
        this.onStatus = onStatus;
        this.started = false;
        this.engine = null;
        this.compileRegex = null;
        this.snapshot = null;
        this.pendingBaseSnapshot = null;
        this.dirty = false;
        this.refreshing = false;
        this.refreshCheckRequested = false;
        this.checkTimer = null;
        this.flushTimer = null;
        this.observer = null;
        this.onInteraction = this.onInteraction.bind(this);
    }

    async start() {
        if (this.started) return true;
        const generation = ++this.generation;
        try {
            const [engine, utils] = await Promise.all([
                import('../../../regex/engine.js'),
                import('../../../../utils.js'),
            ]);
            if (generation !== this.generation) return false;
            this.engine = engine;
            this.compileRegex = utils.regexFromString;
            this.snapshot = this.readSnapshot();
        } catch (error) {
            console.debug(LOG_PREFIX, '正则影响分析不可用', error);
            return false;
        }
        this.started = true;
        document.addEventListener('input', this.onInteraction, false);
        document.addEventListener('change', this.onInteraction, false);
        document.addEventListener('click', this.onInteraction, false);
        document.addEventListener('cla-regex-dirty', this.onInteraction, false);
        this.observer = new MutationObserver(records => {
            let listChanged = false;
            let editorRemoved = false;
            for (const record of records) {
                if (record.target === document.body) {
                    // Native Popup appends its dialog directly to body.
                    editorRemoved ||= Array.from(record.removedNodes).some(node =>
                        node.matches?.('.popup') && node.querySelector('.regex_editor'));
                } else {
                    listChanged ||= Boolean(record.target.matches?.(REGEX_LISTS));
                }
            }
            if (listChanged) this.queueSnapshotCheck(350, false);
            else if (editorRemoved && !document.querySelector('.regex_editor')) this.queueSnapshotCheck(250, false);
        });
        const regexRoot = document.getElementById('regex_container');
        if (regexRoot) this.observer.observe(regexRoot, { childList: true, subtree: true });
        this.observer.observe(document.body, { childList: true });
        return true;
    }

    readSnapshot() {
        const types = Object.values(this.engine?.SCRIPT_TYPES || {});
        const globalType = this.engine?.SCRIPT_TYPES?.GLOBAL;
        return createRegexSnapshot(types.map(type => {
            const scripts = this.engine.getScriptsByType?.(type) || [];
            const allowed = this.engine.getScriptsByType?.(type, { allowedOnly: true }) || [];
            return {
                type,
                scripts,
                scopeActive: type === globalType || scripts.length === 0 || allowed.length > 0,
            };
        }));
    }

    onInteraction(event) {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest?.('.cla-regex-organizer, .cla-regex-organizer-toggle')) return;
        if (event.type === 'cla-regex-dirty') {
            this.queueSnapshotCheck(60, true);
        } else if (target?.closest(CONTROL_SELECTOR)) {
            this.queueSnapshotCheck(450, false);
        }
    }

    noteChange() {
        this.queueSnapshotCheck(20, true);
    }

    queueSnapshotCheck(delay = 400, requestRefresh = false) {
        this.refreshCheckRequested ||= requestRefresh;
        clearTimeout(this.checkTimer);
        this.checkTimer = setTimeout(() => {
            if (!this.started) return;
            try {
                const next = this.readSnapshot();
                const refreshRequested = this.refreshCheckRequested;
                this.refreshCheckRequested = false;
                if (refreshRequested) {
                    this.pendingBaseSnapshot ||= this.snapshot;
                    this.snapshot = next;
                    const difference = diffRegexSnapshots(this.pendingBaseSnapshot, this.snapshot);
                    if (difference.changes.length || difference.reordered || difference.scopeChanged || difference.moved) this.markDirty();
                } else {
                    this.snapshot = next;
                }
            } catch (error) {
                console.debug(LOG_PREFIX, '正则状态检查失败', error);
            }
        }, delay);
    }

    markDirty() {
        this.dirty = true;
        clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => {
            if (!this.started || this.isGenerating() || document.querySelector('.regex_editor')) {
                this.markDirty();
                return;
            }
            const before = this.pendingBaseSnapshot;
            const after = this.snapshot;
            this.pendingBaseSnapshot = null;
            void this.reapply({ automatic: true, before, after });
        }, 650);
    }

    getDisplayedMessages() {
        const root = document.querySelector('#chat');
        const elements = root?.querySelectorAll('.mes[mesid]') || [];
        const messages = [];
        for (let index = 0; index < elements.length; index++) {
            const element = elements[index];
            const messageId = Number(element.getAttribute('mesid'));
            if (!Number.isInteger(messageId) || !this.chat[messageId]) continue;
            messages.push({ element, messageId, recent: index >= elements.length - 5 });
        }
        return { root, messages };
    }

    getDescriptors({ root, messages } = this.getDisplayedMessages()) {
        if (!messages.length) return [];
        const rootRect = root.getBoundingClientRect();
        return prioritizeMessageDescriptors(messages.map(descriptor => {
            const rect = descriptor.element.getBoundingClientRect();
            return { ...descriptor, visible: rect.bottom >= rootRect.top && rect.top <= rootRect.bottom };
        }));
    }

    getMessageSources(messages) {
        return messages.map(({ messageId }) => ({
            id: messageId,
            text: String(this.chat[messageId]?.mes || ''),
            placement: this.chat[messageId]?.is_user ? 1 : 2,
        }));
    }

    measureBatchLead({ element }) {
        return estimateRenderComplexity({
            domNodes: element.querySelectorAll('*').length,
            htmlLength: element.innerHTML.length,
            richElements: element.querySelectorAll('details, table, pre, svg, iframe').length,
        });
    }

    async reapply({ automatic = false, before = null, after = null } = {}) {
        if (this.refreshing) return { skipped: true };
        if (this.isGenerating()) return { skipped: true };
        const chatId = this.getCurrentChatId();
        const generation = this.generation;
        const job = this.refreshJob = new AbortController();
        const isCurrent = () => generation === this.generation
            && chatId === this.getCurrentChatId() && !this.isGenerating();
        this.refreshing = true;
        this.dirty = false;
        clearTimeout(this.flushTimer);
        const startedAt = performance.now();
        let completed = 0;
        let failed = 0;
        let plan = { mode: 'all', targetIds: [], reason: 'manual' };
        try {
            let api = null;
            try {
                api = await this.importChatApi();
            } catch (error) {
                console.debug(LOG_PREFIX, '局部消息接口加载失败', error);
            }
            if (!isCurrent()) return { cancelled: true, completed, failed };
            if (typeof api?.updateMessageBlock !== 'function') {
                this.onStatus?.('chat', '局部刷新接口不可用');
                return {
                    completed,
                    failed: failed + 1,
                    unavailable: true,
                    elapsedMs: performance.now() - startedAt,
                    ...plan,
                };
            }
            let displayed;
            if (automatic) {
                displayed = this.getDisplayedMessages();
                if (!displayed.messages.length) return { completed: 0, failed: 0, elapsedMs: 0, mode: 'none' };
                plan = planRegexRefresh({
                    before,
                    after,
                    messages: this.getMessageSources(displayed.messages),
                    compileRegex: this.compileRegex,
                });
                if (plan.mode === 'none' || (plan.mode === 'matched' && !plan.targetIds.length)) {
                    this.onStatus?.('chat', '自动');
                    return { completed: 0, failed: 0, elapsedMs: performance.now() - startedAt, ...plan };
                }
            }
            if (plan.mode === 'matched') {
                const targets = new Set(plan.targetIds);
                displayed.messages = displayed.messages.filter(({ messageId }) => targets.has(messageId));
            }
            const descriptors = this.getDescriptors(displayed);
            if (!descriptors.length) return { completed: 0, failed: 0, elapsedMs: 0, mode: 'none' };
            let batch = 4;
            let previousFrameMs = 0;
            for (let cursor = 0; cursor < descriptors.length;) {
                await this.scheduler.yield(descriptors[cursor].visible ? 0 : (descriptors[cursor].recent ? 1 : 2), job.signal);
                if (!isCurrent()) return { cancelled: true, completed, failed };
                const frameStart = performance.now();
                const updateEvents = [];
                batch = getAdaptiveBatchSize({
                    complexity: this.measureBatchLead(descriptors[cursor]),
                    previousFrameMs,
                    currentBatch: batch,
                });
                for (let count = 0; cursor < descriptors.length && count < batch; count += 1, cursor += 1) {
                    const descriptor = descriptors[cursor];
                    try {
                        api.updateMessageBlock(descriptor.messageId, this.chat[descriptor.messageId], { rerenderMessage: true });
                        if (this.eventTypes?.MESSAGE_UPDATED) {
                            updateEvents.push({
                                messageId: descriptor.messageId,
                                promise: Promise.resolve().then(() => this.eventSource?.emit?.(
                                    this.eventTypes.MESSAGE_UPDATED,
                                    descriptor.messageId,
                                )),
                            });
                        }
                    } catch (error) {
                        failed += 1;
                        console.debug(LOG_PREFIX, '局部刷新消息失败', descriptor.messageId, error);
                    }
                    completed += 1;
                    if (performance.now() - frameStart >= 11) {
                        cursor += 1;
                        break;
                    }
                }
                const eventResults = await Promise.allSettled(updateEvents.map(item => item.promise));
                eventResults.forEach((result, index) => {
                    if (result.status === 'fulfilled') return;
                    failed += 1;
                    console.debug(LOG_PREFIX, '消息更新事件失败', updateEvents[index].messageId, result.reason);
                });
                previousFrameMs = performance.now() - frameStart;
            }
            this.onStatus?.('chat', failed ? `${failed} 条刷新失败` : '自动');
            return { completed, failed, elapsedMs: performance.now() - startedAt, automatic, ...plan };
        } catch (error) {
            if (error?.name === 'AbortError') return { cancelled: true, completed, failed };
            failed += 1;
            this.onStatus?.('chat', `${failed} 条刷新失败`);
            console.debug(LOG_PREFIX, '精准消息刷新中断', error);
            if (!automatic) throw error;
            return { completed, failed, elapsedMs: performance.now() - startedAt, ...plan };
        } finally {
            this.refreshJob = null;
            this.refreshing = false;
            if (this.started && this.dirty) this.markDirty();
        }
    }

    stop() {
        this.generation += 1;
        this.refreshJob?.abort();
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
        this.refreshCheckRequested = false;
        this.snapshot = null;
        this.pendingBaseSnapshot = null;
        this.engine = null;
        this.compileRegex = null;
    }
}
