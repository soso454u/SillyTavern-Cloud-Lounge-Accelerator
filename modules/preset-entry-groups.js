import { preservePresetAnchor } from './preset-scroll-anchor.js';
import { PRESET_GROUPS_KEY, PRESET_GROUPS_SCHEMA, folderLayout } from './preset-folder-model.js';

// This is the existing preset organizer, using the same extension-settings key.
// It owns metadata and display only; all native writes belong to entry actions.
export class PresetEntryGroups {
    constructor({ host, extensionSettings = {}, saveSettings = () => {}, getPresetName = () => '' }) {
        Object.assign(this, { host, extensionSettings, saveSettings, getPresetName });
        this.folderNodes = new Map(); this.rowMembership = new Map(); this.rowStyles = new Map(); this.sortRecords = new Map(); this.rawOrder = false; this.query = ''; this.filter = 'all'; this.searchFolders = new Map();
    }
    start() {
        const saved = this.extensionSettings[PRESET_GROUPS_KEY];
        if (!saved || saved.schema === PRESET_GROUPS_SCHEMA) return;
        // Old manual folders and recognition rules cannot influence paired sections.
        this.writeSettings({ schema: PRESET_GROUPS_SCHEMA, expandedByPreset: {} });
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
    presetKey(context) { return JSON.stringify(['openai', context.presetName]); }
    meta(context) {
        const saved = this.extensionSettings[PRESET_GROUPS_KEY];
        const item = saved?.schema === PRESET_GROUPS_SCHEMA ? saved.presets?.[this.presetKey(context)] : null;
        return { names: { ...(item?.names || {}) }, manual: [...(item?.manual || [])], hidden: [...(item?.hidden || [])] };
    }
    saveMeta(context, meta) {
        const previous = this.extensionSettings[PRESET_GROUPS_KEY];
        const base = previous?.schema === PRESET_GROUPS_SCHEMA ? previous : { schema: PRESET_GROUPS_SCHEMA, expandedByPreset: {} };
        this.writeSettings({ ...base, presets: { ...(base.presets || {}), [this.presetKey(context)]: meta } });
    }
    async ask(title, value) {
        if (this.host.prompt) { const result = await this.host.prompt(title, value); return typeof result === 'string' ? result : null; }
        return globalThis.prompt?.(title, value) ?? null;
    }
    async renameFolder(folder) {
        const context = this.context(); if (!this.valid(context)) return;
        const value = await this.ask(`分组显示名（留空恢复「${folder.original}」）`, folder.name);
        if (value === null || !this.valid(context)) return;
        const meta = this.meta(context), name = value.trim().slice(0, 60);
        const manual = meta.manual.find(group => JSON.stringify([group.start, group.end]) === folder.id);
        if (manual) manual.name = name || manual.name;
        else if (name && name !== folder.original) meta.names[folder.id] = name; else delete meta.names[folder.id];
        this.saveMeta(context, meta); this.render();
    }
    createGroup(ids) {
        const context = this.context(); if (!this.valid(context)) throw new Error('预设已切换');
        const order = context.order.map(item => item.identifier).filter(id => ids.has(id));
        if (!order.length) throw new Error('请先选择条目');
        return this.ask('新分组名称（从第一个选中条目到最后一个）', '新分组').then(value => {
            if (value === null || !this.valid(context)) return false;
            const meta = this.meta(context);
            meta.manual.push({ start: order[0], end: order.at(-1), name: value.trim().slice(0, 60) || '新分组' });
            this.saveMeta(context, meta); this.render(); return true;
        });
    }
    removeGroup(folder) {
        const context = this.context(); if (!this.valid(context)) return;
        const meta = this.meta(context);
        const before = meta.manual.length;
        meta.manual = meta.manual.filter(group => JSON.stringify([group.start, group.end]) !== folder.id);
        if (meta.manual.length === before && !meta.hidden.includes(folder.id)) meta.hidden.push(folder.id);
        delete meta.names[folder.id];
        this.saveMeta(context, meta); this.render();
    }
    expanded(context) {
        const saved = this.extensionSettings[PRESET_GROUPS_KEY];
        return new Set(saved?.schema === PRESET_GROUPS_SCHEMA ? saved.expandedByPreset?.[context.key] : []);
    }
    writeSettings(value) {
        const previous = this.extensionSettings[PRESET_GROUPS_KEY];
        this.extensionSettings[PRESET_GROUPS_KEY] = value;
        try {
            this.saveSettings();
        } catch (error) {
            this.extensionSettings[PRESET_GROUPS_KEY] = previous;
            throw error;
        }
    }
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
        for (const node of this.folderNodes.values()) node.element.remove();
        this.folderNodes.clear();
        for (const row of this.rowMembership.keys()) row.classList.remove('cla-preset-fold-hidden');
        this.rowMembership.clear();
        for (const [row, styles] of this.rowStyles) for (const { property, value, priority } of styles) {
            if (value) row.style.setProperty(property, value, priority); else row.style.removeProperty(property);
        }
        this.rowStyles.clear(); this.list?.classList.remove('cla-preset-grouped-list', 'cla-preset-readable');
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
        const expanded = this.expanded(context);
        for (const id of ids) { if (folded) expanded.delete(id); else expanded.add(id); }
        const searching = !!this.query.trim();
        if (!searching) {
            const previous = this.extensionSettings[PRESET_GROUPS_KEY];
            const expandedByPreset = previous?.schema === PRESET_GROUPS_SCHEMA ? previous.expandedByPreset : {};
            this.writeSettings({ ...(previous?.schema === PRESET_GROUPS_SCHEMA ? previous : {}), schema: PRESET_GROUPS_SCHEMA, expandedByPreset: { ...expandedByPreset, [context.key]: [...expanded] } });
        }
        else for (const id of ids) this.searchFolders.set(id, folded);
        preservePresetAnchor(anchor || this.root, () => {
            for (const id of ids) {
                const record = this.folderNodes.get(id);
                if (record) record.folded = folded;
            }
            this.updateFolds();
        });
    }
    renderToolbar(list, context) {
        if (!this.root?.isConnected || this.toolbarKey !== context.key) {
            this.root?.remove();
            this.toolbarKey = context.key;
            const currentScope = () => this.context()?.key === context.key;
            this.root = this.node('section', '', 'cla-preset-groups'); this.root.setAttribute('aria-label', '预设分类管理');
            const bar = this.node('div', '', 'cla-preset-group-tools cla-preset-folder-search');
            this.search = this.input('搜索名称或内容', 'search');
            const filter = this.statusFilter = this.select([['all', '全部状态'], ['enabled', '已启用'], ['disabled', '已禁用']], '条目筛选');
            this.search.addEventListener('input', () => {
                if (!currentScope()) return;
                if (this.query.trim().toLocaleLowerCase() !== this.search.value.trim().toLocaleLowerCase()) this.searchFolders.clear();
                this.query = this.search.value; this.render();
            });
            filter.addEventListener('change', () => { if (currentScope()) { this.filter = filter.value; this.render(); } });
            bar.append(this.search, filter);
            const views = this.node('div', '', 'cla-preset-group-tools');
            const switchView = raw => {
                if (!currentScope()) return;
                this.rawOrder = raw; this.query = ''; this.filter = 'all'; this.searchFolders.clear(); this.render();
            };
            this.groupViewButton = this.button('分类浏览', () => switchView(false));
            this.rawViewButton = this.button('原始顺序', () => switchView(true));
            const settings = this.node('details', '', 'cla-preset-settings');
            const summary = this.node('summary', '折叠操作'); settings.append(summary);
            views.append(this.groupViewButton, this.rawViewButton);
            const tools = this.node('div', '', 'cla-preset-group-tools cla-preset-folder-tools');
            const toggleAll = folded => {
                if (currentScope()) this.setFold(this.context(), [...this.folderNodes.keys()], folded);
            };
            tools.append(this.button('全部展开', () => toggleAll(false)), this.button('全部折叠', () => toggleAll(true)));
            this.selectButton = this.button('多选 / 新建分组', () => {
                if (!currentScope()) return;
                const selection = this.host.selection;
                if (selection.mode) selection.exit(); else { selection.enter(); selection.render(); globalThis.toastr?.info?.('点选条目，选好首尾后点「建为分组」', '多选'); }
            });
            views.append(this.selectButton);
            tools.append(this.button('恢复已删除的自动分组', () => {
                const ctx = this.context(); if (!this.valid(ctx)) return;
                const meta = this.meta(ctx); meta.hidden = []; this.saveMeta(ctx, meta); this.render();
            }));
            settings.append(tools);
            this.feedback = this.node('small', '', 'cla-preset-group-feedback'); this.feedback.setAttribute('role', 'status');
            views.append(settings); this.root.append(bar, views, this.feedback);
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
        if (this.folderNodes.size && ![...this.folderNodes.values()].some(record => record.element.isConnected)) {
            this.folderNodes.clear();
            this.rowMembership.clear();
        }
        const entries = this.entries(context);
        this.renderToolbar(list, context);
        list.classList.add('cla-preset-readable');
        const rows = new Map([...list.querySelectorAll('[data-pm-identifier]')].map(row => [row.dataset.pmIdentifier, row]));
        const known = new Set(entries.map(prompt => prompt.identifier));
        const displayEntries = [...entries, ...[...rows.keys()].filter(id => !known.has(id)).map(identifier => context.prompts.find(p => p.identifier === identifier) || { identifier, name: identifier })];
        const orderEntries = new Map(context.order.map(item => [item.identifier, item]));
        const query = this.query.trim().toLocaleLowerCase(), filtering = !!query || this.filter !== 'all';
        const visible = (prompt, groupNames = '') => {
            const id = prompt.identifier;
            return (!query || [prompt.name, prompt.content, groupNames].some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(query)))
                && (this.filter !== 'enabled' || !!orderEntries.get(id)?.enabled)
                && (this.filter !== 'disabled' || !orderEntries.get(id)?.enabled);
        };
        if (this.rawOrder) {
            this.clearDisplay();
            list.classList.add('cla-preset-readable');
            for (const prompt of displayEntries) {
                const row = rows.get(prompt.identifier);
                if (row && !visible(prompt)) this.rowStyle(row, 'display', 'none');
            }
        } else {
            this.protectSortable(list, true);
            list.classList.add('cla-preset-grouped-list');
            const meta = this.meta(context);
            const layout = [...folderLayout(entries, meta.manual, meta.names, meta.hidden), ...displayEntries.slice(entries.length).map(entry => ({ entry }))];
            const alive = new Set();
            const expanded = this.expanded(context);
            this.rowMembership.clear();
            const draw = (nodes, ancestors = [], groupNames = '') => {
                let matches = false;
                for (const node of nodes) {
                    if (node.entry) {
                        const row = rows.get(node.entry.identifier);
                        if (!row) continue;
                        this.rowMembership.set(row, ancestors);
                        if (this.rowStyles.has(row)) {
                            for (const item of this.rowStyles.get(row)) {
                                if (item.value) row.style.setProperty(item.property, item.value, item.priority);
                                else row.style.removeProperty(item.property);
                            }
                            this.rowStyles.delete(row);
                        }
                        if (ancestors.length) this.rowStyle(row, 'margin-left', `${Math.min(ancestors.length, 4) * 14}px`);
                        if (!visible(node.entry, groupNames)) this.rowStyle(row, 'display', 'none');
                        else matches = true;
                        continue;
                    }
                    alive.add(node.id);
                    const record = this.drawFolder(node);
                    record.ancestors = ancestors;
                    record.element.style.setProperty('--cla-fold-depth', String(Math.min(ancestors.length, 4)));
                    record.folded = query ? (this.searchFolders.get(node.id) ?? false) : !expanded.has(node.id);
                    const firstEntry = node.id && rows.get(JSON.parse(node.id)[0]);
                    if (firstEntry && record.element.nextElementSibling !== firstEntry) list.insertBefore(record.element, firstEntry);
                    const ids = [], subs = [];
                    const walk = list => { for (const child of list) { if (child.entry) ids.push(child.entry.identifier); else { subs.push(child.id); walk(child.children); } } };
                    walk(node.children); record.ids = ids; record.subs = subs; record.folder = node;
                    const childMatches = draw(node.children, [...ancestors, node.id], `${groupNames} ${node.name}`);
                    record.filtered = filtering && !childMatches;
                    if (childMatches) matches = true;
                }
                return matches;
            };
            draw(layout);
            for (const [id, record] of this.folderNodes) {
                if (!alive.has(id)) {
                    record.element.remove();
                    this.folderNodes.delete(id);
                }
            }
            this.updateFolds();
        }
        this.protectSortable(list, !this.rawOrder || filtering || !!this.host.selection?.mode);
        this.host.selection?.render(); this.watchStatus(list, context);
    }
    updateFolds() {
        const ancestorFolded = ids => ids.some(id => this.folderNodes.get(id)?.folded);
        for (const record of this.folderNodes.values()) {
            record.element.hidden = record.filtered || ancestorFolded(record.ancestors);
            record.element.classList.toggle('collapsed', record.folded);
            record.button.setAttribute('aria-expanded', String(!record.folded));
            record.arrow.className = `cla-preset-folder-arrow fa-solid ${record.folded ? 'fa-folder' : 'fa-folder-open'}`;
            record.subFold.hidden = !record.subs?.length;
        }
        for (const [row, ancestors] of this.rowMembership) {
            row.classList.toggle('cla-preset-fold-hidden', ancestorFolded(ancestors));
        }
    }
    drawFolder(folder) {
        let record = this.folderNodes.get(folder.id);
        if (!record) {
            const element = this.node('li', '', 'cla-preset-folder'); element.dataset.claPresetGroup = folder.id;
            const header = this.node('div', '', 'cla-preset-fold-header'); header.dataset.claPresetGroup = folder.id;
            const button = this.button('', () => this.setFold(this.context(), [folder.id], !element.classList.contains('collapsed'), header), 'cla-preset-fold-toggle');
            const arrow = this.node('span', '', 'cla-preset-folder-arrow'); arrow.setAttribute('aria-hidden', 'true');
            const name = this.node('span', '', 'cla-preset-fold-name'), count = this.node('small', '', 'cla-preset-fold-count');
            button.append(arrow, name, count);
            const icon = (cls, title, action) => { const b = this.button('', action, 'cla-preset-fold-icon'); b.append(b.glyph = this.node('i', '', `fa-solid ${cls}`)); b.glyph.setAttribute('aria-hidden', 'true'); b.title = title; b.setAttribute('aria-label', title); return b; };
            const rename = icon('fa-pen', '改名', () => this.renameFolder(record.folder));
            const subFold = icon('fa-angles-up', '折叠/展开全部子分组', () => {
                const subs = record.subs || []; const allFolded = subs.every(id => this.folderNodes.get(id)?.folded);
                this.setFold(this.context(), subs, !allFolded, header);
            });
            const remove = icon('fa-xmark', '删除分组（条目保留在原位）', () => this.removeGroup(record.folder));
            header.append(button, rename, subFold, remove); element.append(header);
            record = { element, header, button, arrow, name, count, subFold, remove }; this.folderNodes.set(folder.id, record);
        }
        record.name.textContent = folder.name; record.count.textContent = String(folder.total);
        record.button.setAttribute('aria-label', `${folder.name}，${folder.total} 条`);
        return record;
    }
    clear() {
        this.clearDisplay(); this.root?.remove(); this.root = null; this.toolbarKey = null; this.feedback = null;
        for (const [list, record] of this.sortRecords) { this.protectSortable(list, false); for (const type of ['pointerdown', 'mousedown', 'touchstart']) list.removeEventListener(type, record.refresh, true); }
        this.sortRecords.clear(); this.list = null; this.key = null;
    }
    stop() { this.clear(); }
}
