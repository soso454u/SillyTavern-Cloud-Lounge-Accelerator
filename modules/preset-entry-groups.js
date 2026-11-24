import { recognizePresetSections } from './preset-section-boundaries.js';
import { renderRecognitionSettings } from './preset-recognition-settings.js';
import { preservePresetAnchor } from './preset-scroll-anchor.js';
import { PRESET_GROUPS_KEY, normalizeFolderState, assignedFolder, folderPath, folderLayout,
    UNGROUPED_ID, createFolder, renameFolder, moveFolder, deleteFolder, assignEntries, syncPresetSections, promptFingerprint, importFolderMetadata } from './preset-folder-model.js';
export { PRESET_GROUPS_KEY, UNGROUPED, normalizePresetGroup } from './preset-folder-model.js';

// This is the existing preset organizer, using the same extension-settings key.
// It owns metadata and display only; all native writes belong to entry actions.
export class PresetEntryGroups {
    constructor({ host, extensionSettings = {}, saveSettings = () => {}, getPresetName = () => '', eventSource, eventTypes = {} }) {
        Object.assign(this, { host, extensionSettings, saveSettings, getPresetName, eventSource, eventTypes });
        this.folderNodes = new Map(); this.rowStyles = new Map(); this.sortRecords = new Map(); this.rawOrder = false; this.query = ''; this.filter = 'all'; this.listeners = []; this.searchFolders = new Map();
    }
    start() {
        if (this.listeners.length || !this.eventSource) return;
        for (const [type, data] of [[this.eventTypes.OAI_PRESET_IMPORT_READY, 'data'], [this.eventTypes.OAI_PRESET_CHANGED_BEFORE, 'preset']]) if (type) {
            const handler = event => this.run(() => this.reconcileImport(event?.presetName, event?.[data]));
            this.eventSource.on(type, handler); this.listeners.push([type, handler]);
        }
    }
    context() {
        const native = this.host.context(), name = this.getPresetName();
        return native && name ? { ...native, key: JSON.stringify(['openai', name, native.characterId]), presetName: name } : null;
    }
    valid(context) { return !!context && this.host.current(context) && this.context()?.key === context.key; }
    entries(context) {
        const byId = new Map(context.prompts.map(prompt => [prompt.identifier, prompt]));
        return context.order.map(item => byId.get(item.identifier)).filter(Boolean);
    }
    state(context = this.context()) { return normalizeFolderState(this.extensionSettings[PRESET_GROUPS_KEY]?.[context?.key], context?.prompts || [], context?.key); }
    persist(context, state) {
        if (!this.valid(context)) throw new Error('预设或角色已切换，请重新操作');
        state.fingerprints = Object.fromEntries(context.prompts.filter(prompt => Object.hasOwn(state.assignments, prompt.identifier))
            .map(prompt => [prompt.identifier, promptFingerprint(prompt)]));
        const previous = this.extensionSettings[PRESET_GROUPS_KEY];
        const next = { ...previous, [context.key]: state }; this.extensionSettings[PRESET_GROUPS_KEY] = next;
        try { this.saveSettings(); } catch (error) { if (this.extensionSettings[PRESET_GROUPS_KEY] === next) this.extensionSettings[PRESET_GROUPS_KEY] = previous; throw error; }
    }
    commit(context, state) {
        this.persist(context, state);
        const active = this.host.document?.activeElement;
        preservePresetAnchor(active?.closest?.('.cla-preset-fold-header') || this.root, () => this.render());
    }
    reconcileImport(name, preset) {
        if (!name || !Array.isArray(preset?.prompts)) return;
        let changed = false;
        const saved = this.extensionSettings[PRESET_GROUPS_KEY] || {}, next = { ...saved };
        for (const [key, value] of Object.entries(saved)) {
            let scope; try { scope = JSON.parse(key); } catch { continue; }
            if (scope[0] !== 'openai' || scope[1] !== name || value.schema !== 4) continue;
            const { state, skipped } = importFolderMetadata(value, preset.prompts, key);
            if (skipped) { next[key] = state; changed = true; }
        }
        if (changed) { this.extensionSettings[PRESET_GROUPS_KEY] = next; this.saveSettings(); }
    }
    assign(context, ids, folderId) { const state = this.state(context); assignEntries(state, context.prompts, ids, folderId); this.commit(context, state); }
    create(context, name, parentId = null) { const state = this.state(context); const id = createFolder(state, name, parentId); this.commit(context, state); return id; }
    node(tag, text, className) {
        const node = this.host.document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
    }
    run(action) {
        const fail = error => { if (this.feedback) this.feedback.textContent = error.message; globalThis.toastr?.warning?.(error.message, '预设分类'); };
        try { const result = action(); if (result?.then) result.catch(fail); else if (this.feedback) this.feedback.textContent = ''; } catch (error) { fail(error); }
    }
    button(label, action, className = 'menu_button') {
        const button = this.node('button', label, className); button.type = 'button';
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); this.run(action); }); return button;
    }
    input(label, type = 'text') { const input = this.node('input', '', 'text_pole'); input.type = type; input.placeholder = label; input.setAttribute('aria-label', label); return input; }
    select(options, label) {
        const select = this.node('select', '', 'text_pole'); select.setAttribute('aria-label', label);
        for (const [value, text] of options) { const option = this.node('option', text); option.value = value; select.append(option); } return select;
    }
    folderOptions(state, rootLabel = '未分类') { return [['', rootLabel], ...state.folders.map(folder => [folder.id, folderPath(state, folder.id)])]; }
    assignmentMenu(menu, context, id, onDone = () => {}) {
        if (!this.valid(context)) return;
        menu.classList.add('cla-preset-group-menu'); const ids = Array.isArray(id) ? id : [id], state = this.state(context);
        for (const [folderId, path] of this.folderOptions(state)) {
            const current = ids.length === 1 && assignedFolder(state, ids[0]) === (folderId || null);
            const button = this.button(`${current ? '✓ ' : ''}${path}`, () => { this.assign(context, ids, folderId || null); onDone(); this.host.closeMenu(); });
            button.setAttribute('role', 'menuitem'); menu.append(button);
        }
        menu.append(this.button('新建文件夹并移入…', () => this.folderForm(menu, context, { ids, onDone })));
    }
    folderForm(menu, context, { folder = null, parentId = null, moving = false, ids = null, onDone = () => {} } = {}) {
        menu.replaceChildren(); menu.classList.add('cla-preset-group-menu');
        const state = this.state(context), name = this.input(folder ? '文件夹新名称' : '新文件夹名称'); name.maxLength = 60; name.value = folder?.name || '';
        const excluded = new Set(folder && moving ? [folder.id] : []);
        const byId = new Map(state.folders.map(item => [item.id, item]));
        const canMoveTo = id => {
            for (let current = id; current; current = byId.get(current)?.parentId) if (excluded.has(current)) return false;
            return true;
        };
        const parent = this.select(this.folderOptions(state, '最外层').filter(([id]) => canMoveTo(id)), '上级文件夹');
        parent.value = folder?.parentId || parentId || '';
        if (!moving) menu.append(name);
        if (!folder || moving) menu.append(parent);
        const save = () => {
            if (!this.valid(context)) throw new Error('预设已切换');
            const next = this.state(context);
            if (folder) { if (moving) moveFolder(next, folder.id, parent.value || null); else renameFolder(next, folder.id, name.value); }
            else {
                const id = createFolder(next, name.value, parent.value || null);
                if (ids) assignEntries(next, context.prompts, ids, id);
                if (parent.value) next.collapsed = next.collapsed.filter(item => item !== parent.value);
            }
            this.commit(context, next); onDone(); this.host.closeMenu();
        };
        name.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); this.run(save); } });
        menu.append(this.button('保存', save)); if (!moving) name.focus();
    }
    showFolderMenu(button, context, folderId) {
        if (!this.valid(context)) return;
        this.host.closeMenu(); const menu = this.node('div', '', 'cla-preset-entry-menu cla-preset-group-menu'); menu.setAttribute('role', 'menu');
        const folder = this.state(context).folders.find(item => item.id === folderId);
        menu.append(this.button(folder ? '新建子文件夹…' : '新建文件夹…', () => this.folderForm(menu, context, { parentId: folder?.id || null })));
        if (folder) menu.append(this.button('重命名…', () => this.folderForm(menu, context, { folder })),
            this.button('移动文件夹…', () => this.folderForm(menu, context, { folder, moving: true })),
            this.button('删除文件夹…', async () => {
                this.host.closeMenu();
                if (!await this.host.confirm(`删除文件夹“${folder.name}”？预设条目不会删除，将移到上级文件夹或未分类；子文件夹会保留并移到上级。`)) return;
                if (!this.valid(context)) return;
                const state = this.state(context); deleteFolder(state, folderId); this.commit(context, state);
            }));
        this.host.showMenu(menu, button);
    }
    async importMetadata(context, file) {
        if (!file || file.size > 2 * 1024 * 1024) throw new Error('请选择小于 2 MB 的分类 JSON 文件');
        const raw = JSON.parse(await file.text()), { state, skipped } = importFolderMetadata(raw, context.prompts, context.key);
        if (!this.valid(context)) return;
        if (!await this.host.confirm(`导入分类并替换当前文件夹设置？不会改动预设条目或执行顺序。${skipped ? ` ${skipped} 个标识或内容不匹配的关系不会导入。` : ''}`)) return;
        if (this.valid(context)) { this.commit(context, state); if (this.recognitionPanel) renderRecognitionSettings(this, context, this.recognitionPanel); }
    }
    exportMetadata(context) {
        if (!this.valid(context)) return;
        const state = this.state(context); this.persist(context, state);
        const win = this.host.document.defaultView, url = win.URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
        const link = this.node('a'); link.href = url; link.download = 'preset-folders.json'; this.host.document.body.append(link); link.click(); link.remove(); setTimeout(() => win.URL.revokeObjectURL(url), 1000);
    }
    sortable(list) {
        const jquery = globalThis.jQuery || globalThis.$;
        if (!jquery?.fn?.sortable) return null;
        try { return jquery(list).sortable('instance'); } catch { return null; }
    }
    protectSortable(list, grouped) {
        let record = this.sortRecords.get(list);
        if (!record) {
            record = { refresh: () => this.protectSortable(list, !this.rawOrder || !!this.query || this.filter !== 'all' || !!this.host.selection?.mode || !!this.host.selection?.gesture) };
            for (const type of ['pointerdown', 'mousedown', 'touchstart']) list.addEventListener(type, record.refresh, { capture: true, passive: true });
            this.sortRecords.set(list, record);
        }
        const instance = this.sortable(list);
        if (!instance?.options || instance.dragging) return;
        if (record.instance !== instance) { record.instance = instance; record.previous = instance.options.cancel; record.applied = false; }
        if (grouped) {
            if (!record.applied || instance.options.cancel !== '*') record.previous = instance.options.cancel;
            instance.option('cancel', '*'); record.applied = true;
        } else if (record.applied) {
            if (instance.options.cancel === '*') instance.option('cancel', record.previous);
            record.applied = false;
        }
    }
    rowStyle(row, property, value) {
        const styles = this.rowStyles.get(row) || [];
        styles.push({ property, value: row.style.getPropertyValue(property), priority: row.style.getPropertyPriority(property), applied: value });
        this.rowStyles.set(row, styles);
        row.style.setProperty(property, value, 'important');
    }
    clearDisplay() {
        this.statusObserver?.disconnect(); this.statusObserver = null;
        // Reuse the actual native rows, preserving their listeners. Only the
        // ungrouped view exposes sortable, after restoring exact native order.
        if (this.list?.isConnected) {
            const rows = new Map([...this.list.querySelectorAll('[data-pm-identifier]')].map(row => [row.dataset.pmIdentifier, row]));
            for (const entry of this.host.context()?.order || []) { const row = rows.get(entry.identifier); if (row) { this.list.append(row); rows.delete(entry.identifier); } }
            for (const row of rows.values()) this.list.append(row);
        }
        for (const node of this.folderNodes.values()) node.element.remove();
        this.folderNodes.clear();
        for (const [row, styles] of this.rowStyles) for (const { property, value, priority } of styles) {
            if (value) row.style.setProperty(property, value, priority); else row.style.removeProperty(property);
        }
        this.rowStyles.clear(); this.list?.classList.remove('cla-preset-grouped-list');
    }
    watchStatus(list, context) {
        // The instant native toggle updates the row in place without rebuilding
        // PromptManager. Refresh the filtered display if its state changed.
        const Observer = this.host.document.defaultView?.MutationObserver;
        if (!Observer || !['enabled', 'disabled'].includes(this.filter)) return;
        const disabled = 'completion_prompt_manager_prompt_disabled';
        this.statusObserver = new Observer(records => {
            if (this.valid(context) && records.some(({ target, oldValue }) =>
                list.contains(target) && target.hasAttribute('data-pm-identifier')
                && target.classList.contains(disabled) !== (oldValue || '').split(/\s+/u).includes(disabled))) this.render();
        });
        this.statusObserver.observe(list, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    }
    setFold(context, ids, folded, anchor) {
        if (!this.valid(context)) return;
        const state = this.state(context), collapsed = new Set(state.collapsed);
        for (const id of ids) { if (folded) collapsed.add(id); else collapsed.delete(id); }
        const searching = !!this.query.trim();
        if (!searching) { state.collapsed = [...collapsed]; this.persist(context, state); }
        else for (const id of ids) this.searchFolders.set(id, folded);
        preservePresetAnchor(anchor || this.root, () => {
            for (const id of ids) {
                const record = this.folderNodes.get(id); if (!record) continue;
                record.element.classList.toggle('collapsed', folded);
                record.button.setAttribute('aria-expanded', String(!folded));
                record.arrow.textContent = folded ? '▸' : '▾';
            }
        });
    }
    renderToolbar(list, context) {
        if (!this.root?.isConnected || !this.valid(this.toolbarContext)) {
            this.root?.remove(); this.toolbarContext = context;
            this.root = this.node('section', '', 'cla-preset-groups'); this.root.setAttribute('aria-label', '预设分类管理');
            const bar = this.node('div', '', 'cla-preset-group-tools cla-preset-folder-search');
            this.search = this.input('搜索名称或内容', 'search');
            const filter = this.statusFilter = this.select([['all', '全部状态'], ['enabled', '已启用'], ['disabled', '已禁用'], ['ungrouped', '未分类']], '条目筛选');
            this.search.addEventListener('input', () => {
                if (!this.valid(context)) return;
                if (this.query.trim().toLocaleLowerCase() !== this.search.value.trim().toLocaleLowerCase()) this.searchFolders.clear();
                this.query = this.search.value; this.render();
            });
            filter.addEventListener('change', () => { if (this.valid(context)) { this.filter = filter.value; this.render(); } });
            bar.append(this.search, filter);
            const views = this.node('div', '', 'cla-preset-group-tools');
            const switchView = raw => {
                if (!this.valid(context)) return;
                this.rawOrder = raw; this.query = ''; this.filter = 'all'; this.searchFolders.clear(); this.render();
            };
            this.groupViewButton = this.button('分类浏览', () => switchView(false));
            this.rawViewButton = this.button('原始顺序', () => switchView(true));
            const settings = this.node('details', '', 'cla-preset-settings');
            const summary = this.node('summary', '⚙ 分类设置'); settings.append(summary);
            views.append(this.groupViewButton, this.rawViewButton);
            const tools = this.folderTools = this.node('div', '', 'cla-preset-group-tools cla-preset-folder-tools');
            const create = this.button('新建文件夹', () => {
                this.host.closeMenu(); const menu = this.node('div', '', 'cla-preset-entry-menu cla-preset-group-menu');
                this.folderForm(menu, context); this.host.showMenu(menu, create); menu.querySelector('input')?.focus({ preventScroll: true });
            });
            const toggleAll = folded => this.setFold(context, [...this.state(context).folders.map(folder => folder.id), UNGROUPED_ID], folded);
            const importInput = this.input('导入分类文件', 'file'); importInput.accept = '.json,application/json'; importInput.hidden = true;
            importInput.addEventListener('change', () => { const file = importInput.files?.[0]; importInput.value = ''; if (file) this.run(() => this.importMetadata(context, file)); });
            tools.append(create, this.button('全部展开', () => toggleAll(false)), this.button('全部折叠', () => toggleAll(true)));
            const recognitionPanel = this.node('div', '', 'cla-preset-recognition-settings');
            renderRecognitionSettings(this, context, recognitionPanel); this.recognitionPanel = recognitionPanel;
            const data = this.node('div', '', 'cla-preset-group-tools');
            data.append(this.button('导出分类', () => this.exportMetadata(context)), this.button('导入分类', () => importInput.click()), importInput);
            settings.append(tools, recognitionPanel, data);
            this.feedback = this.node('small', '', 'cla-preset-group-feedback'); this.feedback.setAttribute('role', 'status');
            this.diagnostic = this.node('details', '', 'cla-preset-diagnostics');
            this.diagnosticSummary = this.node('summary'); this.diagnosticText = this.node('div'); this.diagnostic.append(this.diagnosticSummary, this.diagnosticText);
            views.append(settings); this.root.append(bar, views, this.diagnostic, this.feedback);
        }
        if (this.root.parentElement !== list.parentElement) list.before(this.root);
        if (this.search.value !== this.query) this.search.value = this.query;
        this.statusFilter.value = this.filter;
        this.groupViewButton.setAttribute('aria-pressed', String(!this.rawOrder)); this.rawViewButton.setAttribute('aria-pressed', String(this.rawOrder));
    }
    render() {
        const list = this.host.manager?.listElement, context = this.context();
        if (!list?.isConnected || !context) { this.clear(); return; }
        if (this.sortable(list)?.dragging) return;
        if (this.key !== context.key || this.list !== list) {
            this.clearDisplay(); this.rawOrder = false; this.query = ''; this.filter = 'all'; this.searchFolders.clear();
        }
        if (this.list && this.list !== list) this.protectSortable(this.list, false);
        this.key = context.key; this.list = list;
        for (const [element, record] of this.sortRecords) if (!element.isConnected) {
            for (const type of ['pointerdown', 'mousedown', 'touchstart']) element.removeEventListener(type, record.refresh, true);
            this.sortRecords.delete(element);
        }
        this.statusObserver?.disconnect();
        if (this.folderNodes.size && ![...this.folderNodes.values()].some(record => record.element.isConnected)) this.folderNodes.clear();
        const state = this.state(context), entries = this.entries(context), raw = this.extensionSettings[PRESET_GROUPS_KEY]?.[context.key];
        const recognition = recognizePresetSections(entries, state.recognition);
        const sectionsChanged = syncPresetSections(state, entries, recognition);
        if (sectionsChanged || !raw || raw.schema !== 4) this.run(() => this.persist(context, state));
        this.renderToolbar(list, context);
        this.diagnosticSummary.textContent = `识别到 ${recognition.sections.length} 组，${recognition.diagnostics.length} 个异常`;
        this.diagnosticText.replaceChildren(...recognition.diagnostics.map(text => this.node('div', text)));
        this.diagnosticText.append(this.node('small', `${context.prompts.length} 个 prompts，当前 prompt_order ${context.order.length} 项；未在当前顺序中的条目保留在原生可用条目中。`));
        // Read every native row, including markers and theme/system rows not
        // represented in the current order. No unmapped row may escape folding.
        const rows = new Map([...list.querySelectorAll('[data-pm-identifier]')].map(row => [row.dataset.pmIdentifier, row]));
        const known = new Set(entries.map(prompt => prompt.identifier));
        const displayEntries = [...entries, ...[...rows.keys()].filter(id => !known.has(id)).map(identifier => context.prompts.find(p => p.identifier === identifier) || { identifier, name: identifier })];
        const orderEntries = new Map(context.order.map(item => [item.identifier, item]));
        const query = this.query.trim().toLocaleLowerCase(), filtering = !!query || this.filter !== 'all';
        const visible = new Set(displayEntries.filter(prompt => {
            const id = prompt.identifier, folderId = assignedFolder(state, id);
            return (!query || [prompt.name, prompt.content, folderPath(state, folderId)].some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(query)))
                && (this.filter !== 'enabled' || !!orderEntries.get(id)?.enabled)
                && (this.filter !== 'disabled' || !orderEntries.get(id)?.enabled)
                && (this.filter !== 'ungrouped' || !folderId)
                && (this.rawOrder || !state.recognition.hideMarkers || !recognition.markerIds.has(id) || state.assignments[id]?.source === 'manual');
        }).map(prompt => prompt.identifier));
        if (this.rawOrder) {
            this.clearDisplay();
            for (const [id, row] of rows) { if (!visible.has(id)) this.rowStyle(row, 'display', 'none'); }
        } else {
            this.protectSortable(list, true);
            list.classList.add('cla-preset-grouped-list');
            const layout = folderLayout(state, displayEntries), alive = new Set(), collapsed = new Set(state.collapsed);
            const place = (parent, node, index) => { if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null); };
            // Keep native list heading/auxiliary nodes before the owned tree.
            const offset = [...list.children].filter(node => !node.hasAttribute('data-pm-identifier') && !node.classList.contains('cla-preset-folder')).length;
            const draw = (nodes, parent, depth = 0, offset = 0) => {
                let matches = false, position = offset;
                for (const node of nodes) {
                    if (node.entry) {
                        const row = rows.get(node.entry.identifier); if (!row) continue;
                        place(parent, row, position++);
                        // Restore only our own filtering style when an entry reappears.
                        if (this.rowStyles.has(row)) {
                            for (const item of this.rowStyles.get(row)) { if (item.value) row.style.setProperty(item.property, item.value, item.priority); else row.style.removeProperty(item.property); }
                            this.rowStyles.delete(row);
                        }
                        if (!visible.has(node.entry.identifier)) this.rowStyle(row, 'display', 'none'); else matches = true;
                        continue;
                    }
                    alive.add(node.id);
                    const record = this.drawFolder(context, state, node, depth);
                    place(parent, record.element, position++);
                    const childMatches = draw(node.children, record.body, depth + 1);
                    record.element.hidden = filtering && !childMatches;
                    const folded = query ? (this.searchFolders.get(node.id) ?? false) : collapsed.has(node.id);
                    record.element.classList.toggle('collapsed', folded);
                    record.button.setAttribute('aria-expanded', String(!folded)); record.arrow.textContent = folded ? '▸' : '▾';
                    if (childMatches) matches = true;
                }
                return matches;
            };
            draw(layout, list, 0, offset);
            for (const [id, record] of this.folderNodes) if (!alive.has(id)) { record.element.remove(); this.folderNodes.delete(id); }
        }
        this.protectSortable(list, !this.rawOrder || filtering || !!this.host.selection?.mode);
        this.host.selection?.render(); this.watchStatus(list, context);
    }
    drawFolder(context, state, folder, depth) {
        let record = this.folderNodes.get(folder.id);
        if (!record) {
            const element = this.node('li', '', 'cla-preset-folder'); element.dataset.claPresetGroup = folder.id;
            const header = this.node('div', '', 'cla-preset-fold-header'); header.dataset.claPresetGroup = folder.id;
            const body = this.node('ul', '', 'cla-preset-folder-body');
            const button = this.button('', () => this.setFold(this.context(), [folder.id], !element.classList.contains('collapsed'), header), 'cla-preset-fold-toggle');
            const arrow = this.node('span', '', 'cla-preset-folder-arrow'); arrow.setAttribute('aria-hidden', 'true');
            const name = this.node('span', '', 'cla-preset-fold-name'), count = this.node('small', '', 'cla-preset-fold-count');
            button.append(arrow, name, count);
            const more = this.button('⋯', () => this.showFolderMenu(more, this.context(), folder.id), 'cla-preset-fold-action');
            more.setAttribute('aria-haspopup', 'menu'); header.append(button, more); element.append(header, body);
            record = { element, header, body, button, arrow, name, count, more }; this.folderNodes.set(folder.id, record);
        }
        record.name.textContent = folder.name; record.count.textContent = String(folder.total);
        record.button.title = folderPath(state, folder.id); record.button.setAttribute('aria-label', `${folder.name}，${folder.total} 条`);
        record.more.setAttribute('aria-label', `更多：${folder.name}`); record.header.style.setProperty('--cla-preset-depth', String(Math.min(depth, 6)));
        return record;
    }
    clear() {
        this.clearDisplay(); this.root?.remove(); this.root = null; this.toolbarContext = null; this.feedback = null;
        for (const [list, record] of this.sortRecords) { this.protectSortable(list, false); for (const type of ['pointerdown', 'mousedown', 'touchstart']) list.removeEventListener(type, record.refresh, true); }
        this.sortRecords.clear(); this.list = null; this.key = null;
    }
    stop() { for (const [type, handler] of this.listeners) this.eventSource?.removeListener(type, handler); this.listeners = []; this.clear(); }
}
