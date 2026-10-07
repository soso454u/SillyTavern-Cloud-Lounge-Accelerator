const TYPE_BY_LIST_ID = Object.freeze({
    saved_regex_scripts: 'GLOBAL',
    saved_scoped_scripts: 'SCOPED',
    saved_preset_scripts: 'PRESET',
});

const REGEX_LIST_SELECTOR = '#saved_regex_scripts, #saved_scoped_scripts, #saved_preset_scripts';
const REGEX_ROW_SELECTOR = `${REGEX_LIST_SELECTOR.split(', ').map(selector => `${selector} .regex-script-label`).join(', ')}`;
const UNGROUPED_COLLECTION = '未分类';

export function getRegexCollectionName(scriptName) {
    const name = String(scriptName || '').trim();
    const bracketed = name.match(/^(?:\[([^\]]+)\]|【([^】]+)】|〔([^〕]+)〕)/u);
    const collection = bracketed?.slice(1).find(Boolean)?.trim();
    return collection || UNGROUPED_COLLECTION;
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
    if (target?.closest?.(REGEX_LIST_SELECTOR)) return true;
    return [...(record.addedNodes || []), ...(record.removedNodes || [])].some(node => (
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
    constructor({ onSaved = null } = {}) {
        this.onSaved = onSaved;
        this.started = false;
        this.engine = null;
        this.popupApi = null;
        this.scriptApi = null;
        this.editorContext = null;
        this.saveQueue = Promise.resolve();
        this.observer = null;
        this.organizerButton = null;
        this.organizerRoot = null;
        this.organizerTimer = null;
        this.organizerOpen = false;
        this.lastSelectedRow = null;
        this.selectionGesture = null;
        this.suppressRowClickUntil = 0;
        this.onClick = this.onClick.bind(this);
        this.onInput = this.onInput.bind(this);
        this.onChange = this.onChange.bind(this);
        this.onPointerDown = this.onPointerDown.bind(this);
        this.onPointerMove = this.onPointerMove.bind(this);
        this.onPointerEnd = this.onPointerEnd.bind(this);
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
        this.started = true;
        document.addEventListener('click', this.onClick, true);
        document.addEventListener('input', this.onInput, true);
        document.addEventListener('change', this.onChange, true);
        document.addEventListener('pointerdown', this.onPointerDown, true);
        document.addEventListener('pointermove', this.onPointerMove, { capture: true, passive: false });
        document.addEventListener('pointerup', this.onPointerEnd, true);
        document.addEventListener('pointercancel', this.onPointerEnd, true);
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
                <label class="checkbox_label cla-regex-drag-option">
                    <input type="checkbox" data-cla-regex-drag />
                    <span>按住名称划选多条</span>
                </label>
            </div>
            <small class="cla-regex-organizer-hint">点名称即可勾选；Shift 点击可连选。带 [合集名] 或【合集名】前缀的正则会自动收纳到同一合集。</small>
        `;
        root.addEventListener('input', event => {
            if (event.target?.matches?.('[data-cla-regex-search]')) this.applyOrganizerFilters();
        });
        root.addEventListener('change', event => {
            if (event.target?.matches?.('[data-cla-regex-collection], [data-cla-regex-scope]')) {
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
        return this.getRows().filter(row => !row.hidden);
    }

    refreshOrganizerRows() {
        const rows = this.getRows();
        const collections = new Map();
        for (const row of rows) {
            const name = String(row.querySelector('.regex_script_name')?.textContent || '').trim();
            const collection = getRegexCollectionName(name);
            row.dataset.claRegexCollection = collection;
            row.dataset.claRegexScope = getTypeKey(row) || '';
            collections.set(collection, (collections.get(collection) || 0) + 1);
            row.classList.toggle('cla-regex-selected', Boolean(row.querySelector('.regex_bulk_checkbox')?.checked));
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
        this.applyOrganizerFilters();
    }

    applyOrganizerFilters() {
        const root = this.organizerRoot;
        const query = root?.querySelector('[data-cla-regex-search]')?.value || '';
        const selectedCollection = root?.querySelector('[data-cla-regex-collection]')?.value || 'all';
        const selectedScope = root?.querySelector('[data-cla-regex-scope]')?.value || 'all';
        const rows = this.getRows();
        let visible = 0;
        for (const row of rows) {
            const name = String(row.querySelector('.regex_script_name')?.textContent || '').trim();
            const show = !this.organizerOpen || matchesRegexOrganizerFilter({
                name,
                collection: row.dataset.claRegexCollection,
                scope: row.dataset.claRegexScope,
                query,
                selectedCollection,
                selectedScope,
            });
            row.hidden = !show;
            if (show) visible += 1;
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

    setRowSelected(row, selected) {
        const checkbox = row?.querySelector?.('.regex_bulk_checkbox');
        if (!checkbox || checkbox.checked === selected) return;
        checkbox.checked = selected;
        row.classList?.toggle?.('cla-regex-selected', selected);
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }

    selectRow(row, selected, { range = false } = {}) {
        this.enableBulkEdit();
        const visibleRows = this.getVisibleRows();
        if (range && this.lastSelectedRow && visibleRows.includes(this.lastSelectedRow)) {
            const start = visibleRows.indexOf(this.lastSelectedRow);
            const end = visibleRows.indexOf(row);
            visibleRows.slice(Math.min(start, end), Math.max(start, end) + 1)
                .forEach(item => this.setRowSelected(item, selected));
        } else {
            this.setRowSelected(row, selected);
        }
        this.lastSelectedRow = row;
        this.updateOrganizerCount();
    }

    selectVisibleRows(selected) {
        this.enableBulkEdit();
        this.getVisibleRows().forEach(row => this.setRowSelected(row, selected));
        this.updateOrganizerCount();
    }

    clearRowSelection() {
        this.getRows().forEach(row => this.setRowSelected(row, false));
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
        this.saveQueue = this.saveQueue.then(task, task).catch(error => {
            console.error('[Cloud Lounge Accelerator] 正则保存适配失败', error);
            globalThis.toastr?.error?.('正则保存失败，已保留编辑窗口', '云酒馆加速器');
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
            this.editorContext = label && typeKey ? { id: label.id, typeKey, opened: false } : null;
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
            this.enqueue(() => this.saveExistingEditor({ popupInstance, editor, context: this.editorContext }));
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
        if (!this.started || !this.organizerOpen || event.button > 0 || event.isPrimary === false) return;
        if (!this.organizerRoot?.querySelector('[data-cla-regex-drag]')?.checked) return;
        const row = event.target?.closest?.('.regex_script_name')?.closest?.('.regex-script-label');
        if (!row || row.hidden) return;
        event.preventDefault();
        const checkbox = row.querySelector('.regex_bulk_checkbox');
        const selected = !checkbox?.checked;
        this.selectionGesture = { pointerId: event.pointerId, selected, rows: new Set([row]) };
        this.suppressRowClickUntil = performance.now() + 500;
        this.selectRow(row, selected);
    }

    onPointerMove(event) {
        const gesture = this.selectionGesture;
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        event.preventDefault();
        const hit = document.elementFromPoint?.(event.clientX, event.clientY);
        const row = hit?.closest?.('.regex-script-label');
        if (!row || row.hidden || gesture.rows.has(row) || !row.closest?.(REGEX_LIST_SELECTOR)) return;
        gesture.rows.add(row);
        this.setRowSelected(row, gesture.selected);
        this.lastSelectedRow = row;
        this.updateOrganizerCount();
    }

    onPointerEnd(event) {
        if (!this.selectionGesture || event.pointerId !== this.selectionGesture.pointerId) return;
        this.selectionGesture = null;
        this.suppressRowClickUntil = performance.now() + 350;
    }

    async persistScripts(type, scripts) {
        await this.engine.saveScriptsByType(scripts, type);
        if (type === this.engine.SCRIPT_TYPES.SCOPED) {
            this.engine.allowScopedScripts?.(this.scriptApi.characters?.[this.scriptApi.this_chid]);
        } else if (type === this.engine.SCRIPT_TYPES.PRESET) {
            this.engine.allowPresetScripts?.(this.engine.getCurrentPresetAPI?.(), this.engine.getCurrentPresetName?.());
        }
        this.engine.RegexProvider?.instance?.clear?.();
        this.scriptApi.saveSettingsDebounced?.();
    }

    async saveExistingEditor({ popupInstance, editor, context }) {
        const type = this.getType(context.typeKey);
        const scripts = [...(this.engine.getScriptsByType?.(type) || [])];
        const index = scripts.findIndex(script => String(script.id) === String(context.id));
        if (type === undefined || index < 0) throw new Error('找不到正在编辑的正则');
        const draft = readEditorDraft(editor, context.id, scripts[index]);
        if (!draft.scriptName) {
            globalThis.toastr?.error?.('正则名称不能为空', '云酒馆加速器');
            return;
        }
        scripts[index] = draft;
        await this.persistScripts(type, scripts);
        const labelName = document.getElementById(context.id)?.querySelector('.regex_script_name');
        if (labelName) {
            labelName.textContent = draft.scriptName;
            labelName.title = draft.scriptName;
        }
        this.onSaved?.();
        await popupInstance.completeCancelled();
        this.editorContext = null;
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
        document.removeEventListener('click', this.onClick, true);
        document.removeEventListener('input', this.onInput, true);
        document.removeEventListener('change', this.onChange, true);
        document.removeEventListener('pointerdown', this.onPointerDown, true);
        document.removeEventListener('pointermove', this.onPointerMove, true);
        document.removeEventListener('pointerup', this.onPointerEnd, true);
        document.removeEventListener('pointercancel', this.onPointerEnd, true);
        this.observer?.disconnect();
        this.observer = null;
        clearTimeout(this.organizerTimer);
        this.organizerTimer = null;
        this.getRows().forEach(row => {
            row.hidden = false;
            row.classList?.remove?.('cla-regex-selected');
            if (row.dataset) {
                delete row.dataset.claRegexCollection;
                delete row.dataset.claRegexScope;
            }
        });
        document.querySelector('#regex_container')?.classList?.remove?.('cla-regex-drag-selecting');
        this.organizerButton?.remove?.();
        this.organizerRoot?.remove?.();
        this.organizerButton = null;
        this.organizerRoot = null;
        this.organizerOpen = false;
        this.lastSelectedRow = null;
        this.selectionGesture = null;
        this.editorContext = null;
        this.engine = null;
        this.popupApi = null;
        this.scriptApi = null;
    }
}
