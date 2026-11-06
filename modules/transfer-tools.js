import { ensureTransferEditorStyles } from '../utils/transfer-editor-style.js';
import { PressSweepSelection } from '../utils/press-sweep-selection.js';
import { TransferDrag } from '../utils/transfer-drag.js';
import { ContentTransferService, NativeTransferRepository, fingerprint, editTransferEntry, deleteTransferEntries, transferCollection, transferScopeKey } from './content-transfer.js';

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

// Theme tints may be translucent. The expanded editor always uses an opaque
// surface, including themes that make every native popup transparent.
function editorSurface(element) {
    const style = getComputedStyle(element), canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    const sample = color => {
        context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
        return context.getImageData(0, 0, 1, 1).data;
    };
    const text = sample(style.color), tint = sample(style.getPropertyValue('--SmartThemeBlurTintColor').trim() || 'transparent');
    if (tint[3] > 0) return `rgb(${tint[0]}, ${tint[1]}, ${tint[2]})`;
    return text[0] * 0.299 + text[1] * 0.587 + text[2] * 0.114 > 128 ? '#20242c' : '#edf1f5';
}

const expandIcon = (collapse = false) => {
    const control = node('button', undefined, 'cla-transfer-expand'); control.type = 'button';
    control.title = collapse ? '收起编辑' : '放大编辑'; control.setAttribute('aria-label', control.title);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', collapse ? 'M3 9h6V3m12 6h-6V3M3 15h6v6m12-6h-6v6' : 'M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6');
    svg.append(path); control.append(svg); return control;
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
        this.selected = new Set(); this.targetSelected = new Set(); this.activeSide = 'source'; this.items = []; this.targetItems = []; this.loadSequence = 0; this.targetLoadSequence = 0; this.needsReview = false; this.groupOpen = new Map();
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
        this.hint = node('p', '点击名称变色选择，按住划选多项；两侧均可拖动 ⠿ 到对面，点眼睛编辑。移动先保存目标，再移除来源。', 'cla-transfer-hint');
        view.append(fields, this.hint);
        this.search = node('input', undefined, 'text_pole'); this.search.type = 'search';
        this.search.placeholder = '搜索来源（更改搜索会清空选择）';
        this.search.setAttribute('aria-label', this.search.placeholder);
        this.search.dataset.claTransferSourceSearch = '';
        const actions = node('div', undefined, 'cla-transfer-actions');
        this.executeButton = button('复制所选（0）', 'execute');
        this.reloadButton = button('重新加载两侧', 'reload');
        this.refreshButton = button('刷新酒馆', 'refresh'); this.refreshButton.hidden = true;
        this.deleteButton = button('删除所选（0）', 'delete');
        actions.append(button('全选当前结果', 'all'), button('清空选择', 'clear'), this.reloadButton, this.executeButton, this.deleteButton, this.refreshButton);
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
        this.leftPane.dataset.claTransferPane = 'source'; this.rightPane.dataset.claTransferPane = 'target';
        for (const [pane, side] of [[this.leftPane, 'source'], [this.rightPane, 'target']]) {
            const activate = button(side === 'source' ? '操作左侧 →' : '← 操作右侧', 'activate');
            activate.addEventListener('click', () => { this.activeSide = side; this.updateSelectionChecks(); });
            pane.append(activate);
        }
        this.leftPane.append(this.kind.parentElement, this.source.parentElement, this.search, this.sourceCount, this.list);
        this.rightPane.append(this.targetKind.parentElement, this.target.parentElement, this.targetSearch, this.targetCount, this.dropzone);
        columns.append(this.leftPane, this.rightPane);
        view.append(actions, columns, this.status);
        this.dragger = new TransferDrag({ root: view, dropzone: handle => handle.dataset.claTransferSide === 'target' ? this.list : this.dropzone,
            valid: () => this.started && this.view === view && view.isConnected && !this.busy && !this.loading
                && !this.targetLoading && !this.editing && !this.previewLoading && !this.needsReview && !!this.sourceData && !!this.targetData && (this.kind.value !== this.targetKind.value || this.source.value !== this.target.value),
            getIds: (id, handle) => {
                const side = handle.dataset.claTransferSide;
                this.activeSide = side;
                return handle.dataset.claTransferGroup !== undefined
                    ? this.filtered(side).filter(item => this.groupName(item, side) === handle.dataset.claTransferGroup).map(item => item.id)
                    : this.selectionFor(side).has(id) ? [...this.selectionFor(side)] : [id];
            },
            onDrop: ids => { const selection = this.selectionFor(this.activeSide); selection.clear(); for (const id of ids) selection.add(id); this.updateSelectionChecks(); void this.execute(); },
        });
        this.nameSelection = new PressSweepSelection({ root: view,
            nameSelector: '.cla-transfer-item-name', rowSelector: '.cla-transfer-item',
            getRows: row => [...(row.dataset.claTransferSide === 'source' ? this.list : this.targetList).querySelectorAll('.cla-transfer-item')].filter(row => row.checkVisibility?.() !== false),
            valid: () => this.started && this.view === view && !this.busy && !this.loading && !this.targetLoading && !this.previewLoading && !this.editing,
            context: row => JSON.stringify([row.dataset.claTransferSide, this.kind.value, this.source.value, this.target.value, this.loadSequence, this.targetLoadSequence]),
            onStart: row => { this.activeSide = row.dataset.claTransferSide; },
            isSelected: row => this.selectionFor(row.dataset.claTransferSide).has(row.dataset.claTransferId),
            setSelected: (row, selected) => { const selection = this.selectionFor(row.dataset.claTransferSide), id = row.dataset.claTransferId; if (selected) selection.add(id); else selection.delete(id); },
            onChange: () => this.updateSelectionChecks(),
        });
        view.addEventListener('keydown', event => {
            const row = event.target.closest('.cla-transfer-item');
            if (event.target !== row || ![' ', 'Enter'].includes(event.key) || this.busy || this.editing || this.previewLoading || this.loading || this.targetLoading) return;
            event.preventDefault(); this.activeSide = row.dataset.claTransferSide;
            const selection = this.selectionFor(this.activeSide), id = row.dataset.claTransferId;
            if (selection.has(id)) selection.delete(id); else selection.add(id);
            this.updateSelectionChecks();
        });
        this.targetKind.addEventListener('change', () => { this.cancelGestures(); this.populateTargets(); void this.loadTarget(); });
        this.kind.addEventListener('change', () => this.chooseKind());
        this.source.addEventListener('change', () => { this.cancelGestures(); this.excludeSource(); void this.reloadPanels(); });
        this.target.addEventListener('change', () => { this.cancelGestures(); void this.loadTarget(); });
        this.operation.addEventListener('change', () => { this.cancelGestures(); this.updateControls(); });
        this.search.addEventListener('input', () => { this.cancelGestures(); this.selected.clear(); this.renderItems(); });
        this.targetSearch.addEventListener('input', () => { this.cancelGestures(); this.targetSelected.clear(); this.renderTarget(); this.updateSelectionChecks(); });
        view.addEventListener('click', event => {
            const eye = event.target.closest('[data-cla-transfer-view]');
            if (eye) { event.preventDefault(); event.stopPropagation(); void this.openEntry(eye.dataset.claTransferSide, eye.dataset.claTransferView); return; }
            const action = event.target.closest('[data-cla-transfer-action]')?.dataset.claTransferAction;
            if (!action || this.busy) return;
            if (action === 'delete') { void this.deleteSelected(); return; }
            if (action === 'activate') return;
            if (action === 'execute') { void this.execute(); return; }
            if (action === 'reload') { void this.reloadPanels(); return; }
            if (action === 'refresh') { globalThis.location.reload(); return; }
            if (action === 'all') for (const item of this.filtered(this.activeSide)) this.selectionFor(this.activeSide).add(item.id);
            if (action === 'clear') this.selectionFor(this.activeSide).clear();
            this.updateSelectionChecks();
        });
    }

    cancelGestures() { this.nameSelection?.cancel(); this.dragger?.cancel(); }
    selectionFor(side) { return side === 'source' ? this.selected : this.targetSelected; }
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
        await Promise.all([this.loadSource(message, preserveSelection), this.loadTarget(preserveSelection)]);
    }

    async loadTarget(preserveSelection = false) {
        if (!this.view || this.busy) return;
        const sequence = ++this.targetLoadSequence, view = this.view;
        const previousSelection = preserveSelection ? new Set(this.targetSelected) : new Set();
        const previousSearch = preserveSelection ? this.targetSearch.value : '';
        this.targetSelected.clear();
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
            if (new Set(this.targetItems.map(item => item.id)).size !== this.targetItems.length || this.targetItems.some(item => !item.id || item.id === 'undefined')) { this.targetData = null; this.targetItems = []; throw new Error('目标含缺失或重复 ID，请先在原生编辑器修复'); }
            this.targetSelected = new Set(this.targetItems.filter(item => previousSelection.has(item.id)).map(item => item.id));
            this.targetSearch.value = previousSearch;
        } catch (error) {
            if (sequence === this.targetLoadSequence && view === this.view) this.status.textContent = error.message;
        } finally {
            if (sequence === this.targetLoadSequence && view === this.view) {
                this.targetLoading = false; this.renderTarget(); this.updateSelectionChecks();
            }
        }
    }

    groupName(item, side) { return transferCollection(this.refFor(side), item.value, this.extensionSettings); }
    renderItem(item, side) {
        const { id, value } = item;
        const row = node('div', undefined, 'cla-transfer-item'); row.dataset.claTransferId = id;
        if (side === 'target') row.dataset.claTransferTargetId = id;
        row.dataset.claTransferSide = side; row.tabIndex = 0; row.setAttribute('role', 'checkbox');
        const name = node('span', value.comment || value.scriptName || `条目 ${id}`, 'cla-transfer-item-name');
        name.title = name.textContent;
        const handle = button('⠿'); delete handle.dataset.claTransferAction;
        handle.className = 'cla-transfer-drag-handle'; handle.dataset.claTransferDrag = id; handle.dataset.claTransferSide = side;
        handle.setAttribute('aria-label', `拖动${name.textContent}或已选多项到对面`); row.append(handle);
        row.append(name);
        const eye = button('', undefined); delete eye.dataset.claTransferAction;
        eye.className = 'cla-transfer-eye'; eye.dataset.claTransferView = id; eye.dataset.claTransferSide = side;
        eye.title = '查看 / 编辑内容'; eye.setAttribute('aria-label', `${eye.title}：${name.textContent}`);
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
        const outline = document.createElementNS(svg.namespaceURI, 'path');
        outline.setAttribute('d', 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z');
        const pupil = document.createElementNS(svg.namespaceURI, 'circle');
        pupil.setAttribute('cx', '12'); pupil.setAttribute('cy', '12'); pupil.setAttribute('r', '3');
        svg.append(outline, pupil); eye.append(svg); row.append(eye);
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
            const disclosure = node('span', '', 'cla-transfer-disclosure'); disclosure.setAttribute('aria-hidden', 'true');
            summary.prepend(disclosure);
            const groupName = node('span', name, 'cla-transfer-group-name'); groupName.title = name;
            summary.append(groupName, node('small', `${members.length} 条`, 'cla-transfer-group-count'));
            groupName.addEventListener('click', event => {
                event.preventDefault();
                if (this.busy || this.loading || this.targetLoading || this.previewLoading || this.editing) return;
                this.activeSide = side;
                const selection = this.selectionFor(side), select = !members.every(item => selection.has(item.id));
                for (const item of members) { if (select) selection.add(item.id); else selection.delete(item.id); }
                this.updateSelectionChecks();
            });
            const handle = button('⠿'); delete handle.dataset.claTransferAction; handle.className = 'cla-transfer-drag-handle';
            handle.dataset.claTransferDrag = ''; handle.dataset.claTransferGroup = name; handle.dataset.claTransferSide = side;
            handle.setAttribute('aria-label', `拖动整个分组：${name}`); summary.append(handle);
            details.append(summary); for (const item of members) details.append(this.renderItem(item, side)); list.append(details);
        }
    }
    updateSelectionChecks() {
        for (const [side, list] of [['source', this.list], ['target', this.targetList]]) {
            const selection = this.selectionFor(side);
            for (const row of list.querySelectorAll('.cla-transfer-item')) {
                const selected = selection.has(row.dataset.claTransferId);
                row.classList.toggle('cla-transfer-selected', selected); row.setAttribute('aria-checked', String(selected));
            }
            for (const group of list.querySelectorAll('.cla-transfer-group')) {
                const members = this.filtered(side).filter(item => this.groupName(item, side) === group.dataset.claTransferCollection);
                const count = members.filter(item => selection.has(item.id)).length;
                group.querySelector('summary').classList.toggle('cla-transfer-selected', count > 0);
                group.querySelector('.cla-transfer-group-count').textContent = count ? `${count} / ${members.length} 条` : `${members.length} 条`;
            }
        }
        this.updateControls();
    }
    renderTarget() {
        const query = this.targetSearch.value.toLocaleLowerCase().trim();
        this.targetCount.textContent = this.targetLoading ? '正在读取…' : `已有 ${this.targetItems.length} 项 · 已选 ${this.targetSelected.size}`;
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

    filtered(side = 'source') {
        const query = (side === 'source' ? this.search : this.targetSearch).value.toLocaleLowerCase().trim();
        return (side === 'source' ? this.items : this.targetItems).filter(item => !query || JSON.stringify(item.value).toLocaleLowerCase().includes(query));
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
        const selected = this.selectionFor(this.activeSide);
        this.leftPane.classList.toggle('cla-transfer-pane-active', this.activeSide === 'source');
        this.rightPane.classList.toggle('cla-transfer-pane-active', this.activeSide === 'target');
        this.executeButton.textContent = `${this.operation.value === 'move' ? '移动' : '复制'}${this.activeSide === 'source' ? '到右侧 →' : '到左侧 ←'}（${selected.size}）`;
        this.executeButton.disabled = locked || this.loading || this.targetLoading || this.needsReview || !ready || !selected.size;
        this.deleteButton.textContent = `删除${this.activeSide === 'source' ? '左侧' : '右侧'}所选（${selected.size}）`;
        this.deleteButton.disabled = locked || this.loading || this.targetLoading || this.needsReview || !selected.size;
        this.reloadButton.disabled = locked || !this.source.value;
        this.sourceCount.textContent = `共 ${this.items.length} 项 · 已选 ${this.selected.size}`;
        for (const handle of this.view.querySelectorAll('[data-cla-transfer-drag]')) handle.disabled = locked || this.loading || this.targetLoading || this.needsReview || !ready;
        this.renderTarget();
        for (const row of this.view.querySelectorAll('.cla-transfer-item')) { const checked = this.selectionFor(row.dataset.claTransferSide).has(row.dataset.claTransferId); row.classList.toggle('cla-transfer-selected', checked); row.setAttribute('aria-checked', String(checked)); }
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
            ensureTransferEditorStyles();
            const editor = node('div', undefined, 'cla-transfer-editor'); editor.id = 'cla-transfer-editor';
            editor.append(node('h3', '查看 / 编辑内容'), node('small', `${side === 'source' ? '来源' : '目标'}：${ref.label}`));
            const field = (title, name, value, multiline = false) => {
                const label = node('label'), heading = node('span', undefined, 'cla-transfer-field-heading'), input = node(multiline ? 'textarea' : 'input', undefined, 'text_pole');
                input.dataset.claTransferEdit = name; input.value = value ?? '';
                if (multiline) input.rows = name === 'content' || name === 'replaceString' ? 12 : 4;
                heading.append(node('span', title)); label.append(heading, input); editor.append(label);
                if (multiline && !['key', 'keysecondary'].includes(name)) {
                    const expand = expandIcon(); heading.append(expand);
                    expand.addEventListener('click', event => { event.preventDefault(); this.expandEditor(input, title, expand); });
                }
                return input;
            };
            const name = field('条目名称', 'name', entry.comment ?? entry.scriptName ?? '');
            const worldFields = {}, initialWorldValues = {};
            if (ref.kind === 'world') {
                const grid = node('div', undefined, 'cla-transfer-world-fields'); editor.append(grid);
                const optionField = (title, key, value, options) => {
                    const label = node('label', title), input = node('select', undefined, 'text_pole');
                    input.dataset.claTransferEdit = key;
                    for (const [id, text] of options) { const option = node('option', text); option.value = id; input.append(option); }
                    input.value = String(value); label.append(input); grid.append(label); worldFields[key] = input; return input;
                };
                optionField('状态', 'disable', !!entry.disable, [['false','启用'],['true','停用']]);
                optionField('触发策略', 'strategy', entry.constant ? 'constant' : entry.vectorized ? 'vectorized' : 'normal', [['normal','🟢 关键词触发'],['constant','🔵 常驻'],['vectorized','🔗 向量触发']]);
                const position = optionField('插入位置', 'position', entry.position ?? 0, [[0,'角色定义之前'],[1,'角色定义之后'],[2,'作者注释之前'],[3,'作者注释之后'],[4,'插入深度 @D'],[5,'示例消息之前'],[6,'示例消息之后'],[7,'Outlet']]);
                position.parentElement.classList.add('cla-transfer-position');
                const role = optionField('消息角色', 'role', entry.role ?? 0, [[0,'系统'],[1,'用户'],[2,'助手']]);
                for (const [title, key, value, max] of [['深度','depth',entry.depth ?? 4,10000],['顺序','order',entry.order ?? 100,Number.MAX_SAFE_INTEGER],['触发概率 %','probability',entry.probability ?? 100,100]]) {
                    const input = field(title, key, value); input.type = 'number'; input.min = 0; input.max = max; input.step = 1; grid.append(input.parentElement); worldFields[key] = input;
                }
                optionField('概率开关', 'useProbability', entry.useProbability ?? true, [['true','启用'],['false','停用']]);
                worldFields.outletName = field('Outlet 名称', 'outletName', entry.outletName ?? '');
                const syncPosition = () => { role.parentElement.hidden = worldFields.depth.parentElement.hidden = position.value !== '4'; worldFields.outletName.parentElement.hidden = position.value !== '7'; };
                position.addEventListener('change', syncPosition); syncPosition();
                const keywords = node('div', undefined, 'cla-transfer-keywords'); editor.append(keywords);
                worldFields.key = field('主要关键字', 'key', (entry.key || []).join(', '), true); worldFields.key.rows = 2;
                worldFields.key.placeholder = '逗号分隔列表';
                const logic = optionField('逻辑', 'selectiveLogic', entry.selectiveLogic ?? 0, [[0,'与任意'],[1,'非全部'],[2,'非任意'],[3,'与全部']]);
                worldFields.keysecondary = field('可选过滤器', 'keysecondary', (entry.keysecondary || []).join(', '), true); worldFields.keysecondary.rows = 2;
                worldFields.keysecondary.placeholder = '逗号分隔列表（如果为空则忽略）';
                keywords.append(worldFields.key.parentElement, logic.parentElement, worldFields.keysecondary.parentElement);
                for (const [key, input] of Object.entries(worldFields)) initialWorldValues[key] = input.value;
            }
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
                    try {
                        const patch = { name: name.value };
                        if (content) {
                            patch.content = content.value;
                            for (const [key, input] of Object.entries(worldFields)) {
                                if (input.value === initialWorldValues[key]) continue;
                                patch[key] = ['disable', 'useProbability'].includes(key) ? input.value === 'true'
                                    : ['key', 'keysecondary'].includes(key) ? this.repository.worldApi.splitKeywordsAndRegexes(input.value) : input.value;
                            }
                        } else Object.assign(patch, { findRegex: find.value, replaceString: replace.value });
                        next = editTransferEntry(ref.kind, data, id, patch);
                    }
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
                    this.closeExpandedEditor?.();
                    this.editorPopup = null; this.editing = false;
                    if (!valid()) return;
                    if (saved) {
                        if (ref.kind !== 'world') { this.onRegexSaved(); this.refreshButton.hidden = false; }
                        await this.reloadPanels('内容已保存，选择状态保留。', true);
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

    expandEditor(input, title, trigger) {
        if (this.closeExpandedEditor) return;
        ensureTransferEditorStyles();
        const expandedInput = input.cloneNode(true), name = input.dataset.claTransferEdit;
        expandedInput.value = input.value; delete input.dataset.claTransferEdit;
        const dialog = node('dialog', undefined, 'cla-transfer-expanded');
        dialog.id = 'cla-transfer-expanded-editor'; dialog.setAttribute('aria-label', title);
        dialog.style.setProperty('--cla-editor-surface', editorSurface(input));
        dialog.style.setProperty('--cla-editor-text', getComputedStyle(input).color);
        const heading = node('div', undefined, 'cla-transfer-field-heading');
        const collapse = expandIcon(true); heading.append(node('span', title), collapse); dialog.append(heading, expandedInput);
        document.body.append(dialog);
        const close = () => {
            if (this.closeExpandedEditor !== close) return;
            this.closeExpandedEditor = null;
            input.value = expandedInput.value; input.dataset.claTransferEdit = name;
            dialog.close(); dialog.remove(); trigger.focus();
        };
        this.closeExpandedEditor = close;
        collapse.addEventListener('click', close);
        dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); close(); });
        dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
        dialog.showModal(); expandedInput.focus(); expandedInput.scrollTop = input.scrollTop;
    }

    async deleteSelected() {
        if (!this.view || this.deleteButton.disabled) return;
        if (this.isGenerating()) { this.status.textContent = '请等待生成结束后再删除'; return; }
        this.cancelGestures();
        const view = this.view, generation = this.generation, side = this.activeSide, ref = this.refFor(side), ids = [...this.selectionFor(side)];
        const expected = side === 'source' ? this.sourceData : this.targetData;
        const valid = () => this.started && this.view === view && this.generation === generation && !this.isGenerating();
        this.busy = true; this.updateControls();
        try {
            const confirmed = await this.popupApi.Popup.show.confirm(null, node('p', `确定从“${ref.label}”删除选中的 ${ids.length} 项？删除后无法在此撤销。`), { okButton: '删除所选', cancelButton: '取消' });
            if (confirmed !== (this.popupApi.POPUP_RESULT?.AFFIRMATIVE ?? 1) || !valid()) return;
            const data = await this.repository.read(ref);
            if (fingerprint(data) !== fingerprint(expected)) throw new Error('内容已更改，请重新加载后选择');
            const next = deleteTransferEntries(ref.kind, data, ids);
            await this.repository.beforeWrite({ kind: ref.kind });
            if (!valid()) return;
            await this.repository.write(ref, next, data);
            this.selectionFor(side).clear();
            if (ref.kind !== 'world') { this.onRegexSaved(); this.refreshButton.hidden = false; }
            if (valid()) { this.busy = false; await this.reloadPanels(`已删除 ${ids.length} 项。`); }
        } catch (error) { if (this.view === view) { this.status.textContent = `删除未完成或未确认：${error.message}`; this.needsReview = true; } }
        finally { this.busy = false; if (this.view === view) this.updateControls(); }
    }

    async execute() {
        if (this.busy || this.executeButton.disabled || !this.view) return;
        if (this.isGenerating()) { this.status.textContent = '请等待生成结束后再转移'; return; }
        const view = this.view, generation = this.generation, side = this.activeSide, other = side === 'source' ? 'target' : 'source';
        const source = this.refFor(side), target = this.refFor(other), kind = source.kind;
        const move = this.operation.value === 'move';
        const valid = () => this.started && this.view === view && view.isConnected && this.generation === generation
            && this.refFor(side)?.id === source.id && this.refFor(side)?.kind === source.kind
            && this.refFor(other)?.id === target.id && this.refFor(other)?.kind === target.kind && !this.isGenerating();
        this.busy = true; this.updateControls();
        this.status.textContent = '正在检查来源与目标…';
        try {
            const job = await this.service.prepare(kind, source, target, [...this.selectionFor(side)]);
            if (fingerprint(job.sourceData) !== fingerprint(side === 'source' ? this.sourceData : this.targetData)) throw new Error('来源已更改，请重新加载后选择');
            if (fingerprint(job.targetData) !== fingerprint(side === 'source' ? this.targetData : this.sourceData)) throw new Error('目标已更改，请重新加载两侧后操作');
            if (!valid()) return;
            const content = node('p', `将选中的 ${job.ids.length} 项${move ? '移动' : '复制'}：\n来源：${source.label}\n目标：${target.label}\n${move ? '目标保存成功后才移除来源。' : '来源内容保留。'}目标已有内容不会被覆盖。`);
            content.style.whiteSpace = 'pre-wrap';
            const confirmed = await this.popupApi.Popup.show.confirm(null, content, { okButton: move ? '移动所选' : '复制所选', cancelButton: '取消' });
            if (confirmed !== (this.popupApi.POPUP_RESULT?.AFFIRMATIVE ?? 1)) { this.status.textContent = '已取消，所选内容保留。'; return; }
            const result = await this.service.execute(job, { move, valid });
            this.saveTransferGroups(job, result);
            this.selectionFor(side).clear();
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
                if (error.targetSaved) this.selectionFor(side).clear();
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
        this.closeExpandedEditor?.();
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
