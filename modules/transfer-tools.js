import { TransferDrag } from '../utils/transfer-drag.js';
import { ContentTransferService, NativeTransferRepository, fingerprint } from './content-transfer.js';

const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
};
const button = (text, action) => {
    const element = node('button', text, 'menu_button');
    element.type = 'button';
    element.dataset.claTransferAction = action;
    return element;
};

export class TransferTools {
    constructor({ scriptApi, isGenerating = () => false, onRegexSaved = () => {}, loadApis = () => Promise.all([
        import('../../../../world-info.js'), import('../../../../preset-manager.js'), import('../../../../popup.js'),
    ]) } = {}) {
        Object.assign(this, { scriptApi, isGenerating, onRegexSaved, loadApis });
        this.started = false;
        this.generation = 0;
        this.busy = false;
        this.onClick = this.onClick.bind(this);
        this.onKey = event => {
            if (event.target?.closest?.('#cla-transfer-menu') && ['Enter', ' '].includes(event.key)) {
                event.preventDefault(); this.onClick(event);
            }
        };
    }

    start() {
        if (this.started) return;
        this.started = true;
        document.addEventListener('click', this.onClick);
        document.addEventListener('keydown', this.onKey);
        this.observer = new MutationObserver(records => {
            if (records.some(record => [...record.addedNodes].some(item => item.matches?.('#extensionsMenu') || item.querySelector?.('#extensionsMenu')))) this.mount();
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
        this.mount();
    }

    mount() {
        if (!this.started || document.getElementById('cla-transfer-menu')) return;
        const menu = document.getElementById('extensionsMenu');
        if (!menu) return;
        const item = node('div', undefined, 'list-group-item flex-container flexGap5 interactable');
        item.id = 'cla-transfer-menu'; item.tabIndex = 0;
        item.setAttribute('role', 'button');
        item.append(node('i', undefined, 'fa-solid fa-copy'), node('span', '世界书 / 正则转移'));
        menu.append(item);
        this.menu = item;
    }

    onClick(event) {
        if (event.target?.closest?.('#cla-transfer-menu')) { event.preventDefault(); void this.open(); }
    }

    async open() {
        if (!this.started || this.opening || this.view) return;
        this.opening = true;
        const generation = this.generation;
        try {
            const [worldApi, presetApi, popupApi] = await this.loadApis();
            if (!this.started || generation !== this.generation) return;
            this.popupApi = popupApi;
            this.repository = new NativeTransferRepository({ scriptApi: this.scriptApi, worldApi, presetApi });
            this.service = new ContentTransferService(this.repository);
            this.createView();
            const popup = new popupApi.Popup(this.view, popupApi.POPUP_TYPE.TEXT, '', {
                wide: true, large: true, okButton: '关闭',
                onClose: () => { this.dragger?.destroy(); this.dragger = null; this.generation++; this.view = null; this.loadSequence++; this.targetLoadSequence++; },
            });
            this.popup = popup;
            this.chooseKind();
            await popup.show();
        } catch (error) {
            globalThis.toastr?.error?.(error.message || '转移工具暂时不可用', '云酒馆加速器');
            this.view = null;
        } finally { this.opening = false; }
    }

    createView() {
        this.selected = new Set(); this.items = []; this.targetItems = []; this.loadSequence = 0; this.targetLoadSequence = 0; this.needsReview = false;
        const view = node('div', undefined, 'cla-transfer-tool');
        this.view = view;
        view.append(node('h3', '世界书 / 正则转移'));
        const fields = node('div', undefined, 'cla-transfer-fields');
        const field = (title, name, options = []) => {
            const label = node('label', title);
            const select = node('select', undefined, 'text_pole');
            select.dataset.claTransferField = name;
            for (const [value, text] of options) { const option = node('option', text); option.value = value; select.append(option); }
            label.append(select); fields.append(label); return select;
        };
        this.kind = field('内容类型', 'kind', [['world', '世界书条目'], ['character', '角色正则'], ['preset', '预设正则']]);
        this.source = field('来源', 'source'); this.target = field('目标', 'target');
        this.operation = field('操作', 'operation', [['copy', '复制（保留来源）'], ['move', '移动（从来源移除）']]);
        this.hint = node('p', '拖动左侧 ⠿ 到右侧，或勾选后点按钮。副本使用新 ID；移动先保存目标，再移除来源。', 'cla-transfer-hint');
        view.append(fields, this.hint);
        this.search = node('input', undefined, 'text_pole'); this.search.type = 'search';
        this.search.placeholder = '搜索来源（更改搜索会清空选择）';
        this.search.setAttribute('aria-label', this.search.placeholder);
        this.search.dataset.claTransferSourceSearch = '';
        const actions = node('div', undefined, 'cla-transfer-actions');
        this.executeButton = button('复制所选（0）', 'execute');
        this.reloadButton = button('重新加载两侧', 'reload');
        this.refreshButton = button('刷新酒馆', 'refresh'); this.refreshButton.hidden = true;
        actions.append(button('全选当前结果', 'all'), button('清空选择', 'clear'), this.reloadButton, this.executeButton, this.refreshButton);
        this.status = node('p', '', 'cla-transfer-status'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
        const columns = node('div', undefined, 'cla-transfer-columns');
        this.leftPane = node('section', undefined, 'cla-transfer-pane');
        this.rightPane = node('section', undefined, 'cla-transfer-pane');
        this.list = node('div', undefined, 'cla-transfer-list cla-transfer-source-list');
        this.targetList = node('div', undefined, 'cla-transfer-list cla-transfer-target-list');
        this.targetSearch = node('input', undefined, 'text_pole'); this.targetSearch.type = 'search';
        this.targetSearch.placeholder = '搜索目标已有内容'; this.targetSearch.setAttribute('aria-label', this.targetSearch.placeholder);
        this.targetSearch.dataset.claTransferTargetSearch = '';
        this.sourceCount = node('small', '', 'cla-transfer-count'); this.targetCount = node('small', '', 'cla-transfer-count');
        this.dropzone = node('div', undefined, 'cla-transfer-dropzone');
        this.dropHint = node('div', '← 将左侧条目拖到这里', 'cla-transfer-drop-hint');
        this.dropzone.append(this.dropHint, this.targetList);
        this.leftPane.append(this.source.parentElement, this.search, this.sourceCount, this.list);
        this.rightPane.append(this.target.parentElement, this.targetSearch, this.targetCount, this.dropzone);
        columns.append(this.leftPane, this.rightPane);
        view.append(actions, columns, this.status);
        this.dragger = new TransferDrag({ root: view, dropzone: this.dropzone,
            valid: () => this.started && this.view === view && view.isConnected && !this.busy && !this.loading
                && !this.targetLoading && !this.needsReview && !!this.sourceData && !!this.targetData && this.source.value !== this.target.value,
            getIds: id => this.selected.has(id) ? [...this.selected] : [id],
            onDrop: ids => { this.selected = new Set(ids); this.renderItems(); void this.execute(); },
        });
        this.kind.addEventListener('change', () => this.chooseKind());
        this.source.addEventListener('change', () => { this.dragger.cancel(); this.excludeSource(); void this.reloadPanels(); });
        this.target.addEventListener('change', () => { this.dragger.cancel(); void this.loadTarget(); });
        this.operation.addEventListener('change', () => { this.dragger.cancel(); this.updateControls(); });
        this.search.addEventListener('input', () => { this.dragger.cancel(); this.selected.clear(); this.renderItems(); });
        this.targetSearch.addEventListener('input', () => this.renderTarget());
        view.addEventListener('change', event => {
            if (!event.target.matches('[data-cla-transfer-select]')) return;
            const id = event.target.dataset.claTransferSelect;
            if (event.target.checked) this.selected.add(id); else this.selected.delete(id);
            this.updateControls();
        });
        view.addEventListener('click', event => {
            const action = event.target.closest('[data-cla-transfer-action]')?.dataset.claTransferAction;
            if (!action || this.busy) return;
            if (action === 'execute') { void this.execute(); return; }
            if (action === 'reload') { void this.reloadPanels(); return; }
            if (action === 'refresh') { globalThis.location.reload(); return; }
            if (action === 'all') for (const item of this.filtered()) this.selected.add(item.id);
            if (action === 'clear') this.selected.clear();
            this.renderItems();
        });
    }

    chooseKind() {
        if (!this.view || this.busy) return;
        this.refs = this.repository.list(this.kind.value);
        for (const select of [this.source, this.target]) {
            select.replaceChildren();
            for (const ref of this.refs) { const option = node('option', ref.label); option.value = ref.id; select.append(option); }
        }
        const current = this.kind.value === 'character' ? this.scriptApi.characters?.[this.scriptApi.this_chid]?.avatar
            : this.kind.value === 'world' ? this.repository.worldApi.world_names?.[Number(document.getElementById('world_editor_select')?.value)]
                : JSON.stringify([this.scriptApi.main_api === 'koboldhorde' ? 'kobold' : this.scriptApi.main_api,
                    this.repository.presetApi.getPresetManager()?.getSelectedPresetName()]);
        if (this.refs.some(ref => ref.id === current)) this.source.value = current;
        this.excludeSource();
        this.refreshButton.hidden = true;
        this.dragger.cancel();
        void this.reloadPanels();
    }

    excludeSource() {
        for (const option of this.target.options) option.disabled = option.value === this.source.value;
        if (this.target.value === this.source.value) this.target.value = this.refs.find(ref => ref.id !== this.source.value)?.id || '';
    }

    async reloadPanels(message = '') {
        await Promise.all([this.loadSource(message), this.loadTarget()]);
    }

    async loadTarget() {
        if (!this.view || this.busy) return;
        const sequence = ++this.targetLoadSequence, view = this.view;
        this.targetData = null; this.targetItems = []; this.targetLoading = true;
        this.targetSearch.value = ''; this.renderTarget(); this.updateControls();
        const ref = this.refs.find(ref => ref.id === this.target.value);
        try {
            if (!ref) return;
            const data = await this.repository.read(ref);
            if (sequence !== this.targetLoadSequence || view !== this.view) return;
            this.targetData = data;
            this.targetItems = this.kind.value === 'world' ? Object.entries(data.entries).map(([id, value]) => ({ id, value }))
                : data.map(value => ({ id: String(value.id), value }));
        } catch (error) {
            if (sequence === this.targetLoadSequence && view === this.view) this.status.textContent = error.message;
        } finally {
            if (sequence === this.targetLoadSequence && view === this.view) {
                this.targetLoading = false; this.renderTarget(); this.updateControls();
            }
        }
    }

    itemBody(id, value) {
        const body = node('span', undefined, 'cla-transfer-item-body');
        body.append(node('strong', value.comment || value.scriptName || `条目 ${id}`),
            node('small', `ID: ${id}`), node('span', String(value.content ?? value.findRegex ?? '').slice(0, 160), 'cla-transfer-preview'));
        return body;
    }

    renderTarget() {
        const query = this.targetSearch.value.toLocaleLowerCase().trim();
        this.targetCount.textContent = this.targetLoading ? '正在读取…' : `已有 ${this.targetItems.length} 项`;
        this.dropHint.textContent = this.operation.value === 'move' ? '← 拖到这里移动，松开后确认' : '← 拖到这里复制，松开后确认';
        const previous = this.targetRendered;
        if (previous?.items === this.targetItems && previous.query === query && previous.loading === this.targetLoading
            && previous.ready === Boolean(this.targetData) && previous.list === this.targetList) return;
        this.targetRendered = { items: this.targetItems, query, loading: this.targetLoading, ready: Boolean(this.targetData), list: this.targetList };
        this.targetList.replaceChildren();
        for (const { id, value } of this.targetItems.filter(item => !query || JSON.stringify(item.value).toLocaleLowerCase().includes(query))) {
            const row = node('div', undefined, 'cla-transfer-item cla-transfer-target-item');
            row.dataset.claTransferTargetId = id; row.append(this.itemBody(id, value)); this.targetList.append(row);
        }
        if (!this.targetItems.length && !this.targetLoading) this.targetList.append(node('p', this.targetData ? '目标为空，可以拖入条目' : '请选择其他目标'));
    }

    async loadSource(message = '') {
        if (!this.view || this.busy) return;
        const sequence = ++this.loadSequence, view = this.view;
        this.selected.clear(); this.items = []; this.sourceData = null; this.needsReview = false;
        this.search.value = ''; this.loading = true; this.renderItems(); this.status.textContent = '正在读取来源…';
        const ref = this.refs.find(ref => ref.id === this.source.value);
        try {
            if (!ref) throw new Error('没有可用来源，请先创建世界书、角色或预设');
            const data = await this.repository.read(ref);
            if (sequence !== this.loadSequence || view !== this.view) return;
            this.sourceData = data;
            this.items = this.kind.value === 'world' ? Object.entries(data.entries).map(([id, value]) => ({ id, value }))
                : data.map(value => ({ id: String(value.id), value }));
            if (new Set(this.items.map(item => item.id)).size !== this.items.length || this.items.some(item => !item.id || item.id === 'undefined')) throw new Error('来源含缺失或重复 ID，请先在原生编辑器修复');
            this.status.textContent = message || `共 ${this.items.length} 项，请选择要转移的内容。`;
        } catch (error) {
            if (sequence !== this.loadSequence || view !== this.view) return;
            this.sourceData = null; this.items = [];
            this.status.textContent = error.message;
        } finally {
            if (sequence === this.loadSequence && view === this.view) { this.loading = false; this.renderItems(); }
        }
    }

    filtered() {
        const query = this.search.value.toLocaleLowerCase().trim();
        return this.items.filter(item => !query || JSON.stringify(item.value).toLocaleLowerCase().includes(query));
    }

    renderItems() {
        this.list.replaceChildren();
        for (const { id, value } of this.filtered()) {
            const label = node('label', undefined, 'cla-transfer-item');
            const input = node('input'); input.type = 'checkbox'; input.dataset.claTransferSelect = id;
            input.checked = this.selected.has(id); input.disabled = this.busy;
            const handle = button('⠿'); delete handle.dataset.claTransferAction;
            handle.className = 'cla-transfer-drag-handle'; handle.dataset.claTransferDrag = id;
            handle.setAttribute('aria-label', `拖动${value.comment || value.scriptName || '条目'}到右侧；也可勾选后使用转移按钮`);
            label.append(input, this.itemBody(id, value), handle); this.list.append(label);
        }
        if (!this.items.length && !this.loading) this.list.append(node('p', '此来源没有可转移的内容。'));
        this.sourceCount.textContent = `共 ${this.items.length} 项 · 已选 ${this.selected.size}`;
        this.updateControls();
    }

    updateControls() {
        const ready = !!this.sourceData && !!this.targetData && this.refs.length > 1 && this.target.value && this.source.value !== this.target.value;
        for (const input of this.view.querySelectorAll('button, select, input')) input.disabled = this.busy;
        this.executeButton.textContent = `${this.operation.value === 'move' ? '移动' : '复制'}所选（${this.selected.size}）`;
        this.executeButton.disabled = this.busy || this.loading || this.targetLoading || this.needsReview || !ready || !this.selected.size;
        this.reloadButton.disabled = this.busy || !this.source.value;
        this.sourceCount.textContent = `共 ${this.items.length} 项 · 已选 ${this.selected.size}`;
        for (const handle of this.view.querySelectorAll('[data-cla-transfer-drag]')) handle.disabled = this.busy || this.loading || this.targetLoading || this.needsReview || !ready;
        this.renderTarget();
    }

    async execute() {
        if (this.busy || this.executeButton.disabled || !this.view) return;
        if (this.isGenerating()) { this.status.textContent = '请等待生成结束后再转移'; return; }
        const view = this.view, generation = this.generation, kind = this.kind.value;
        const source = this.refs.find(ref => ref.id === this.source.value), target = this.refs.find(ref => ref.id === this.target.value);
        const move = this.operation.value === 'move';
        const valid = () => this.started && this.view === view && view.isConnected && this.generation === generation
            && this.source.value === source.id && this.target.value === target.id && this.kind.value === kind && !this.isGenerating();
        this.busy = true; this.updateControls();
        this.status.textContent = '正在检查来源与目标…';
        try {
            const job = await this.service.prepare(kind, source, target, [...this.selected]);
            if (fingerprint(job.sourceData) !== fingerprint(this.sourceData)) throw new Error('来源已更改，请重新加载后选择');
            if (fingerprint(job.targetData) !== fingerprint(this.targetData)) throw new Error('目标已更改，请重新加载两侧后操作');
            if (!valid()) return;
            const content = node('p', `将选中的 ${job.ids.length} 项${move ? '移动' : '复制'}：\n来源：${source.label}\n目标：${target.label}\n${move ? '目标保存成功后才移除来源。' : '来源内容保留。'}目标已有内容不会被覆盖。`);
            content.style.whiteSpace = 'pre-wrap';
            const confirmed = await this.popupApi.Popup.show.confirm(null, content, { okButton: move ? '移动所选' : '复制所选', cancelButton: '取消' });
            if (confirmed !== (this.popupApi.POPUP_RESULT?.AFFIRMATIVE ?? 1)) { this.status.textContent = '已取消，所选内容保留。'; return; }
            const result = await this.service.execute(job, { move, valid });
            this.selected.clear();
            if (kind !== 'world') {
                this.onRegexSaved();
                this.refreshButton.hidden = false;
            }
            const message = `已${result.moved ? '移动' : '复制'} ${result.count} 项到“${target.label}”。`
                + (kind === 'world' ? '' : '正则启用权限沿用目标设置；刷新酒馆可更新原生正则列表显示。');
            if (valid()) { this.busy = false; await this.reloadPanels(message); }
            else globalThis.toastr?.success?.(message, '云酒馆加速器');
        } catch (error) {
            const message = error.targetSaved ? `目标已经保存。来源移除未完成或未确认，请检查来源后再操作：${error.message}`
                : `操作未完成，来源未主动移除；目标若有网络异常请先检查再重试：${error.message}`;
            if (this.view === view) {
                this.status.textContent = message;
                this.needsReview = true;
                if (error.targetSaved) this.selected.clear();
            } else globalThis.toastr?.warning?.(message, '云酒馆加速器');
        } finally {
            this.busy = false;
            if (this.view === view) this.updateControls();
        }
    }

    stop() {
        this.started = false; this.generation++;
        this.dragger?.destroy(); this.dragger = null;
        this.observer?.disconnect(); this.observer = null;
        document.removeEventListener('click', this.onClick);
        document.removeEventListener('keydown', this.onKey);
        this.menu?.remove(); this.menu = null;
        this.view?.remove(); this.view = null;
        void this.popup?.complete?.(0);
        this.popup = null;
    }
}
