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

function recordsOnlyAffectChat(records) {
    return records.length > 0 && records.every(record => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        return Boolean(target?.closest?.('#chat'));
    });
}

export class RegexRefreshController {
    constructor({ chat, eventSource, eventTypes, reloadCurrentChat, scheduler, onStatus = null }) {
        this.chat = chat;
        this.eventSource = eventSource;
        this.eventTypes = eventTypes;
        this.reloadCurrentChat = reloadCurrentChat;
        this.scheduler = scheduler;
        this.onStatus = onStatus;
        this.started = false;
        this.engine = null;
        this.compileRegex = null;
        this.snapshot = null;
        this.pendingBaseSnapshot = null;
        this.editorWasOpen = false;
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
        try {
            const [engine, utils] = await Promise.all([
                import('../../../regex/engine.js'),
                import('../../../../utils.js'),
            ]);
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
            if (recordsOnlyAffectChat(records)) return;
            const editorOpen = Boolean(document.querySelector('.regex_editor'));
            if (this.editorWasOpen && !editorOpen) this.queueSnapshotCheck(250, false);
            this.editorWasOpen = editorOpen;
            const listChanged = records.some(record => {
                const target = record.target instanceof Element ? record.target : record.target.parentElement;
                return Boolean(target?.closest?.('#saved_regex_scripts, #saved_scoped_scripts, #saved_preset_scripts'));
            });
            if (listChanged) this.queueSnapshotCheck(350, false);
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
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
            if (!this.started || document.querySelector('.regex_editor')) {
                this.markDirty();
                return;
            }
            const before = this.pendingBaseSnapshot;
            const after = this.snapshot;
            this.pendingBaseSnapshot = null;
            void this.reapply({ automatic: true, before, after });
        }, 650);
    }

    getDescriptors(targetIds = null) {
        const root = document.querySelector('#chat');
        if (!root) return [];
        const targets = targetIds ? new Set(targetIds) : null;
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
        }).filter(item => Number.isInteger(item.messageId)
            && this.chat[item.messageId]
            && (!targets || targets.has(item.messageId))));
    }

    getMessageSources(descriptors) {
        return descriptors.map(({ messageId }) => ({
            id: messageId,
            text: String(this.chat[messageId]?.mes || ''),
            placement: this.chat[messageId]?.is_user ? 1 : 2,
        }));
    }

    async reapply({ automatic = false, before = null, after = null } = {}) {
        if (this.refreshing) return { skipped: true };
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
                api = await import('../../../../../script.js');
            } catch (error) {
                console.debug(LOG_PREFIX, '局部消息接口加载失败', error);
            }
            if (typeof api?.updateMessageBlock !== 'function') {
                await this.reloadCurrentChat();
                this.onStatus?.('chat', '已回退完整刷新');
                return {
                    completed,
                    failed: failed + 1,
                    fallback: true,
                    elapsedMs: performance.now() - startedAt,
                    ...plan,
                };
            }
            const displayed = this.getDescriptors();
            if (!displayed.length) return { completed: 0, failed: 0, elapsedMs: 0, mode: 'none' };
            if (automatic) {
                plan = planRegexRefresh({
                    before,
                    after,
                    messages: this.getMessageSources(displayed),
                    compileRegex: this.compileRegex,
                });
                if (plan.mode === 'none' || (plan.mode === 'matched' && !plan.targetIds.length)) {
                    this.onStatus?.('chat', '自动');
                    return { completed: 0, failed: 0, elapsedMs: performance.now() - startedAt, ...plan };
                }
            }
            const descriptors = plan.mode === 'matched' ? this.getDescriptors(plan.targetIds) : displayed;
            let batch = 4;
            let previousFrameMs = 0;
            for (let cursor = 0; cursor < descriptors.length;) {
                await this.scheduler.yield(descriptors[cursor].visible ? 0 : (descriptors[cursor].recent ? 1 : 2));
                const frameStart = performance.now();
                const updateEvents = [];
                batch = getAdaptiveBatchSize({
                    complexity: descriptors[cursor].complexity,
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
        this.snapshot = null;
        this.pendingBaseSnapshot = null;
        this.engine = null;
        this.compileRegex = null;
    }
}
