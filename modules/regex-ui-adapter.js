const TYPE_BY_LIST_ID = Object.freeze({
    saved_regex_scripts: 'GLOBAL',
    saved_scoped_scripts: 'SCOPED',
    saved_preset_scripts: 'PRESET',
});

const REGEX_LIST_SELECTOR = '#saved_regex_scripts, #saved_scoped_scripts, #saved_preset_scripts';
const REGEX_ROW_SELECTOR = `${REGEX_LIST_SELECTOR.split(', ').map(selector => `${selector} .regex-script-label`).join(', ')}`;
const UNGROUPED_COLLECTION = '未分类';
const AUTO_COLLAPSE_STORAGE_KEY = 'cloud-lounge-accelerator:regex-auto-collapse';
const COLLECTION_SETTINGS_KEY = 'cloud_lounge_accelerator_regex_collections';

export function normalizeRegexCollectionName(value) {
    const name = String(value || '').trim();
    if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error('分组名称请输入 1–60 个字符');
    if (name === UNGROUPED_COLLECTION || name === 'all') throw new Error('这个名称已被系统使用，请换一个分组名称');
    return name;
}

export function getRegexCollectionName(scriptName) {
    const name = String(scriptName || '').trim();
    const bracketed = name.match(/^(?:\[([^\]]+)\]|【([^】]+)】|〔([^〕]+)〕|「([^」]+)」|『([^』]+)』)/u);
    const collection = bracketed?.slice(1).find(Boolean)?.trim();
    return collection || UNGROUPED_COLLECTION;
}

export function getRegexCollectionKey(scope = '', collection = UNGROUPED_COLLECTION) {
    return JSON.stringify([scope, collection]);
}

function createDefaultOpenCollections() {
    return new Set(Object.values(TYPE_BY_LIST_ID).map(scope => getRegexCollectionKey(scope, UNGROUPED_COLLECTION)));
}

export function matchesRegexOrganizerFilter({
    name = '',
    collection = UNGROUPED_COLLECTION,
    scope = '',
    query = '',
    selectedCollection = 'all',
    selectedScope = 'all',
} = {}) {
    const normalizedQuery = String(query).trim().toLocaleLowerCase();
    return (selectedCollection === 'all' || collection === selectedCollection)
        && (selectedScope === 'all' || scope === selectedScope)
        && (!normalizedQuery || String(name).toLocaleLowerCase().includes(normalizedQuery));
}

export function shouldShowRegexOrganizerRow(options = {}) {
    if (!matchesRegexOrganizerFilter(options)) return false;
    if (!options.autoCollapse) return true;
    const openCollections = options.openCollections instanceof Set
        ? options.openCollections
        : new Set(options.openCollections || []);
    return openCollections.has(getRegexCollectionKey(options.scope, options.collection));
}

function recordsOnlyAffectChat(records) {
    return records.length > 0 && records.every(record => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        return Boolean(target?.closest?.('#chat'));
    });
}

function parseOptionalInteger(value) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function getTypeKey(element) {
    const list = element?.closest?.(REGEX_LIST_SELECTOR);
    return list ? TYPE_BY_LIST_ID[list.id] : null;
}

function mutationAffectsRegexUi(record) {
    const target = record.target instanceof Element ? record.target : record.target?.parentElement;
    if (target?.closest?.('[data-cla-regex-fold]')) return false;
    const changedNodes = [...(record.addedNodes || []), ...(record.removedNodes || [])];
    if (changedNodes.length && changedNodes.every(node => node?.matches?.('[data-cla-regex-fold]'))) return false;
    if (target?.closest?.(REGEX_LIST_SELECTOR)) return true;
    return changedNodes.some(node => (
        node?.matches?.('.regex_settings, .regex-script-label, #saved_regex_scripts, #saved_scoped_scripts, #saved_preset_scripts')
        || node?.querySelector?.('.regex_settings, .regex-script-label, #saved_regex_scripts, #saved_scoped_scripts, #saved_preset_scripts')
    ));
}

function readEditorDraft(editor, id, previous = {}) {
    const checkedPlacements = [...editor.querySelectorAll('input[name="replace_position"]:checked')]
        .map(input => Number(input.value))
        .filter(Number.isFinite);
    return {
        ...previous,
        id,
        scriptName: String(editor.querySelector('.regex_script_name')?.value || '').trim(),
        findRegex: String(editor.querySelector('.find_regex')?.value || ''),
        replaceString: String(editor.querySelector('.regex_replace_string')?.value || ''),
        trimStrings: String(editor.querySelector('.regex_trim_strings')?.value || '').split('\n').filter(Boolean),
        placement: checkedPlacements,
        disabled: Boolean(editor.querySelector('input[name="disabled"]')?.checked),
        markdownOnly: Boolean(editor.querySelector('input[name="only_format_display"]')?.checked),
        promptOnly: Boolean(editor.querySelector('input[name="only_format_prompt"]')?.checked),
        runOnEdit: Boolean(editor.querySelector('input[name="run_on_edit"]')?.checked),
        substituteRegex: Number(editor.querySelector('select[name="substitute_regex"]')?.value || 0),
        minDepth: parseOptionalInteger(editor.querySelector('input[name="min_depth"]')?.value),
        maxDepth: parseOptionalInteger(editor.querySelector('input[name="max_depth"]')?.value),
    };
}

export class RegexUiAdapter {
    constructor({ onSaved = null, extensionSettings = {} } = {}) {
        this.onSaved = onSaved;
        this.extensionSettings = extensionSettings;
        this.started = false;
        this.engine = null;
        this.popupApi = null;
        this.scriptApi = null;
        this.editorContext = null;
        this.saveQueue = Promise.resolve();
        this.generation = 0;
        this.busyEditors = new WeakSet();
        this.deletePending = false;
        this.pendingRestores = new Set();
        this.groupDrag = null;
        this.pointerFrame = null;
        this.observer = null;
        this.organizerButton = null;
        this.reorderButton = null;
        this.organizerRoot = null;
        this.organizerTimer = null;
        this.organizerOpen = false;
        this.autoCollapseCollections = true;
        this.openCollections = createDefaultOpenCollections();
        this.collectionGroups = [];
        this.reorderMode = false;
        this.lastSelectedRow = null;
        this.selectionGesture = null;
        this.suppressRowClickUntil = 0;
        this.onClick = this.onClick.bind(this);
        this.onInput = this.onInput.bind(this);
        this.onChange = this.onChange.bind(this);
        this.onPointerDown = this.onPointerDown.bind(this);
        this.onPointerMove = this.onPointerMove.bind(this);
        this.onPointerEnd = this.onPointerEnd.bind(this);
        this.onLostPointerCapture = event => {
            if (this.groupDrag?.pointerId === event.pointerId || this.selectionGesture?.pointerId === event.pointerId) this.finishPointerGesture(false);
        };
    }

    async start() {
        if (this.started) return true;
        try {
            [this.engine, this.popupApi, this.scriptApi] = await Promise.all([
                import('../../../regex/engine.js'),
                import('../../../../popup.js'),
                import('../../../../../script.js'),
            ]);
        } catch (error) {
            console.debug('[Cloud Lounge Accelerator] 正则界面最小刷新适配不可用', error);
            return false;
        }
        this.autoCollapseCollections = this.readAutoCollapseSetting();
        this.started = true;
        this.generation += 1;
        document.addEventListener('click', this.onClick, true);
        document.addEventListener('input', this.onInput, true);
        document.addEventListener('change', this.onChange, true);
        document.addEventListener('pointerdown', this.onPointerDown, true);
        document.addEventListener('pointermove', this.onPointerMove, { capture: true, passive: false });
        document.addEventListener('pointerup', this.onPointerEnd, true);
        document.addEventListener('pointercancel', this.onPointerEnd, true);
        document.addEventListener('lostpointercapture', this.onLostPointerCapture, true);
        this.observer = new MutationObserver(records => {
            if (recordsOnlyAffectChat(records)) return;
            if (document.querySelector('.regex_editor')) {
                if (this.editorContext) this.editorContext.opened = true;
            } else if (this.editorContext?.opened && !document.querySelector('.popup[closing] .regex_editor')) {
                this.editorContext = null;
            }
            if (records.some(mutationAffectsRegexUi)) this.scheduleOrganizerRefresh();
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
        this.scheduleOrganizerRefresh();
        return true;
    }

    scheduleOrganizerRefresh() {
        if (!this.started || this.organizerTimer !== null) return;
        this.organizerTimer = setTimeout(() => {
            this.organizerTimer = null;
            this.enhanceRegexUi();
        }, 0);
    }

    readAutoCollapseSetting() {
        try {
            return globalThis.localStorage?.getItem?.(AUTO_COLLAPSE_STORAGE_KEY) !== 'false';
        } catch {
            return true;
        }
    }

    saveAutoCollapseSetting() {
        try {
            globalThis.localStorage?.setItem?.(AUTO_COLLAPSE_STORAGE_KEY, String(this.autoCollapseCollections));
        } catch {
            // Private browsing or restricted storage should not disable the UI.
        }
    }

    getCollectionContext(scope) {
        if (scope === 'GLOBAL') return JSON.stringify([scope]);
        if (scope === 'SCOPED') {
            const avatar = this.scriptApi?.characters?.[this.scriptApi.this_chid]?.avatar;
            return avatar ? JSON.stringify([scope, avatar]) : null;
        }
        if (scope === 'PRESET') {
            const api = this.engine?.getCurrentPresetAPI?.();
            const name = this.engine?.getCurrentPresetName?.();
            return api && name ? JSON.stringify([scope, api, name]) : null;
        }
        return null;
    }

    getCollectionState(scope) {
        const key = this.getCollectionContext(scope);
        const state = key && this.extensionSettings[COLLECTION_SETTINGS_KEY]?.[key];
        return {
            groups: Array.isArray(state?.groups) ? state.groups.filter(name => typeof name === 'string') : [],
            assignments: state?.assignments && typeof state.assignments === 'object' ? { ...state.assignments } : {},
        };
    }

    saveCollectionState(scope, state) {
        const key = this.getCollectionContext(scope);
        if (!key) throw new Error('请先选择对应的预设或角色');
        this.extensionSettings[COLLECTION_SETTINGS_KEY] = {
            ...this.extensionSettings[COLLECTION_SETTINGS_KEY], [key]: state,
        };
    }

    getAssignedCollection(scope, id, scriptName) {
        const key = this.getCollectionContext(scope);
        const assignments = this.extensionSettings[COLLECTION_SETTINGS_KEY]?.[key]?.assignments || {};
        return Object.hasOwn(assignments, id) && typeof assignments[id] === 'string'
            ? assignments[id] : getRegexCollectionName(scriptName);
    }

    getScopeCollections(scope) {
        const names = new Set(this.getCollectionState(scope).groups);
        for (const script of this.engine?.getScriptsByType?.(this.getType(scope)) || []) {
            names.add(this.getAssignedCollection(scope, String(script.id), script.scriptName));
        }
        return names;
    }

    createCollection(scope, value) {
        const name = normalizeRegexCollectionName(value);
        if (!this.getCollectionContext(scope)) throw new Error('请先选择对应的预设或角色');
        if (this.getScopeCollections(scope).has(name)) throw new Error('这个范围内已经有同名分组');
        const state = this.getCollectionState(scope);
        state.groups.push(name);
        this.saveCollectionState(scope, state);
        this.finishCollectionChange(scope, name);
    }

    renameCollection(scope, previous, value) {
        const name = normalizeRegexCollectionName(value);
        if (name === previous) return;
        if (!this.getCollectionContext(scope)) throw new Error('请先选择对应的预设或角色');
        if (this.getScopeCollections(scope).has(name)) throw new Error('这个范围内已经有同名分组');
        const state = this.getCollectionState(scope);
        state.groups = [...state.groups.filter(group => group !== previous), name];
        const renamed = (this.engine.getScriptsByType(this.getType(scope)) || [])
            .filter(script => this.getAssignedCollection(scope, String(script.id), script.scriptName) === previous)
            .map(script => [String(script.id), name]);
        state.assignments = { ...state.assignments, ...Object.fromEntries(renamed) };
        // Preserve renamed assignments for rules temporarily absent from the list.
        for (const id of Object.keys(state.assignments)) {
            if (state.assignments[id] === previous) state.assignments[id] = name;
        }
        this.saveCollectionState(scope, state);
        this.openCollections.delete(getRegexCollectionKey(scope, previous));
        const filter = this.organizerRoot?.querySelector('[data-cla-regex-collection]');
        if (filter?.value === previous) filter.value = 'all';
        this.finishCollectionChange(scope, name);
    }

    moveSelectedToCollection(value) {
        return this.moveRowsToCollection(this.getRows().filter(row => row.querySelector('.regex_bulk_checkbox')?.checked), value);
    }

    moveRowsToCollection(rows, value) {
        const name = value === UNGROUPED_COLLECTION ? value : normalizeRegexCollectionName(value);
        const plans = new Map();
        for (const row of rows) {
            const scope = getTypeKey(row);
            if (!this.getCollectionContext(scope)) throw new Error('请先选择对应的预设或角色');
            if (!plans.has(scope)) plans.set(scope, {
                state: this.getCollectionState(scope), ids: [],
                knownIds: new Set((this.engine.getScriptsByType(this.getType(scope)) || []).map(script => String(script.id))),
            });
            const plan = plans.get(scope);
            if (!plan.knownIds.has(row.id)) {
                throw new Error('正则列表已变化，请重新选择后归组');
            }
            plan.ids.push(row.id);
        }
        if (!plans.size) throw new Error('请先勾选要归组的正则');
        for (const [scope, {state, ids}] of plans) {
            if (name !== UNGROUPED_COLLECTION && !state.groups.includes(name)) state.groups.push(name);
            // One copy per scope, preserving even IDs named "__proto__" as data.
            state.assignments = { ...state.assignments, ...Object.fromEntries(ids.map(id => [id, name])) };
            this.saveCollectionState(scope, state);
            this.openCollections.add(getRegexCollectionKey(scope, name));
        }
        this.finishCollectionChange();
    }

    finishCollectionChange(scope, name) {
        if (scope && name) this.openCollections.add(getRegexCollectionKey(scope, name));
        this.scriptApi?.saveSettingsDebounced?.();
        this.refreshOrganizerRows();
    }

    runCollectionAction(action) {
        const feedback = this.organizerRoot?.querySelector('[data-cla-regex-feedback]');
        try {
            action();
            if (feedback) feedback.textContent = '分组已保存';
            return true;
        } catch (error) {
            if (feedback) feedback.textContent = error.message;
            globalThis.toastr?.error?.(error.message, '正则分组');
            return false;
        }
    }

    createOrganizerButton() {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu_button menu_button_icon cla-regex-organizer-toggle';
        button.title = '按合集整理、搜索和多选正则';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-folder-tree';
        const label = document.createElement('small');
        label.textContent = '整理正则';
        button.append(icon, label);
        return button;
    }

    createReorderButton() {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu_button cla-regex-reorder-toggle';
        button.title = '切换到原顺序拖拽，调整后可返回合集';
        button.addEventListener('click', () => {
            this.reorderMode = !this.reorderMode;
            this.refreshCollectionFolds();
            this.applyOrganizerFilters();
        });
        return button;
    }

    createOrganizer() {
        const root = document.createElement('section');
        root.className = 'cla-regex-organizer';
        root.hidden = true;
        root.innerHTML = `
            <div class="cla-regex-organizer-heading">
                <strong>正则整理</strong>
                <span data-cla-regex-count>0 条·已选 0 条</span>
            </div>
            <div class="cla-regex-filters">
                <input type="search" class="text_pole" data-cla-regex-search placeholder="搜索正则名称" />
                <select class="text_pole" data-cla-regex-collection aria-label="正则合集"></select>
                <select class="text_pole" data-cla-regex-scope aria-label="正则范围">
                    <option value="all">全部范围</option>
                    <option value="GLOBAL">全局</option>
                    <option value="PRESET">预设</option>
                    <option value="SCOPED">角色</option>
                </select>
            </div>
            <div class="cla-regex-organizer-actions">
                <button type="button" class="menu_button" data-cla-regex-action="select-visible">选择当前结果</button>
                <button type="button" class="menu_button" data-cla-regex-action="clear">清空选择</button>
                <label class="checkbox_label cla-regex-collapse-option">
                    <input type="checkbox" data-cla-regex-auto-collapse />
                    <span>合集自动折叠</span>
                </label>
                <label class="checkbox_label cla-regex-drag-option">
                    <input type="checkbox" data-cla-regex-drag />
                    <span>按住名称划选多条</span>
                </label>
            </div>
            <details class="cla-regex-group-manager">
                <summary>管理分组</summary>
                <div class="cla-regex-group-create">
                    <input class="text_pole" data-cla-regex-new-name maxlength="60" placeholder="新分组名称" aria-label="新分组名称" />
                    <select class="text_pole" data-cla-regex-new-scope aria-label="新分组范围">
                        <option value="GLOBAL">全局</option><option value="PRESET">当前预设</option><option value="SCOPED">当前角色</option>
                    </select>
                    <button type="button" class="menu_button" data-cla-regex-action="create-collection">新建分组</button>
                </div>
                <div class="cla-regex-group-move">
                    <select class="text_pole" data-cla-regex-move-target aria-label="移入的分组"></select>
                    <button type="button" class="menu_button" data-cla-regex-action="move-selected">将已选正则移入分组</button>
                </div>
                <small>分组随酒馆设置保存；不修改正则名称、内容或执行顺序。</small>
            </details>
            <small data-cla-regex-feedback role="status" aria-live="polite"></small>
            <small class="cla-regex-organizer-hint">点分组标题展开，点名称勾选；开启划选后可连续滑过名称。拖动行内 ↪ 可归组，拖动已选行可批量归组；“调整顺序”中的 ☰ 仍调整执行顺序。</small>
        `;
        root.querySelector('[data-cla-regex-auto-collapse]').checked = this.autoCollapseCollections;
        root.addEventListener('input', event => {
            if (event.target?.matches?.('[data-cla-regex-search]')) {
                this.applyOrganizerFilters();
            }
        });
        root.addEventListener('change', event => {
            if (event.target?.matches?.('[data-cla-regex-scope], [data-cla-regex-collection]')) {
                this.applyOrganizerFilters();
            }
            if (event.target?.matches?.('[data-cla-regex-auto-collapse]')) {
                this.autoCollapseCollections = event.target.checked;
                this.reorderMode = false;
                this.saveAutoCollapseSetting();
                this.refreshCollectionFolds();
                this.applyOrganizerFilters();
            }
            if (event.target?.matches?.('[data-cla-regex-drag]')) {
                document.querySelector('#regex_container')?.classList?.toggle('cla-regex-drag-selecting', event.target.checked);
            }
        });
        root.addEventListener('click', event => {
            const action = event.target?.closest?.('[data-cla-regex-action]')?.dataset?.claRegexAction;
            if (action === 'select-visible') this.selectVisibleRows(true);
            if (action === 'clear') this.clearRowSelection();
            if (action === 'create-collection') {
                const input = root.querySelector('[data-cla-regex-new-name]');
                if (this.runCollectionAction(() => this.createCollection(root.querySelector('[data-cla-regex-new-scope]').value, input.value))) input.value = '';
            }
            if (action === 'move-selected') this.runCollectionAction(() => this.moveSelectedToCollection(root.querySelector('[data-cla-regex-move-target]').value));
        });
        return root;
    }

    enhanceRegexUi() {
        if (!this.started) return;
        const settings = document.querySelector('#regex_container .regex_settings');
        if (!settings) return;
        const primaryActions = settings.querySelector('.inline-drawer-content > .flex-container');
        if (!this.organizerButton?.isConnected && primaryActions) {
            this.organizerButton = this.createOrganizerButton();
            primaryActions.append(this.organizerButton);
        }
        if (!this.reorderButton?.isConnected && primaryActions) {
            this.reorderButton = this.createReorderButton();
            primaryActions.append(this.reorderButton);
        }
        if (!this.organizerRoot?.isConnected) {
            this.organizerRoot = this.createOrganizer();
            primaryActions?.after(this.organizerRoot);
        }
        this.refreshOrganizerRows();
    }

    getRows() {
        return [...document.querySelectorAll(REGEX_ROW_SELECTOR)];
    }

    getVisibleRows() {
        return this.getRows().filter(row => !row.hidden)
            .sort((left, right) => Number(left.style?.getPropertyValue('--cla-regex-order') || 0)
                - Number(right.style?.getPropertyValue('--cla-regex-order') || 0));
    }

    refreshOrganizerRows() {
        const rows = this.getRows();
        const collections = new Map();
        for (const scope of Object.values(TYPE_BY_LIST_ID)) {
            for (const name of this.getCollectionState(scope).groups) collections.set(name, 0);
        }
        for (const row of rows) {
            const label = row.querySelector('.regex_script_name');
            const name = String(label?.textContent || '').trim();
            if (label) label.title = name;
            const collection = this.getAssignedCollection(getTypeKey(row), row.id, name);
            row.dataset.claRegexCollection = collection;
            row.dataset.claRegexScope = getTypeKey(row) || '';
            collections.set(collection, (collections.get(collection) || 0) + 1);
            row.classList.toggle('cla-regex-selected', Boolean(row.querySelector('.regex_bulk_checkbox')?.checked));
            if (!row.querySelector('.cla-regex-group-handle') && label) {
                const handle = document.createElement('button');
                handle.type = 'button';
                handle.className = 'cla-regex-group-handle';
                handle.textContent = '↪';
                handle.title = '拖到分组：已选行可一起归组';
                handle.setAttribute('aria-label', '拖动正则归组');
                label.before(handle);
            }
        }
        const select = this.organizerRoot?.querySelector('[data-cla-regex-collection]');
        if (select) {
            const previous = select.value || 'all';
            select.replaceChildren();
            const all = document.createElement('option');
            all.value = 'all';
            all.textContent = `全部合集 (${rows.length})`;
            select.append(all);
            [...collections.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-CN')).forEach(([name, count]) => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = `${name} (${count})`;
                select.append(option);
            });
            select.value = [...select.options].some(option => option.value === previous) ? previous : 'all';
        }
        const moveTarget = this.organizerRoot?.querySelector('[data-cla-regex-move-target]');
        if (moveTarget) {
            const previous = moveTarget.value;
            moveTarget.replaceChildren();
            for (const name of new Set([UNGROUPED_COLLECTION, ...collections.keys()])) {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name === UNGROUPED_COLLECTION ? '移至未分类' : name;
                moveTarget.append(option);
            }
            if ([...moveTarget.options].some(option => option.value === previous)) moveTarget.value = previous;
        }
        this.refreshCollectionFolds();
        this.applyOrganizerFilters();
    }

    refreshCollectionFolds() {
        this.clearCollectionFolds();
        const grouped = this.autoCollapseCollections && !this.reorderMode;
        if (this.reorderButton) {
            this.reorderButton.hidden = !this.autoCollapseCollections;
            this.reorderButton.textContent = this.reorderMode ? '返回合集' : '调整顺序';
            this.reorderButton.setAttribute('aria-pressed', String(this.reorderMode));
        }
        if (!grouped) return;

        let order = 0;
        for (const list of document.querySelectorAll(REGEX_LIST_SELECTOR)) {
            const collections = new Map();
            const scope = TYPE_BY_LIST_ID[list.id];
            // Leave rows as direct children in their original DOM order: native
            // saving reads list.children. Only the flex display order is grouped.
            for (const row of [...list.children].filter(node => node.matches('.regex-script-label'))) {
                const collection = row.dataset.claRegexCollection;
                if (!collections.has(collection)) collections.set(collection, []);
                collections.get(collection).push(row);
            }
            for (const name of this.getCollectionState(scope).groups) {
                if (!collections.has(name)) collections.set(name, []);
            }
            if (!collections.size) continue;
            list.classList.add('cla-regex-grouped-list');
            for (const [collection, rows] of collections) {
                const key = getRegexCollectionKey(TYPE_BY_LIST_ID[list.id], collection);
                const header = document.createElement('div');
                header.className = 'cla-regex-collection-header';
                header.dataset.claRegexFold = collection;
                header.dataset.claRegexDropCollection = collection;
                header.dataset.claRegexDropScope = scope;
                header.style.order = String(order++);
                const toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.className = 'cla-regex-collection-toggle';
                const arrow = document.createElement('span');
                arrow.className = 'cla-regex-collection-arrow';
                arrow.setAttribute('aria-hidden', 'true');
                arrow.textContent = '▸';
                const name = document.createElement('span');
                name.className = 'cla-regex-collection-name';
                name.textContent = collection;
                const count = document.createElement('small');
                toggle.append(arrow, name, count);
                toggle.addEventListener('click', () => {
                    if (this.openCollections.has(key)) this.openCollections.delete(key);
                    else this.openCollections.add(key);
                    this.applyOrganizerFilters();
                });
                const selectAll = document.createElement('button');
                selectAll.type = 'button';
                selectAll.className = 'menu_button cla-regex-collection-select';
                selectAll.textContent = '选择此合集';
                selectAll.disabled = rows.length === 0;
                selectAll.addEventListener('click', () => {
                    this.enableBulkEdit();
                    this.setRowsSelected(rows.filter(row => this.rowMatchesOrganizer(row)), true);
                    this.updateOrganizerCount();
                });
                const rename = document.createElement('button');
                rename.type = 'button';
                rename.className = 'menu_button cla-regex-collection-rename';
                rename.textContent = '改名';
                rename.title = `重命名${collection}`;
                const form = document.createElement('form');
                form.className = 'cla-regex-rename-form';
                form.hidden = true;
                const input = document.createElement('input');
                input.className = 'text_pole';
                input.value = collection;
                input.maxLength = 60;
                input.setAttribute('aria-label', '分组新名称');
                const submit = document.createElement('button');
                submit.type = 'submit';
                submit.className = 'menu_button';
                submit.textContent = '保存';
                const cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.className = 'menu_button';
                cancel.textContent = '取消';
                form.append(input, submit, cancel);
                const showRename = editing => {
                    form.hidden = !editing;
                    toggle.hidden = selectAll.hidden = rename.hidden = editing;
                    if (editing) { input.focus(); input.select(); }
                };
                rename.addEventListener('click', () => showRename(true));
                cancel.addEventListener('click', () => showRename(false));
                input.addEventListener('keydown', event => {
                    if (event.key === 'Escape') { event.preventDefault(); showRename(false); }
                });
                const context = this.getCollectionContext(scope);
                form.addEventListener('submit', event => {
                    event.preventDefault();
                    this.runCollectionAction(() => {
                        if (context !== this.getCollectionContext(scope)) throw new Error('预设或角色已切换，请重新操作');
                        this.renameCollection(scope, collection, input.value);
                        showRename(false);
                    });
                });
                header.append(toggle, selectAll, rename, form);
                // Headers have no script ID or drag handle and cannot be saved
                // as regexes. Grouped mode offers an explicit native-order view.
                list.insertBefore(header, rows[0] || null);
                rows.forEach(row => {
                    row.classList.add('cla-regex-grouped-row');
                    row.style.setProperty('--cla-regex-order', String(order++));
                });
                this.collectionGroups.push({ header, toggle, count, key, rows, collection, scope });
            }
        }
    }

    clearCollectionFolds() {
        document.querySelectorAll('[data-cla-regex-fold]').forEach(header => header.remove());
        document.querySelectorAll('.cla-regex-grouped-list').forEach(list => list.classList.remove('cla-regex-grouped-list'));
        this.getRows().forEach(row => {
            row.classList.remove('cla-regex-grouped-row');
            row.style.removeProperty('--cla-regex-order');
        });
        this.collectionGroups = [];
    }

    rowMatchesOrganizer(row) {
        if (!this.organizerOpen) return true;
        const root = this.organizerRoot;
        return matchesRegexOrganizerFilter({
            name: String(row.querySelector('.regex_script_name')?.textContent || '').trim(),
            collection: row.dataset.claRegexCollection,
            scope: row.dataset.claRegexScope,
            query: root?.querySelector('[data-cla-regex-search]')?.value || '',
            selectedCollection: root?.querySelector('[data-cla-regex-collection]')?.value || 'all',
            selectedScope: root?.querySelector('[data-cla-regex-scope]')?.value || 'all',
        });
    }

    applyOrganizerFilters() {
        const grouped = this.autoCollapseCollections && !this.reorderMode;
        const rows = this.getRows();
        let visible = 0;
        for (const row of rows) {
            const show = this.rowMatchesOrganizer(row)
                && shouldShowRegexOrganizerRow({
                    collection: row.dataset.claRegexCollection,
                    scope: row.dataset.claRegexScope,
                    autoCollapse: grouped,
                    openCollections: this.openCollections,
                });
            row.hidden = !show;
            if (show) visible += 1;
        }
        for (const { header, toggle, count, key, rows: members, collection, scope } of this.collectionGroups) {
            const matching = members.filter(row => this.rowMatchesOrganizer(row)).length;
            const emptyMatches = !this.organizerOpen || matchesRegexOrganizerFilter({
                name: collection, collection, scope,
                query: this.organizerRoot?.querySelector('[data-cla-regex-search]')?.value || '',
                selectedCollection: this.organizerRoot?.querySelector('[data-cla-regex-collection]')?.value || 'all',
                selectedScope: this.organizerRoot?.querySelector('[data-cla-regex-scope]')?.value || 'all',
            });
            header.hidden = members.length ? matching === 0 : !emptyMatches;
            toggle.setAttribute('aria-expanded', String(this.openCollections.has(key)));
            count.textContent = `${matching} 条`;
        }
        this.updateOrganizerCount(visible);
    }

    updateOrganizerCount(visible = this.getVisibleRows().length) {
        const selected = this.getRows().filter(row => row.querySelector('.regex_bulk_checkbox')?.checked).length;
        const counter = this.organizerRoot?.querySelector('[data-cla-regex-count]');
        if (counter) counter.textContent = `${visible} 条·已选 ${selected} 条`;
    }

    toggleOrganizer() {
        this.organizerOpen = !this.organizerOpen;
        if (this.organizerRoot) this.organizerRoot.hidden = !this.organizerOpen;
        this.organizerButton?.classList?.toggle('active', this.organizerOpen);
        this.organizerButton?.setAttribute?.('aria-pressed', String(this.organizerOpen));
        if (this.organizerOpen) this.enableBulkEdit();
        this.applyOrganizerFilters();
    }

    enableBulkEdit() {
        const bulkEdit = document.querySelector('#regex_bulk_edit');
        if (!bulkEdit || bulkEdit.checked) return;
        bulkEdit.checked = true;
        bulkEdit.dispatchEvent(new Event('change', { bubbles: true }));
    }

    setRowSelected(row, selected, { notify = true } = {}) {
        const checkbox = row?.querySelector?.('.regex_bulk_checkbox');
        if (!checkbox || checkbox.checked === selected) return false;
        checkbox.checked = selected;
        row.classList?.toggle?.('cla-regex-selected', selected);
        if (notify) checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    setRowsSelected(rows, selected) {
        let changed;
        for (const row of rows) if (this.setRowSelected(row, selected, { notify: false })) changed = row;
        // Native change handlers read the complete selection, not only this row.
        changed?.querySelector('.regex_bulk_checkbox')?.dispatchEvent(new Event('change', { bubbles: true }));
    }

    selectRow(row, selected, { range = false } = {}) {
        this.enableBulkEdit();
        const visibleRows = this.getVisibleRows();
        if (range && this.lastSelectedRow && visibleRows.includes(this.lastSelectedRow)) {
            const start = visibleRows.indexOf(this.lastSelectedRow);
            const end = visibleRows.indexOf(row);
            this.setRowsSelected(visibleRows.slice(Math.min(start, end), Math.max(start, end) + 1), selected);
        } else {
            this.setRowSelected(row, selected);
        }
        this.lastSelectedRow = row;
        this.updateOrganizerCount();
    }

    selectVisibleRows(selected) {
        this.enableBulkEdit();
        this.setRowsSelected(this.getVisibleRows(), selected);
        this.updateOrganizerCount();
    }

    clearRowSelection() {
        this.setRowsSelected(this.getRows(), false);
        this.lastSelectedRow = null;
        this.updateOrganizerCount();
    }

    isRowSelectionEnabled() {
        return this.organizerOpen || Boolean(document.querySelector('#regex_bulk_edit')?.checked);
    }

    getType(typeKey) {
        return typeKey ? this.engine?.SCRIPT_TYPES?.[typeKey] : undefined;
    }

    getToggleContext(element) {
        const label = element.closest('.regex-script-label[id]');
        const type = this.getType(getTypeKey(element));
        const checkbox = label?.querySelector('.disable_regex');
        if (!label || !checkbox || type === undefined) return null;
        const scripts = this.engine?.getScriptsByType?.(type);
        if (typeof this.engine?.saveScriptsByType !== 'function'
            || !scripts?.some(script => String(script.id) === label.id)) return null;
        return { label, type, checkbox };
    }

    enqueue(task) {
        const generation = this.generation;
        const run = () => this.started && generation === this.generation ? task() : undefined;
        this.saveQueue = this.saveQueue.then(run, run).catch(error => {
            console.error('[Cloud Lounge Accelerator] 正则保存适配失败', error);
            globalThis.toastr?.error?.(`操作未完成：${error.message || '请检查连接后重试'}`, '云酒馆加速器');
        });
        return this.saveQueue;
    }

    onClick(event) {
        if (!this.started || !(event.target instanceof Element)) return;
        const target = event.target;
        if (target.closest('.cla-regex-organizer-toggle')) {
            event.preventDefault();
            this.toggleOrganizer();
            return;
        }

        const rowName = target.closest('.regex_script_name');
        const row = rowName?.closest?.('.regex-script-label');
        if (row && this.isRowSelectionEnabled()) {
            event.preventDefault();
            event.stopPropagation();
            if (performance.now() < this.suppressRowClickUntil) return;
            const checkbox = row.querySelector('.regex_bulk_checkbox');
            this.selectRow(row, !checkbox?.checked, { range: event.shiftKey });
            return;
        }
        const editButton = target.closest('.edit_existing_regex');
        if (editButton) {
            const label = editButton.closest('.regex-script-label[id]');
            const typeKey = getTypeKey(editButton);
            this.editorContext = label && typeKey ? { id: label.id, typeKey, scopeKey: this.getCollectionContext(typeKey), opened: false } : null;
            return;
        }

        if (target.closest('#open_regex_editor, #open_scoped_editor, #open_preset_editor')) {
            this.editorContext = null;
            return;
        }

        const saveButton = target.closest('.popup-button-ok');
        const popup = saveButton?.closest('.popup');
        const editor = popup?.querySelector('.regex_editor');
        const popupInstance = this.popupApi.Popup?.util?.popups?.find(item => item.dlg === popup);
        if (saveButton && popup && editor && this.editorContext && popupInstance) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (this.busyEditors.has(editor)) return;
            const context = { ...this.editorContext };
            const previous = this.engine.getScriptsByType(this.getType(context.typeKey))?.find(script => String(script.id) === String(context.id));
            if (!previous) return;
            const draft = readEditorDraft(editor, context.id, previous);
            if (!draft.scriptName) {
                globalThis.toastr?.error?.('正则名称不能为空', '云酒馆加速器');
                return;
            }
            const busyEditors = this.busyEditors;
            busyEditors.add(editor);
            const restore = this.markBusy(saveButton, '正在保存…');
            this.enqueue(async () => {
                try { await this.saveExistingEditor({ popupInstance, editor, context, draft }); }
                finally { restore(); busyEditors.delete(editor); }
            });
            return;
        }

        const deleteButton = target.closest('.delete_regex, #bulk_delete_regex');
        if (deleteButton && typeof this.popupApi.Popup?.show?.confirm === 'function') {
            const labels = deleteButton.id === 'bulk_delete_regex'
                ? this.getRows().filter(row => row.querySelector('.regex_bulk_checkbox')?.checked)
                : [deleteButton.closest('.regex-script-label[id]')].filter(Boolean);
            if (!labels.length || labels.some(label => !this.getToggleContext(label))) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (this.deletePending) return;
            const pending = {};
            this.deletePending = pending;
            const contexts = new Map(labels.map(label => [getTypeKey(label), this.getCollectionContext(getTypeKey(label))]));
            const restore = this.markBusy(deleteButton, '等待确认…');
            this.enqueue(async () => {
                try {
                    const confirmed = await this.popupApi.Popup.show.confirm('删除正则', `确定删除选中的 ${labels.length} 条正则吗？`);
                    if (!confirmed || !this.started) return;
                    restore.update('正在删除…');
                    await this.saveDelete(labels, contexts);
                } finally { restore(); if (this.deletePending === pending) this.deletePending = false; }
            });
            return;
        }

        const toggleIcon = target.closest('.regex-toggle-on, .regex-toggle-off');
        if (toggleIcon) {
            // Scope permission switches reuse these icons. Leave their native
            // label/checkbox activation intact; only own known script rows.
            const context = this.getToggleContext(toggleIcon);
            if (!context) return;
            const disabled = toggleIcon.classList.contains('regex-toggle-on');
            event.preventDefault();
            event.stopImmediatePropagation();
            context.checkbox.checked = disabled;
            this.enqueue(() => this.saveToggle(toggleIcon, disabled));
            return;
        }

        const bulkButton = target.closest('#bulk_enable_regex, #bulk_disable_regex');
        if (bulkButton) {
            const selected = [...document.querySelectorAll('#regex_container .regex-script-label:has(.regex_bulk_checkbox:checked)')];
            if (!selected.length) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            this.enqueue(() => this.saveBulkToggle(selected, bulkButton.id === 'bulk_disable_regex'));
        }
    }

    onInput(event) {
        if (!this.started || !(event.target instanceof HTMLInputElement)) return;
        if (!event.target.matches('.disable_regex')) return;
        if (!this.getToggleContext(event.target)) return;
        const disabled = event.target.checked;
        event.stopImmediatePropagation();
        this.enqueue(() => this.saveToggle(event.target, disabled));
    }

    onChange(event) {
        if (!this.started || !event.target?.matches?.('.regex_bulk_checkbox')) return;
        const row = event.target.closest?.('.regex-script-label');
        row?.classList?.toggle?.('cla-regex-selected', event.target.checked);
        this.updateOrganizerCount();
    }

    onPointerDown(event) {
        if (!this.started || event.button > 0 || event.isPrimary === false || this.groupDrag || this.selectionGesture) return;
        const handle = event.target?.closest?.('.cla-regex-group-handle');
        if (handle) {
            const row = handle.closest('.regex-script-label');
            if (!row || row.hidden) return;
            const scope = getTypeKey(row);
            const selected = Boolean(row.querySelector('.regex_bulk_checkbox')?.checked);
            const rows = selected ? this.getRows().filter(item => getTypeKey(item) === scope && item.querySelector('.regex_bulk_checkbox')?.checked) : [row];
            this.groupDrag = { pointerId: event.pointerId, source: handle, scope, context: this.getCollectionContext(scope), rows,
                x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, active: false, target: null };
            this.groupDrag.scroller = this.findGestureScroller(row);
            handle.setPointerCapture?.(event.pointerId);
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (!this.organizerOpen) return;
        if (!this.organizerRoot?.querySelector('[data-cla-regex-drag]')?.checked) return;
        const row = event.target?.closest?.('.regex_script_name')?.closest?.('.regex-script-label');
        if (!row || row.hidden) return;
        event.preventDefault();
        const checkbox = row.querySelector('.regex_bulk_checkbox');
        const selected = !checkbox?.checked;
        const visible = this.getVisibleRows();
        this.enableBulkEdit();
        this.selectionGesture = { pointerId: event.pointerId, selected, rows: new Set([row]), visible,
            lastIndex: visible.indexOf(row), source: event.target, x: event.clientX, y: event.clientY, changed: null,
            scroller: this.findGestureScroller(row) };
        this.suppressRowClickUntil = performance.now() + 500;
        if (this.setRowSelected(row, selected, { notify: false })) this.selectionGesture.changed = row;
        event.target.setPointerCapture?.(event.pointerId);
        this.queuePointerFrame();
    }

    onPointerMove(event) {
        const gesture = this.groupDrag || this.selectionGesture;
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        gesture.x = event.clientX;
        gesture.y = event.clientY;
        event.preventDefault();
        if (this.groupDrag) event.stopImmediatePropagation();
        this.queuePointerFrame();
    }

    findGestureScroller(row) {
        for (let node = row.parentElement; node && node !== document.body; node = node.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
        }
        return document.scrollingElement;
    }

    queuePointerFrame() {
        if (this.pointerFrame !== null) return;
        this.pointerFrame = requestAnimationFrame(() => {
            this.pointerFrame = null;
            const gesture = this.groupDrag || this.selectionGesture;
            if (!gesture || !this.started) return;
            this.paintPointerGesture();
            const scroller = gesture.scroller;
            if (scroller) {
                const rect = scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
                const speed = gesture.y < rect.top + 40 ? -12 : gesture.y > rect.bottom - 40 ? 12 : 0;
                if (speed) {
                    const before = scroller.scrollTop;
                    scroller.scrollTop += speed;
                    if (before !== scroller.scrollTop) this.queuePointerFrame();
                }
            }
        });
    }

    paintPointerGesture() {
        if (this.groupDrag) {
            const drag = this.groupDrag;
            if (!drag.source.isConnected || drag.context !== this.getCollectionContext(drag.scope)) { this.finishPointerGesture(false); return; }
            if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 5) return;
            if (!drag.active) {
                drag.active = true;
                const tray = document.createElement('div');
                tray.className = 'cla-regex-drop-tray';
                const label = document.createElement('strong');
                label.textContent = `拖动 ${drag.rows.length} 条正则，松手归入：`;
                tray.append(label);
                for (const name of new Set([UNGROUPED_COLLECTION, ...this.getScopeCollections(drag.scope)])) {
                    const target = document.createElement('button');
                    target.type = 'button';
                    target.textContent = name;
                    target.dataset.claRegexDropCollection = name;
                    target.dataset.claRegexDropScope = drag.scope;
                    tray.append(target);
                }
                const bounds = document.querySelector('#regex_container').getBoundingClientRect();
                Object.assign(tray.style, { left: `${Math.max(8, bounds.left)}px`, top: '8px',
                    width: `${Math.min(bounds.width, innerWidth - Math.max(8, bounds.left) - 8)}px` });
                document.body.append(tray);
                drag.tray = tray;
                drag.rows.forEach(row => row.classList.add('cla-regex-group-dragging'));
            }
            const target = document.elementFromPoint(drag.x, drag.y)?.closest?.('[data-cla-regex-drop-collection]');
            const valid = target?.dataset.claRegexDropScope === drag.scope ? target : null;
            if (drag.target !== valid) {
                drag.target?.classList.remove('cla-regex-drop-active');
                drag.target = valid;
                valid?.classList.add('cla-regex-drop-active');
            }
            return;
        }
        const gesture = this.selectionGesture;
        if (!gesture) return;
        const hit = document.elementFromPoint?.(gesture.x, gesture.y);
        const row = hit?.closest?.('.regex-script-label');
        const index = row && !row.hidden ? gesture.visible.indexOf(row) : -1;
        if (index >= 0) {
            // Fill every crossed visual row even if pointer events skip items.
            for (const member of gesture.visible.slice(Math.min(gesture.lastIndex, index), Math.max(gesture.lastIndex, index) + 1)) {
                if (gesture.rows.has(member)) continue;
                gesture.rows.add(member);
                if (this.setRowSelected(member, gesture.selected, { notify: false })) gesture.changed = member;
            }
            gesture.lastIndex = index;
            this.lastSelectedRow = row;
        }
        if (gesture.changed) {
            gesture.changed.querySelector('.regex_bulk_checkbox')?.dispatchEvent(new Event('change', { bubbles: true }));
            gesture.changed = null;
        }
        this.updateOrganizerCount();
    }

    onPointerEnd(event) {
        const gesture = this.groupDrag || this.selectionGesture;
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        gesture.x = event.clientX;
        gesture.y = event.clientY;
        if (event.type !== 'pointercancel') this.paintPointerGesture();
        this.finishPointerGesture(event.type !== 'pointercancel');
    }

    finishPointerGesture(commit) {
        if (this.pointerFrame !== null) cancelAnimationFrame(this.pointerFrame);
        this.pointerFrame = null;
        const drag = this.groupDrag;
        const selection = this.selectionGesture;
        this.groupDrag = null;
        this.selectionGesture = null;
        const source = drag?.source || selection?.source;
        const pointerId = drag?.pointerId ?? selection?.pointerId;
        if (source?.hasPointerCapture?.(pointerId)) source.releasePointerCapture(pointerId);
        if (selection?.changed) selection.changed.querySelector('.regex_bulk_checkbox')?.dispatchEvent(new Event('change', { bubbles: true }));
        if (drag) {
            const name = drag.target?.dataset.claRegexDropCollection;
            drag.target?.classList.remove('cla-regex-drop-active');
            drag.rows.forEach(row => row.classList.remove('cla-regex-group-dragging'));
            drag.tray?.remove();
            if (commit && drag.active && name) this.runCollectionAction(() => {
                if (drag.context !== this.getCollectionContext(drag.scope)) throw new Error('预设或角色已切换，请重新拖动');
                this.moveRowsToCollection(drag.rows, name);
            });
        }
        this.suppressRowClickUntil = performance.now() + 350;
    }

    markBusy(button, text) {
        const old = { disabled: button.disabled, busy: button.getAttribute('aria-busy'), title: button.title };
        const note = document.createElement('span');
        note.className = 'cla-regex-operation-status';
        note.setAttribute('role', 'status');
        note.textContent = text;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.title = text;
        button.after(note);
        const restore = () => {
            button.disabled = old.disabled;
            if (old.busy === null) button.removeAttribute('aria-busy'); else button.setAttribute('aria-busy', old.busy);
            button.title = old.title;
            note.remove();
            this.pendingRestores.delete(restore);
        };
        restore.update = value => { note.textContent = value; button.title = value; };
        this.pendingRestores.add(restore);
        return restore;
    }

    async persistScripts(type, scripts, { allowScope = true, scopeKey = undefined } = {}) {
        const scope = Object.keys(this.engine.SCRIPT_TYPES).find(key => this.engine.SCRIPT_TYPES[key] === type);
        if (scopeKey !== undefined && scopeKey !== this.getCollectionContext(scope)) throw new Error('预设或角色已切换，请重新操作');
        const previous = [...(this.engine.getScriptsByType(type) || [])];
        const engine = this.engine;
        try { await engine.saveScriptsByType(scripts, type); }
        catch (error) {
            // Native preset saving updates memory before awaiting the server.
            // Restore only our own array; never overwrite a newer external edit.
            if (this.engine === engine && this.getCollectionContext(scope) === (scopeKey ?? this.getCollectionContext(scope))
                && engine.getScriptsByType(type) === scripts) scripts.splice(0, scripts.length, ...previous);
            throw error;
        }
        if (!this.started || this.engine !== engine || (scopeKey !== undefined && scopeKey !== this.getCollectionContext(scope))) return;
        if (allowScope && type === this.engine.SCRIPT_TYPES.SCOPED) {
            this.engine.allowScopedScripts?.(this.scriptApi.characters?.[this.scriptApi.this_chid]);
        } else if (allowScope && type === this.engine.SCRIPT_TYPES.PRESET) {
            this.engine.allowPresetScripts?.(this.engine.getCurrentPresetAPI?.(), this.engine.getCurrentPresetName?.());
        }
        // Native compilation is keyed by the fully expanded findRegex string.
        // Changing a rule does not invalidate every other compiled pattern.
        // GLOBAL already schedules its save. Scoped/preset writes are awaited
        // by the official API; permission helpers save only when they change.
    }

    async saveExistingEditor({ popupInstance, editor, context, draft: capturedDraft = null }) {
        const type = this.getType(context.typeKey);
        const scripts = [...(this.engine.getScriptsByType?.(type) || [])];
        const index = scripts.findIndex(script => String(script.id) === String(context.id));
        if (type === undefined || index < 0) throw new Error('找不到正在编辑的正则');
        if (context.scopeKey !== undefined && context.scopeKey !== this.getCollectionContext(context.typeKey)) throw new Error('预设或角色已切换，请重新打开编辑器');
        const draft = capturedDraft || readEditorDraft(editor, context.id, scripts[index]);
        if (!draft.scriptName) {
            globalThis.toastr?.error?.('正则名称不能为空', '云酒馆加速器');
            return;
        }
        const changed = JSON.stringify(scripts[index]) !== JSON.stringify(draft);
        const previousScript = scripts[index];
        if (changed) {
            scripts[index] = draft;
            await this.persistScripts(type, scripts, { scopeKey: context.scopeKey });
            // Native row export/move handlers retain their original object.
            Object.assign(previousScript, draft);
        }
        if (!this.started || (context.scopeKey !== undefined && context.scopeKey !== this.getCollectionContext(context.typeKey))) return;
        const labelName = document.getElementById(context.id)?.querySelector('.regex_script_name');
        if (labelName) {
            labelName.textContent = draft.scriptName;
            labelName.title = draft.scriptName;
        }
        const checkbox = document.getElementById(context.id)?.querySelector('.disable_regex');
        if (checkbox) checkbox.checked = Boolean(draft.disabled);
        if (capturedDraft && JSON.stringify(readEditorDraft(editor, context.id, draft)) !== JSON.stringify(draft)) {
            if (changed) this.onSaved?.();
            globalThis.toastr?.info?.('上一版已保存，窗口中还有新的修改，请再次保存', '云酒馆加速器');
            return;
        }
        // Start native closing before scheduling expensive chat impact work.
        const closing = popupInstance.completeCancelled();
        if (this.editorContext?.id === context.id) this.editorContext = null;
        if (changed) this.onSaved?.();
        await closing;
    }

    async saveDelete(labels, contexts) {
        const grouped = new Map();
        for (const label of labels) {
            const scope = getTypeKey(label);
            if (!grouped.has(scope)) grouped.set(scope, []);
            grouped.get(scope).push(label);
        }
        let completed = 0;
        const failures = [];
        for (const [scope, rows] of grouped) {
            try {
                if (!this.started || contexts.get(scope) !== this.getCollectionContext(scope)) throw new Error('预设或角色已切换');
                const type = this.getType(scope);
                const current = this.engine.getScriptsByType(type) || [];
                const ids = new Set(rows.map(row => row.id));
                const next = current.filter(script => !ids.has(String(script.id)));
                if (next.length === current.length) continue;
                await this.persistScripts(type, next, { allowScope: false, scopeKey: contexts.get(scope) });
                completed += current.length - next.length;
                if (this.started && contexts.get(scope) === this.getCollectionContext(scope)) rows.forEach(row => row.remove());
            } catch (error) { failures.push(error.message); }
        }
        if (completed && this.started) {
            this.scheduleOrganizerRefresh();
            this.onSaved?.();
        }
        if (failures.length) throw new Error(`已删除 ${completed} 条；未完成的规则已保留：${failures.join('；')}`);
    }

    async saveToggle(element, disabled) {
        const label = element.closest('.regex-script-label[id]');
        const type = this.getType(getTypeKey(element));
        if (!label || type === undefined) return;
        const scripts = [...(this.engine.getScriptsByType?.(type) || [])];
        const index = scripts.findIndex(script => String(script.id) === label.id);
        if (index < 0 || Boolean(scripts[index].disabled) === Boolean(disabled)) return;
        scripts[index] = { ...scripts[index], disabled: Boolean(disabled) };
        await this.persistScripts(type, scripts);
        const checkbox = label.querySelector('.disable_regex');
        if (checkbox) checkbox.checked = Boolean(disabled);
        this.onSaved?.();
    }

    async saveBulkToggle(labels, disabled) {
        const grouped = new Map();
        for (const label of labels) {
            const type = this.getType(getTypeKey(label));
            if (type === undefined) continue;
            if (!grouped.has(type)) grouped.set(type, new Set());
            grouped.get(type).add(label.id);
        }
        let changed = false;
        for (const [type, ids] of grouped) {
            const current = this.engine.getScriptsByType?.(type) || [];
            const scripts = current.map(script => ids.has(String(script.id))
                ? { ...script, disabled: Boolean(disabled) }
                : script);
            if (scripts.some((script, index) => script !== current[index] && Boolean(current[index].disabled) !== Boolean(disabled))) {
                await this.persistScripts(type, scripts);
                changed = true;
            }
        }
        labels.forEach(label => {
            const checkbox = label.querySelector('.disable_regex');
            if (checkbox) checkbox.checked = Boolean(disabled);
        });
        if (changed) this.onSaved?.();
    }

    stop() {
        if (!this.started) return;
        this.started = false;
        this.generation += 1;
        this.finishPointerGesture(false);
        for (const restore of [...this.pendingRestores]) restore();
        this.busyEditors = new WeakSet();
        this.deletePending = false;
        document.removeEventListener('click', this.onClick, true);
        document.removeEventListener('input', this.onInput, true);
        document.removeEventListener('change', this.onChange, true);
        document.removeEventListener('pointerdown', this.onPointerDown, true);
        document.removeEventListener('pointermove', this.onPointerMove, true);
        document.removeEventListener('pointerup', this.onPointerEnd, true);
        document.removeEventListener('pointercancel', this.onPointerEnd, true);
        document.removeEventListener('lostpointercapture', this.onLostPointerCapture, true);
        this.observer?.disconnect();
        this.observer = null;
        clearTimeout(this.organizerTimer);
        this.organizerTimer = null;
        this.getRows().forEach(row => {
            row.querySelector('.cla-regex-group-handle')?.remove();
            row.hidden = false;
            row.classList?.remove?.('cla-regex-selected');
            if (row.dataset) {
                delete row.dataset.claRegexCollection;
                delete row.dataset.claRegexScope;
            }
        });
        document.querySelector('#regex_container')?.classList?.remove?.('cla-regex-drag-selecting');
        this.organizerButton?.remove?.();
        this.reorderButton?.remove?.();
        this.clearCollectionFolds();
        this.organizerRoot?.remove?.();
        this.organizerButton = null;
        this.reorderButton = null;
        this.organizerRoot = null;
        this.organizerOpen = false;
        this.autoCollapseCollections = true;
        this.openCollections = createDefaultOpenCollections();
        this.reorderMode = false;
        this.lastSelectedRow = null;
        this.selectionGesture = null;
        this.editorContext = null;
        this.engine = null;
        this.popupApi = null;
        this.scriptApi = null;
    }
}
