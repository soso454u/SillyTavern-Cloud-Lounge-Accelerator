import { PressSweepSelection } from '../utils/press-sweep-selection.js';
import { TransferDrag } from '../utils/transfer-drag.js';
import { ContentTransferService, NativeTransferRepository, fingerprint, editTransferEntry, transferCollection, transferScopeKey } from './content-transfer.js';

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
    constructor({ scriptApi, extensionSettings = {}, isGenerating = () => false, onRegexSaved = () => {}, loadApis = () => Promise.all([
        import('../../../../world-info.js'), import('../../../../preset-manager.js'), import('../../../../popup.js'),
    ]) } = {}) {
        Object.assign(this, { scriptApi, extensionSettings, isGenerating, onRegexSaved, loadApis });
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
                onClose: () => { this.nameSelection?.destroy(); this.nameSelection = null; this.dragger?.destroy(); this.dragger = null; this.generation++; this.view = null; this.loadSequence++; this.targetLoadSequence++; },
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
        this.selected = new Set(); this.items = []; this.targetItems = []; this.loadSequence = 0; this.targetLoadSequence = 0; this.needsReview = false; this.groupOpen = new Map();
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
        this.kind = field('来源类型', 'kind', [['world', '世界书条目'], ['character', '角色正则'], ['preset', '预设正则']]);
        this.targetKind = field('目标类型', 'target-kind');
        this.source = field('来源', 'source'); this.target = field('目标', 'target');
        this.operation = field('操作', 'operation', [['copy', '复制（保留来源）'], ['move', '移动（从来源移除）']]);
        this.hint = node('p', '按住名称划选多项，拖动 ⠿ 到右侧。点眼睛查看/编辑；移动先保存目标，再移除来源。', 'cla-transfer-hint');
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
        this.leftPane.append(this.kind.parentElement, this.source.parentElement, this.search, this.sourceCount, this.list);
        this.rightPane.append(this.targetKind.parentElement, this.target.parentElement, this.targetSearch, this.targetCount, this.dropzone);
        columns.append(this.leftPane, this.rightPane);
        view.append(actions, columns, this.status);
        this.dragger = new TransferDrag({ root: view, dropzone: this.dropzone,
            valid: () => this.started && this.view === view && view.isConnected && !this.busy && !this.loading
                && !this.targetLoading && !this.editing && !this.previewLoading && !this.needsReview && !!this.sourceData && !!this.targetData && this.source.value !== this.target.value,
            getIds: (id, handle) => handle.dataset.claTransferGroup !== undefined
                ? this.filtered().filter(item => this.groupName(item, 'source') === handle.dataset.claTransferGroup).map(item => item.id)
                : this.selected.has(id) ? [...this.selected] : [id],
            onDrop: ids => { this.selected = new Set(ids); this.renderItems(); void this.execute(); },
        });
        this.nameSelection = new PressSweepSelection({ root: view,
            nameSelector: '.cla-transfer-source-list .cla-transfer-item-name', rowSelector: '.cla-transfer-item',
            getRows: () => [...this.list.querySelectorAll('.cla-transfer-item')].filter(row => row.checkVisibility?.() !== false),
            valid: () => this.started && this.view === view && !this.busy && !this.loading && !this.previewLoading && !this.editing,
            context: () => JSON.stringify([this.kind.value, this.source.value, this.loadSequence]),
            isSelected: row => this.selected.has(row.dataset.claTransferId),
            setSelected: (row, selected) => { const id = row.dataset.claTransferId; if (selected) this.selected.add(id); else this.selected.delete(id); },
            onChange: () => this.updateSelectionChecks(),
        });
        this.targetKind.addEventListener('change', () => { this.cancelGestures(); this.populateTargets(); void this.loadTarget(); });
        this.kind.addEventListener('change', () => this.chooseKind());
        this.source.addEventListener('change', () => { this.cancelGestures(); this.excludeSource(); void this.reloadPanels(); });
        this.target.addEventListener('change', () => { this.cancelGestures(); void this.loadTarget(); });
        this.operation.addEventListener('change', () => { this.cancelGestures(); this.updateControls(); });
        this.search.addEventListener('input', () => { this.cancelGestures(); this.selected.clear(); this.renderItems(); });
        this.targetSearch.addEventListener('input', () => this.renderTarget());
        view.addEventListener('change', event => {
            if (event.target.matches('[data-cla-transfer-select-group]')) {
                const name = event.target.dataset.claTransferSelectGroup;
                for (const item of this.filtered().filter(item => this.groupName(item, 'source') === name)) {
                    if (event.target.checked) this.selected.add(item.id); else this.selected.delete(item.id);
                }
                this.updateSelectionChecks(); return;
            }
            if (!event.target.matches('[data-cla-transfer-select]')) return;
            const id = event.target.dataset.claTransferSelect;
            if (event.target.checked) this.selected.add(id); else this.selected.delete(id);
            this.updateSelectionChecks();
        });
        view.addEventListener('click', event => {
            const eye = event.target.closest('[data-cla-transfer-view]');
            if (eye) { event.preventDefault(); event.stopPropagation(); void this.openEntry(eye.dataset.claTransferSide, eye.dataset.claTransferView); return; }
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

    cancelGestures() { this.nameSelection?.cancel(); this.dragger?.cancel(); }
    refsFor(side) { return side === 'source' ? this.sourceRefs : this.targetRefs; }
    refFor(side) { return this.refsFor(side)?.find(ref => ref.id === (side === 'source' ? this.source.value : this.target.value)); }
    populateTargets() {
        const previous = this.target.value;
        this.targetRefs = this.repository.list(this.targetKind.value);
        this.target.replaceChildren();
        for (const ref of this.targetRefs) { const option = node('option', ref.label); option.value = ref.id; this.target.append(option); }
        if (this.targetRefs.some(ref => ref.id === previous)) this.target.value = previous;
        this.excludeSource();
    }
    chooseKind() {
        if (!this.view || this.busy) return;
        this.cancelGestures();
        this.sourceRefs = this.repository.list(this.kind.value);
        this.source.replaceChildren();
        for (const ref of this.sourceRefs) { const option = node('option', ref.label); option.value = ref.id; this.source.append(option); }
        const current = this.kind.value === 'character' ? this.scriptApi.characters?.[this.scriptApi.this_chid]?.avatar
            : this.kind.value === 'world' ? this.repository.worldApi.world_names?.[Number(document.getElementById('world_editor_select')?.value)]
                : JSON.stringify([this.scriptApi.main_api === 'koboldhorde' ? 'kobold' : this.scriptApi.main_api,
                    this.repository.presetApi.getPresetManager()?.getSelectedPresetName()]);
        if (this.sourceRefs.some(ref => ref.id === current)) this.source.value = current;
        const previous = this.targetKind.value;
        this.targetKind.replaceChildren();
        for (const [value, title] of this.kind.value === 'world' ? [['world','世界书条目']] : [['character','角色正则'],['preset','预设正则']]) {
            const option = node('option', title); option.value = value; this.targetKind.append(option);
        }
        this.targetKind.value = this.kind.value === 'world' ? 'world' : ['character','preset'].includes(previous) ? previous : this.kind.value;
        this.populateTargets(); this.refreshButton.hidden = true;
        void this.reloadPanels();
    }
    excludeSource() {
        for (const option of this.target.options) option.disabled = this.kind.value === this.targetKind.value && option.value === this.source.value;
        if (this.kind.value === this.targetKind.value && this.target.value === this.source.value) this.target.value = this.targetRefs.find(ref => ref.id !== this.source.value)?.id || '';
    }
    async reloadPanels(message = '', preserveSelection = false) {
        await Promise.all([this.loadSource(message, preserveSelection), this.loadTarget()]);
    }

    async loadTarget() {
        if (!this.view || this.busy) return;
        const sequence = ++this.targetLoadSequence, view = this.view;
        this.targetData = null; this.targetItems = []; this.targetLoading = true;
        this.targetSearch.value = ''; this.renderTarget(); this.updateControls();
        const ref = this.refFor('target');
        try {
            if (!ref) return;
            const data = await this.repository.read(ref);
            if (sequence !== this.targetLoadSequence || view !== this.view) return;
            this.targetData = data;
            this.targetItems = ref.kind === 'world' ? Object.entries(data.entries).map(([id, value]) => ({ id, value }))
                : data.map(value => ({ id: String(value.id), value }));
        } catch (error) {
            if (sequence === this.targetLoadSequence && view === this.view) this.status.textContent = error.message;
        } finally {
            if (sequence === this.targetLoadSequence && view === this.view) {
                this.targetLoading = false; this.renderTarget(); this.updateControls();
            }
        }
    }

    groupName(item, side) { return transferCollection(this.refFor(side), item.value, this.extensionSettings); }
    renderItem(item, side) {
        const { id, value } = item;
        const row = node('div', undefined, 'cla-transfer-item'); row.dataset.claTransferId = id;
        if (side === 'target') row.dataset.claTransferTargetId = id;
        if (side === 'source') {
            const input = node('input'); input.type = 'checkbox'; input.dataset.claTransferSelect = id; input.checked = this.selected.has(id);
            input.setAttribute('aria-label', `选择：${value.comment || value.scriptName || id}`); row.append(input);
        } else row.append(node('span', '', 'cla-transfer-item-spacer'));
        const name = node('span', value.comment || value.scriptName || `条目 ${id}`, 'cla-transfer-item-name');
        name.title = name.textContent; row.append(name);
        const eye = button('', undefined); delete eye.dataset.claTransferAction;
        eye.className = 'cla-transfer-eye'; eye.dataset.claTransferView = id; eye.dataset.claTransferSide = side;
        eye.title = '查看 / 编辑内容'; eye.setAttribute('aria-label', `${eye.title}：${name.textContent}`);
        eye.append(node('i', undefined, 'fa-solid fa-eye')); row.append(eye);
        if (side === 'source') {
            const handle = button('⠿'); delete handle.dataset.claTransferAction;
            handle.className = 'cla-transfer-drag-handle'; handle.dataset.claTransferDrag = id;
            handle.setAttribute('aria-label', `拖动${name.textContent}或已选多项到右侧`); row.append(handle);
        } else row.append(node('span', '', 'cla-transfer-drag-spacer'));
        return row;
    }
    renderList(list, items, side) {
        list.replaceChildren();
        if (this.refFor(side)?.kind === 'world') { for (const item of items) list.append(this.renderItem(item, side)); return; }
        const groups = new Map();
        for (const item of items) { const name = this.groupName(item, side); if (!groups.has(name)) groups.set(name, []); groups.get(name).push(item); }
        for (const [name, members] of groups) {
            const details = node('details', undefined, 'cla-transfer-group'); details.dataset.claTransferCollection = name;
            const key = JSON.stringify([side, this.refFor(side)?.id, name]); details.open = this.groupOpen.get(key) !== false;
            details.addEventListener('toggle', () => this.groupOpen.set(key, details.open));
            const summary = node('summary');
            if (side === 'source') {
                const input = node('input'); input.type = 'checkbox'; input.dataset.claTransferSelectGroup = name;
                input.setAttribute('aria-label', `选择整个分组：${name}`);
                input.addEventListener('click', event => event.stopPropagation()); summary.append(input);
            } else summary.append(node('span', '', 'cla-transfer-item-spacer'));
            summary.append(node('span', `${name}（${members.length}）`, 'cla-transfer-group-name'));
            if (side === 'source') {
                const handle = button('⠿'); delete handle.dataset.claTransferAction; handle.className = 'cla-transfer-drag-handle';
                handle.dataset.claTransferDrag = ''; handle.dataset.claTransferGroup = name;
                handle.setAttribute('aria-label', `拖动整个分组：${name}`); summary.append(handle);
            }
            details.append(summary); for (const item of members) details.append(this.renderItem(item, side)); list.append(details);
        }
    }
    updateSelectionChecks() {
        for (const input of this.list.querySelectorAll('[data-cla-transfer-select]')) input.checked = this.selected.has(input.dataset.claTransferSelect);
        for (const input of this.list.querySelectorAll('[data-cla-transfer-select-group]')) {
            const members = this.filtered().filter(item => this.groupName(item, 'source') === input.dataset.claTransferSelectGroup);
            const count = members.filter(item => this.selected.has(item.id)).length;
            input.checked = !!members.length && count === members.length; input.indeterminate = count > 0 && count < members.length;
        }
        this.updateControls();
    }
    renderTarget() {
        const query = this.targetSearch.value.toLocaleLowerCase().trim();
        this.targetCount.textContent = this.targetLoading ? '正在读取…' : `已有 ${this.targetItems.length} 项`;
        this.dropHint.textContent = this.operation.value === 'move' ? '← 拖到这里移动，松开后确认' : '← 拖到这里复制，松开后确认';
        const previous = this.targetRendered;
        if (previous?.items === this.targetItems && previous.query === query && previous.loading === this.targetLoading
            && previous.ready === Boolean(this.targetData) && previous.list === this.targetList) return;
        this.targetRendered = { items: this.targetItems, query, loading: this.targetLoading, ready: Boolean(this.targetData), list: this.targetList };
        this.renderList(this.targetList, this.targetItems.filter(item => !query || JSON.stringify(item.value).toLocaleLowerCase().includes(query)), 'target');
        if (!this.targetItems.length && !this.targetLoading) this.targetList.append(node('p', this.targetData ? '目标为空，可以拖入条目' : '请选择其他目标'));
    }

    async loadSource(message = '', preserveSelection = false) {
        if (!this.view || this.busy) return;
        const sequence = ++this.loadSequence, view = this.view;
        const previousSelection = preserveSelection ? new Set(this.selected) : new Set();
        const previousSearch = preserveSelection ? this.search.value : '';
        this.selected.clear(); this.items = []; this.sourceData = null; this.needsReview = false;
        this.search.value = ''; this.loading = true; this.renderItems(); this.status.textContent = '正在读取来源…';
        const ref = this.refFor('source');
        try {
            if (!ref) throw new Error('没有可用来源，请先创建世界书、角色或预设');
            const data = await this.repository.read(ref);
            if (sequence !== this.loadSequence || view !== this.view) return;
            this.sourceData = data;
            this.items = this.kind.value === 'world' ? Object.entries(data.entries).map(([id, value]) => ({ id, value }))
                : data.map(value => ({ id: String(value.id), value }));
            if (new Set(this.items.map(item => item.id)).size !== this.items.length || this.items.some(item => !item.id || item.id === 'undefined')) throw new Error('来源含缺失或重复 ID，请先在原生编辑器修复');
            this.selected = new Set(this.items.filter(item => previousSelection.has(item.id)).map(item => item.id));
            this.search.value = previousSearch;
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
        this.renderList(this.list, this.filtered(), 'source');
        if (!this.items.length && !this.loading) this.list.append(node('p', '此来源没有可转移的内容。'));
        this.updateSelectionChecks();
    }

    updateControls() {
        const ready = !!this.sourceData && !!this.targetData && !!this.refFor('source') && !!this.refFor('target') && (this.kind.value !== this.targetKind.value || this.source.value !== this.target.value);
        const locked = this.busy || this.editing || this.previewLoading;
        for (const input of this.view.querySelectorAll('button, select, input')) input.disabled = locked;
        this.executeButton.textContent = `${this.operation.value === 'move' ? '移动' : '复制'}所选（${this.selected.size}）`;
        this.executeButton.disabled = locked || this.loading || this.targetLoading || this.needsReview || !ready || !this.selected.size;
        this.reloadButton.disabled = locked || !this.source.value;
        this.sourceCount.textContent = `共 ${this.items.length} 项 · 已选 ${this.selected.size}`;
        for (const handle of this.view.querySelectorAll('[data-cla-transfer-drag]')) handle.disabled = locked || this.loading || this.targetLoading || this.needsReview || !ready;
        this.renderTarget();
    }

    saveTransferGroups(job, result) {
        if (job.kind === 'world') return;
        const key = transferScopeKey(job.target);
        const states = this.extensionSettings.cloud_lounge_accelerator_regex_collections || {};
        const sourceAssignments = states[transferScopeKey(job.source)]?.assignments || {};
        const selected = new Set(job.ids);
        const originals = job.sourceData.filter(item => selected.has(String(item.id)));
        const assignments = {};
        for (let i = 0; i < originals.length; i++) if (Object.hasOwn(sourceAssignments, originals[i].id)) {
            Object.defineProperty(assignments, result.created[i], { value: transferCollection(job.source, originals[i], this.extensionSettings), enumerable: true });
        }
        if (!Object.keys(assignments).length) return;
        const previous = states[key] || {};
        this.extensionSettings.cloud_lounge_accelerator_regex_collections = { ...states, [key]: {
            ...previous, groups: [...new Set([...(previous.groups || []), ...Object.values(assignments).filter(name => name !== '未分类')])],
            assignments: { ...previous.assignments, ...assignments },
        } };
        this.scriptApi.saveSettingsDebounced?.();
    }

    async openEntry(side, id) {
        if (!this.view || this.busy || this.editing || this.previewLoading) return;
        this.cancelGestures();
        const view = this.view, generation = this.generation, ref = this.refFor(side);
        if (!ref) return;
        const valid = () => this.started && this.view === view && this.generation === generation
            && this.refFor(side)?.kind === ref.kind && this.refFor(side)?.id === ref.id;
        this.previewLoading = true; this.updateControls();
        try {
            const data = await this.repository.read(ref);
            if (!valid()) return;
            const entry = ref.kind === 'world' ? data.entries[id] : data.find(item => String(item.id) === id);
            if (!entry) throw new Error('条目已不存在，请重新加载两侧');
            const editor = node('div', undefined, 'cla-transfer-editor');
            editor.append(node('h3', '查看 / 编辑内容'), node('small', `${side === 'source' ? '来源' : '目标'}：${ref.label}`));
            const field = (title, name, value, multiline = false) => {
                const label = node('label', title), input = node(multiline ? 'textarea' : 'input', undefined, 'text_pole');
                input.dataset.claTransferEdit = name; input.value = value || '';
                if (multiline) input.rows = name === 'content' || name === 'replaceString' ? 12 : 4;
                label.append(input); editor.append(label); return input;
            };
            const name = field('条目名称', 'name', entry.comment ?? entry.scriptName ?? '');
            const content = ref.kind === 'world' ? field('条目内容', 'content', entry.content, true) : null;
            const find = ref.kind !== 'world' ? field('查找正则', 'findRegex', entry.findRegex, true) : null;
            const replace = ref.kind !== 'world' ? field('替换内容', 'replaceString', entry.replaceString, true) : null;
            const status = node('p', '', 'cla-transfer-status'); status.setAttribute('role', 'status'); editor.append(status);
            let saved = false, saving = false;
            this.editing = true;
            const popup = new this.popupApi.Popup(editor, this.popupApi.POPUP_TYPE.CONFIRM, '', {
                wide: true, large: true, okButton: '保存', cancelButton: '取消',
                onClosing: async popup => {
                    if (saving) return false;
                    if (popup.result !== (this.popupApi.POPUP_RESULT?.AFFIRMATIVE ?? 1)) return true;
                    if (!valid()) return true;
                    if (this.isGenerating()) { status.textContent = '请等待生成结束后再保存'; return false; }
                    let next;
                    try { next = editTransferEntry(ref.kind, data, id, { name: name.value,
                        ...(content ? { content: content.value } : { findRegex: find.value, replaceString: replace.value }) }); }
                    catch (error) { status.textContent = error.message; return false; }
                    if (fingerprint(next) === fingerprint(data)) return true;
                    saving = true; status.textContent = '正在保存…';
                    try {
                        if (fingerprint(await this.repository.read(ref)) !== fingerprint(data)) throw new Error('内容已在其他位置更改，请取消后重新打开；本次草稿仍保留');
                        if (!valid()) return true;
                        await this.repository.beforeWrite({ kind: ref.kind });
                        if (!valid()) return true;
                        await this.repository.write(ref, next, data);
                        saved = true; return true;
                    } catch (error) { status.textContent = `保存未完成或未确认：${error.message}`; return !valid(); }
                    finally { saving = false; }
                },
                onClose: async () => {
                    this.editorPopup = null; this.editing = false;
                    if (!valid()) return;
                    if (saved) {
                        if (ref.kind !== 'world') { this.onRegexSaved(); this.refreshButton.hidden = false; }
                        await this.reloadPanels('内容已保存，勾选状态保留。', true);
                    }
                    this.updateControls();
                },
            });
            this.editorPopup = popup; this.updateControls();
            await popup.show();
        } catch (error) { if (valid()) this.status.textContent = error.message; }
        finally {
            this.previewLoading = false;
            if (this.view === view) this.updateControls();
        }
    }

    async execute() {
        if (this.busy || this.executeButton.disabled || !this.view) return;
        if (this.isGenerating()) { this.status.textContent = '请等待生成结束后再转移'; return; }
        const view = this.view, generation = this.generation, kind = this.kind.value;
        const source = this.refFor('source'), target = this.refFor('target');
        const move = this.operation.value === 'move';
        const valid = () => this.started && this.view === view && view.isConnected && this.generation === generation
            && this.source.value === source.id && this.target.value === target.id && this.targetKind.value === target.kind && this.kind.value === kind && !this.isGenerating();
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
            this.saveTransferGroups(job, result);
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
        this.nameSelection?.destroy(); this.nameSelection = null;
        this.dragger?.destroy(); this.dragger = null;
        void this.editorPopup?.complete?.(0);
        this.observer?.disconnect(); this.observer = null;
        document.removeEventListener('click', this.onClick);
        document.removeEventListener('keydown', this.onKey);
        this.menu?.remove(); this.menu = null;
        this.view?.remove(); this.view = null;
        void this.popup?.complete?.(0);
        this.popup = null;
    }
}
