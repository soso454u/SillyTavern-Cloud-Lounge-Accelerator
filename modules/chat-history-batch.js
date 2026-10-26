const ROW = '.select_chat_block[file_name]';
// Native history/search already supplies names without the storage extension.
const fileId = name => String(name || '');

function button(label, action) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'menu_button';
    node.textContent = label;
    node.dataset.claChatAction = action;
    return node;
}

// Enhances only the native history list; chat contents are never loaded or edited.
export class ChatHistoryBatchActions {
    constructor({ scriptApi, loadApis = () => Promise.all([
        import('../../../../group-chats.js'), import('../../../../popup.js'),
    ]), fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
        this.scriptApi = scriptApi;
        this.loadApis = loadApis;
        this.fetchImpl = fetchImpl;
        this.started = false;
        this.generation = 0;
        this.mode = false;
        this.busy = false;
        this.selected = new Set();
        this.root = null;
        this.toolbar = null;
        this.list = null;
        this.scope = null;
        this.timer = null;
        this.onClick = this.onClick.bind(this);
        this.onChange = this.onChange.bind(this);
        this.onInput = event => {
            if (event.target?.id === 'select_chat_search') {
                this.generation++;
                this.selected.clear();
                this.refresh();
            }
        };
        this.onChatChanged = () => { this.generation++; this.mode = false; this.selected.clear(); this.scheduleRefresh(); };
    }

    async start() {
        if (this.started) return;
        const generation = ++this.generation;
        try {
            const [groupApi, popupApi] = await this.loadApis();
            if (generation !== this.generation) return;
            this.groupApi = groupApi;
            this.popupApi = popupApi;
        } catch (error) {
            console.debug('[Cloud Lounge Accelerator] 聊天批量操作不可用', error);
            return;
        }
        this.started = true;
        document.addEventListener('click', this.onClick, true);
        document.addEventListener('change', this.onChange, true);
        document.addEventListener('input', this.onInput, true);
        const event = this.scriptApi.event_types?.CHAT_CHANGED;
        if (event) this.scriptApi.eventSource?.on(event, this.onChatChanged);
        this.observer = new MutationObserver(records => {
            if (records.some(record => {
                const target = record.target;
                if (target?.closest?.('#chat, .cla-chat-batch-toolbar, .cla-chat-batch-choice')) return false;
                const nodes = [...record.addedNodes, ...record.removedNodes];
                if (nodes.length && nodes.every(node => node.matches?.('.cla-chat-batch-toolbar, .cla-chat-batch-choice'))) return false;
                return target?.closest?.('#select_chat_popup') || nodes.some(node =>
                    node.matches?.('#select_chat_popup') || node.querySelector?.('#select_chat_popup'));
            })) this.scheduleRefresh();
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
        this.refresh();
    }

    getScope() {
        const groupId = this.groupApi?.selected_group;
        if (groupId) {
            const group = this.groupApi.groups?.find(item => String(item.id) === String(groupId));
            return group && Array.isArray(group.chats) ? { key: `group:${groupId}`, group } : null;
        }
        const character = this.scriptApi.characters?.[this.scriptApi.this_chid];
        return character?.avatar ? { key: `character:${character.avatar}`, character, avatar: character.avatar } : null;
    }

    sameScope(scope) {
        const current = this.getScope();
        return Boolean(scope && current?.key === scope.key
            && current.character === scope.character && current.group === scope.group);
    }

    isActive(name, scope = this.getScope()) {
        return fileId(name) === fileId(scope?.group?.chat_id ?? scope?.character?.chat);
    }

    rows() { return [...(this.list?.querySelectorAll(ROW) || [])]; }

    scheduleRefresh() {
        if (!this.started || this.timer !== null) return;
        this.timer = setTimeout(() => { this.timer = null; this.refresh(); }, 0);
    }

    refresh() {
        if (!this.started) return;
        const root = document.getElementById('select_chat_popup');
        const list = root?.querySelector('#select_chat_div');
        if (root !== this.root || list !== this.list) {
            this.removeUi();
            this.root = root;
            this.list = list;
            this.mode = false;
            this.selected.clear();
        }
        if (!root || !list) return;
        const scope = this.getScope();
        if (!this.sameScope(this.scope)) { this.selected.clear(); this.mode = false; }
        this.scope = scope;
        if (!this.toolbar?.isConnected) {
            this.toolbar = document.createElement('div');
            this.toolbar.className = 'cla-chat-batch-toolbar';
            this.toolbar.append(button('批量操作', 'toggle'), button('全选当前结果', 'all'),
                button('清空选择', 'clear'), button('删除所选', 'delete'));
            const status = document.createElement('span');
            status.className = 'cla-chat-batch-status';
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            this.toolbar.append(status);
            list.before(this.toolbar);
        }
        const names = new Set(this.rows().map(row => row.getAttribute('file_name')));
        for (const name of this.selected) if (!names.has(name) || this.isActive(name, scope)) this.selected.delete(name);
        list.classList.toggle('cla-chat-batch-mode', this.mode);
        for (const row of this.rows()) {
            const name = row.getAttribute('file_name');
            const active = this.isActive(name, scope);
            let label = row.querySelector('.cla-chat-batch-choice');
            if (this.mode && !label) {
                label = document.createElement('label');
                label.className = 'cla-chat-batch-choice';
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.dataset.claChatSelect = '';
                input.setAttribute('aria-label', `选择聊天：${name}`);
                const hint = document.createElement('span');
                hint.textContent = active ? '当前聊天' : '选择';
                label.append(input, hint);
                row.prepend(label);
            }
            if (label) {
                label.hidden = !this.mode;
                label.title = active ? '当前打开的聊天不参与批量删除，请先切换到其他聊天' : name;
                label.querySelector('input').checked = this.selected.has(name);
                label.querySelector('input').disabled = this.busy || active || !scope;
                label.querySelector('span').textContent = active ? '当前聊天' : '选择';
            }
            row.classList.toggle('cla-chat-batch-selected', this.mode && this.selected.has(name));
        }
        for (const control of this.toolbar.querySelectorAll('button')) {
            const action = control.dataset.claChatAction;
            control.hidden = action !== 'toggle' && !this.mode;
            control.disabled = this.busy || !scope || (action === 'delete' && !this.selected.size);
            if (action === 'toggle') control.textContent = this.mode ? '退出批量' : '批量操作';
            if (action === 'delete') control.textContent = `删除所选（${this.selected.size}）`;
        }
        this.toolbar.querySelector('[role="status"]').textContent = this.busy
            ? this.progress || '等待确认…'
            : this.mode ? `已选 ${this.selected.size} 条 · 当前聊天受保护，搜索后重新选择` : '';
    }

    onClick(event) {
        const target = event.target;
        if (target?.closest?.('#select_chat_cross')) {
            this.generation++;
            this.mode = false;
            this.selected.clear();
            this.refresh();
            return;
        }
        const control = target?.closest?.('[data-cla-chat-action]');
        if (control && this.toolbar?.contains(control)) {
            event.preventDefault(); event.stopImmediatePropagation();
            if (this.busy || control.disabled) return;
            const action = control.dataset.claChatAction;
            if (action === 'toggle') { this.generation++; this.mode = !this.mode; this.selected.clear(); }
            if (action === 'clear') this.selected.clear();
            if (action === 'all') for (const row of this.rows()) {
                const name = row.getAttribute('file_name');
                if (name && !this.isActive(name)) this.selected.add(name);
            }
            if (action === 'delete') { void this.deleteSelected(); return; }
            this.refresh();
            return;
        }
        if (!this.mode || !this.list?.contains(target)) return;
        // Let the checkbox's default activation run, but keep native row/open/delete handlers out.
        event.stopImmediatePropagation();
        if (target.closest?.('.cla-chat-batch-choice')) return;
        event.preventDefault();
        const row = target.closest?.(ROW);
        const name = row?.getAttribute('file_name');
        if (!this.busy && name && !this.isActive(name)) {
            if (this.selected.has(name)) this.selected.delete(name); else this.selected.add(name);
            this.refresh();
        }
    }

    onChange(event) {
        if (!event.target?.matches?.('[data-cla-chat-select]') || !this.list?.contains(event.target)) return;
        event.stopImmediatePropagation();
        const name = event.target.closest(ROW)?.getAttribute('file_name');
        if (!this.busy && name && !this.isActive(name) && event.target.checked) this.selected.add(name);
        else this.selected.delete(name);
        this.refresh();
    }

    async deleteSelected() {
        if (this.busy || !this.started) return;
        this.refresh();
        const scope = this.scope;
        const names = [...this.selected];
        if (!scope || !names.length) return;
        const generation = this.generation, list = this.list;
        const activeChat = this.scriptApi.getCurrentChatId?.();
        const valid = () => this.started && this.generation === generation && list?.isConnected
            && this.list === list && this.mode && this.sameScope(scope)
            && this.root?.checkVisibility?.() !== false
            && this.scriptApi.getCurrentChatId?.() === activeChat;
        this.busy = true;
        this.progress = '';
        this.refresh();
        let completed = 0, failed = 0, stopped = false;
        try {
            const confirmed = await this.popupApi.Popup.show.confirm('批量删除聊天记录',
                `<p>确定删除选中的 <strong>${names.length}</strong> 条聊天记录？删除后无法撤销。</p><p>当前打开的聊天不会被删除。</p>`,
                { okButton: '删除所选', cancelButton: '取消' });
            if (confirmed !== (this.popupApi.POPUP_RESULT?.AFFIRMATIVE ?? 1)) return;
            if (this.scriptApi.isGenerating?.()) throw new Error('正在生成，请结束生成后再批量删除');
            for (let index = 0; index < names.length; index++) {
                const name = names[index];
                if (!valid() || this.scriptApi.isGenerating?.()) { stopped = true; break; }
                if (this.isActive(name, scope)) { stopped = true; break; }
                this.progress = `正在删除 ${index + 1}/${names.length} · 已成功 ${completed} 条`;
                if (this.toolbar) this.toolbar.querySelector('[role="status"]').textContent = this.progress;
                try {
                    // Freeze the target identity in the request, never infer it from live selection.
                    const response = await this.fetchImpl(scope.group ? '/api/chats/group/delete' : '/api/chats/delete', {
                        method: 'POST', headers: this.scriptApi.getRequestHeaders(),
                        body: JSON.stringify(scope.group ? { id: fileId(name) }
                            : { chatfile: `${fileId(name)}.jsonl`, avatar_url: scope.avatar }),
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                } catch (error) {
                    failed++;
                    console.debug('[Cloud Lounge Accelerator] 聊天删除未确认', error);
                    // A transport error can be ambiguous; leave this and all unattempted rows intact.
                    stopped = true;
                    break;
                }
                completed++;
                if (scope.group) scope.group.chats = scope.group.chats.filter(id => fileId(id) !== fileId(name));
                if (this.list === list && this.sameScope(scope)) {
                    this.selected.delete(name);
                    for (const row of this.rows()) if (row.getAttribute('file_name') === name) {
                        (row.closest('.select_chat_block_wrapper') || row).remove();
                    }
                }
                const event = this.scriptApi.event_types?.[scope.group ? 'GROUP_CHAT_DELETED' : 'CHAT_DELETED'];
                if (event) {
                    try { await this.scriptApi.eventSource?.emit(event, fileId(name)); }
                    catch (error) { console.debug('[Cloud Lounge Accelerator] 删除通知失败', error); }
                }
            }
            const remaining = names.length - completed;
            const message = `已删除 ${completed} 条聊天记录${remaining ? `，剩余 ${remaining} 条未删除${failed ? '（请求失败）' : stopped ? '（操作已停止）' : ''}` : ''}`;
            globalThis.toastr?.[remaining ? 'warning' : 'success']?.(message, '云酒馆加速器');
        } catch (error) {
            globalThis.toastr?.error?.(error instanceof Error ? error.message : String(error), '批量删除聊天');
        } finally {
            // Group history belongs to group metadata as well as its individual chat files.
            if (scope.group && completed) {
                try {
                    const response = await this.fetchImpl('/api/groups/edit', {
                        method: 'POST', headers: this.scriptApi.getRequestHeaders(), body: JSON.stringify(scope.group),
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                } catch (error) {
                    console.debug('[Cloud Lounge Accelerator] 群聊列表保存失败', error);
                    globalThis.toastr?.error?.('聊天文件已删除，但群聊列表未保存成功，请刷新后检查', '批量删除聊天');
                }
            }
            this.busy = false;
            this.progress = '';
            this.refresh();
        }
    }

    removeUi() {
        this.toolbar?.remove();
        this.toolbar = null;
        this.list?.classList.remove('cla-chat-batch-mode');
        for (const row of this.rows()) {
            row.querySelector('.cla-chat-batch-choice')?.remove();
            row.classList.remove('cla-chat-batch-selected');
        }
    }

    stop() {
        this.started = false;
        this.generation++;
        this.mode = false;
        clearTimeout(this.timer);
        this.timer = null;
        this.observer?.disconnect();
        this.observer = null;
        document.removeEventListener('click', this.onClick, true);
        document.removeEventListener('change', this.onChange, true);
        document.removeEventListener('input', this.onInput, true);
        const event = this.scriptApi.event_types?.CHAT_CHANGED;
        if (event) this.scriptApi.eventSource?.removeListener(event, this.onChatChanged);
        this.removeUi();
        this.root = this.list = this.scope = null;
        this.selected.clear();
    }
}
