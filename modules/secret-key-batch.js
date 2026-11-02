const ROOT = '.secretKeyManager';
const ROW = '.secretKeyManagerItem';
const OWN = '.cla-secret-batch-toolbar, .cla-secret-batch-choice';
const idOf = row => row?.querySelector('[data-action="delete-secret"][data-id]')?.dataset.id;

function button(label, action) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'menu_button menu_button_icon';
    node.textContent = label;
    node.dataset.claSecretAction = action;
    return node;
}

// Keep native deletion, CSRF, state refresh, reconnection and SECRET_DELETED
// notifications together. Never read/copy the actual secret values.
export class SecretKeyBatchActions {
    constructor({ loadApis = () => Promise.all([
        import('../../../../secrets.js'), import('../../../../popup.js'),
    ]) } = {}) {
        this.loadApis = loadApis;
        this.started = false;
        this.generation = 0;
        this.mode = false;
        this.busy = false;
        this.selected = new Set();
        this.root = this.list = this.toolbar = null;
        this.key = null;
        this.timer = null;
        this.onClick = this.onClick.bind(this);
        this.onChange = this.onChange.bind(this);
    }

    async start() {
        if (this.started) return;
        const generation = ++this.generation;
        try {
            const [secretApi, popupApi] = await this.loadApis();
            if (generation !== this.generation) return;
            if (typeof secretApi.deleteSecret !== 'function' || !secretApi.SECRET_KEYS
                || !secretApi.secret_state || typeof popupApi.Popup?.show?.confirm !== 'function') return;
            this.secretApi = secretApi;
            this.popupApi = popupApi;
        } catch (error) {
            console.debug('[Cloud Lounge Accelerator] 密钥批量操作不可用', error);
            return;
        }
        this.started = true;
        document.addEventListener('click', this.onClick, true);
        document.addEventListener('change', this.onChange, true);
        this.observer = new MutationObserver(records => {
            if (records.some(record => [...record.removedNodes].some(node =>
                node === this.root || (this.root && node.contains?.(this.root))))) {
                this.generation++;
                this.mode = false;
                this.selected.clear();
            }
            if (records.some(record => {
                if (record.target?.closest?.(OWN)) return false;
                const nodes = [...record.addedNodes, ...record.removedNodes];
                if (nodes.length && nodes.every(node => node.matches?.(OWN))) return false;
                return record.target?.closest?.(ROOT) || nodes.some(node =>
                    node.matches?.(ROOT) || node.querySelector?.(ROOT));
            })) this.scheduleRefresh();
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
        this.refresh();
    }

    rows() { return [...(this.list?.querySelectorAll(ROW) || [])]; }

    getKey(root = this.root) {
        const key = root?.querySelector('.secretKeyManagerInfo code')?.textContent?.trim();
        return Object.values(this.secretApi?.SECRET_KEYS || {}).includes(key) ? key : null;
    }

    scheduleRefresh() {
        if (!this.started || this.timer !== null) return;
        this.timer = setTimeout(() => { this.timer = null; this.refresh(); }, 0);
    }

    refresh() {
        if (!this.started) return;
        const root = [...document.querySelectorAll(ROOT)].at(-1) || null;
        const list = root?.querySelector('.secretKeyManagerList') || null;
        const key = this.getKey(root);
        if (root !== this.root || list !== this.list || key !== this.key) {
            this.generation++;
            this.removeUi();
            this.root = root;
            this.list = list;
            this.key = key;
            this.mode = false;
            this.selected.clear();
        }
        if (!root || !list || !key) return;
        if (!this.toolbar?.isConnected) {
            this.toolbar = document.createElement('div');
            this.toolbar.className = 'cla-secret-batch-toolbar';
            this.toolbar.append(button('批量删除', 'toggle'), button('全选', 'all'),
                button('清空选择', 'clear'), button('删除所选', 'delete'));
            const status = document.createElement('span');
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            this.toolbar.append(status);
            // The header stays visible above the independently scrolling list.
            (root.querySelector('.secretKeyManagerHeader') || list).append(this.toolbar);
        }
        const rows = this.rows();
        const ids = new Set(rows.map(idOf).filter(Boolean));
        for (const id of this.selected) if (!ids.has(id)) this.selected.delete(id);
        root.classList.toggle('cla-secret-batch-mode', this.mode);
        for (const row of rows) {
            const id = idOf(row);
            let label = row.querySelector('.cla-secret-batch-choice');
            if (this.mode && id && !label) {
                label = document.createElement('label');
                label.className = 'cla-secret-batch-choice';
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.dataset.claSecretSelect = '';
                input.setAttribute('aria-label', `选择密钥：${row.querySelector('strong')?.textContent || id}`);
                const text = document.createElement('span');
                text.textContent = '选择';
                label.append(input, text);
                (row.querySelector('.secretKeyManagerItemInfo') || row).prepend(label);
            }
            if (label) {
                label.hidden = !this.mode;
                label.querySelector('input').checked = this.selected.has(id);
                label.querySelector('input').disabled = this.busy;
            }
            row.classList.toggle('cla-secret-batch-selected', this.mode && this.selected.has(id));
        }
        for (const control of this.toolbar.querySelectorAll('button')) {
            const action = control.dataset.claSecretAction;
            control.hidden = action !== 'toggle' && !this.mode;
            control.disabled = this.busy || (action === 'delete' && !this.selected.size)
                || (action === 'all' && !ids.size);
            if (action === 'toggle') {
                control.textContent = this.mode ? '退出批量' : '批量删除';
                control.setAttribute('aria-expanded', String(this.mode));
            }
            if (action === 'delete') control.textContent = `删除所选（${this.selected.size}）`;
        }
        const message = this.busy ? this.progress || '等待确认…' : this.mode ? `已选 ${this.selected.size} 个密钥` : '';
        const status = this.toolbar.querySelector('[role="status"]');
        if (status.textContent !== message) status.textContent = message;
    }

    onClick(event) {
        const target = event.target;
        const control = target?.closest?.('[data-cla-secret-action]');
        if (control && this.toolbar?.contains(control)) {
            event.preventDefault(); event.stopImmediatePropagation();
            if (this.busy || control.disabled) return;
            const action = control.dataset.claSecretAction;
            if (action === 'toggle') { this.generation++; this.mode = !this.mode; this.selected.clear(); }
            if (action === 'clear') this.selected.clear();
            if (action === 'all') for (const row of this.rows()) { const id = idOf(row); if (id) this.selected.add(id); }
            if (action === 'delete') { void this.deleteSelected(); return; }
            this.refresh();
            return;
        }
        if (!this.mode || !this.root?.contains(target)) return;
        // Native add/select/copy/rename/delete remain available outside batch
        // mode. During selection they must not race the confirmed deletion queue.
        if (target.closest?.('[data-action]')) {
            event.preventDefault(); event.stopImmediatePropagation();
            return;
        }
        if (!this.list?.contains(target)) return;
        event.stopImmediatePropagation();
        if (target.closest?.('.cla-secret-batch-choice')) return;
        event.preventDefault();
        const id = idOf(target.closest?.(ROW));
        if (!this.busy && id) {
            if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
            this.refresh();
        }
    }

    onChange(event) {
        if (!event.target?.matches?.('[data-cla-secret-select]') || !this.list?.contains(event.target)) return;
        event.stopImmediatePropagation();
        const id = idOf(event.target.closest(ROW));
        if (!this.busy && id) {
            if (event.target.checked) this.selected.add(id); else this.selected.delete(id);
        }
        this.refresh();
    }

    async deleteSelected() {
        if (this.busy || !this.started) return;
        this.refresh();
        const { root, list, key, generation } = this;
        const targets = this.rows().filter(row => this.selected.has(idOf(row))).map(row => ({ row, id: idOf(row) }));
        if (!key || !targets.length) return;
        const active = () => {
            const secrets = this.secretApi.secret_state?.[key];
            return Array.isArray(secrets) ? secrets.find(secret => secret.active)?.id : undefined;
        };
        let activeId = active();
        const valid = () => this.started && this.mode && this.generation === generation
            && root.isConnected && list.isConnected && root === this.root && list === this.list
            && root.checkVisibility?.() !== false && this.getKey(root) === key && active() === activeId;
        this.busy = true;
        this.progress = '';
        this.refresh();
        let completed = 0, failed = false;
        try {
            // Pass text as a DOM node without a header: native Popup's header
            // overload would interpolate arbitrary labels/key names as HTML.
            const content = document.createElement('div');
            content.textContent = `确定删除 ${key} 中选中的 ${targets.length} 个密钥？删除后无法撤销。`
                + (targets.some(target => target.id === activeId) ? '所选包含当前使用的密钥，删除后酒馆会重新连接 API。' : '');
            const confirmed = await this.popupApi.Popup.show.confirm(null, content, { okButton: '删除所选', cancelButton: '取消' });
            if (confirmed !== (this.popupApi.POPUP_RESULT?.AFFIRMATIVE ?? 1)) return;
            for (const { row, id } of targets) {
                if (!valid() || !list.contains(row) || idOf(row) !== id) break;
                const before = this.secretApi.secret_state;
                if (!Array.isArray(before[key]) || !before[key].some(secret => secret.id === id)) break;
                this.progress = `正在删除 ${completed + 1}/${targets.length}`;
                this.refresh();
                try {
                    await this.secretApi.deleteSecret(key, id);
                    const after = this.secretApi.secret_state;
                    // Native deleteSecret swallows HTTP/network/read errors and
                    // returns void. Only a fresh state with this ID absent proves
                    // deletion; never optimistically remove unconfirmed rows.
                    if (!after || after === before || (after[key] !== undefined && !Array.isArray(after[key]))
                        || after[key]?.some(secret => secret.id === id)) throw new Error('密钥删除未确认');
                } catch {
                    failed = true;
                    break;
                }
                completed++;
                activeId = active();
                if (this.root === root && this.list === list && this.getKey(root) === key) {
                    this.selected.delete(id);
                    row.remove();
                    this.syncNativeRows();
                }
            }
            const remaining = targets.length - completed;
            globalThis.toastr?.[remaining ? 'warning' : 'success']?.(
                `已删除 ${completed} 个密钥${remaining ? `，剩余 ${remaining} 个未完成${failed ? '（删除未确认，请刷新列表后检查）' : '（操作已停止）'}` : ''}`,
                '云酒馆加速器');
        } catch {
            globalThis.toastr?.error?.('批量删除未完成，请刷新密钥列表后检查', '云酒馆加速器');
        } finally {
            this.busy = false;
            this.progress = '';
            this.refresh();
        }
    }

    syncNativeRows() {
        const state = this.secretApi.secret_state?.[this.key];
        const secrets = Array.isArray(state) ? state : [];
        for (const row of this.rows()) {
            const active = Boolean(secrets.find(secret => secret.id === idOf(row))?.active);
            row.classList.toggle('active', active);
            row.querySelector('[data-action="rotate-secret"]')?.classList.toggle('disabled', active);
        }
        const empty = this.root?.querySelector('.secretKeyManagerListEmpty');
        if (empty) empty.style.display = this.rows().length ? 'none' : '';
    }

    removeUi() {
        this.toolbar?.remove();
        this.toolbar = null;
        this.root?.classList.remove('cla-secret-batch-mode');
        for (const row of this.rows()) {
            row.querySelector('.cla-secret-batch-choice')?.remove();
            row.classList.remove('cla-secret-batch-selected');
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
        this.removeUi();
        this.root = this.list = this.key = null;
        this.selected.clear();
    }
}
