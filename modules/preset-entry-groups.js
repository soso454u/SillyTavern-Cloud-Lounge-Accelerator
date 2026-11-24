import { PRESET_GROUPS_KEY, UNGROUPED, ROOT, normalizePresetGroup, normalizeFolderState, assignedFolder, folderPath, folderTree,
    createFolder, renameFolder, moveFolder, deleteFolder, assignEntries, promptFingerprint, importFolderMetadata } from './preset-folder-model.js';
import { folderSuggestions } from './preset-folder-suggestions.js';
export { PRESET_GROUPS_KEY, UNGROUPED, normalizePresetGroup } from './preset-folder-model.js';

// This is the existing preset organizer, using the same extension-settings key.
// It owns metadata and display only; all native writes belong to entry actions.
export class PresetEntryGroups {
    constructor({ host, extensionSettings = {}, saveSettings = () => {}, getPresetName = () => '', eventSource, eventTypes = {} }) {
        Object.assign(this, { host, extensionSettings, saveSettings, getPresetName, eventSource, eventTypes });
        this.headers = []; this.rowStyles = new Map(); this.sortRecords = new Map(); this.rawOrder = false; this.query = ''; this.filter = 'all'; this.listeners = [];
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
    valid(context) { return this.host.current(context) && this.context()?.key === context.key; }
    entries(context) {
        const byId = new Map(context.prompts.map(prompt => [prompt.identifier, prompt]));
        return context.order.map(item => byId.get(item.identifier)).filter(Boolean);
    }
    state(context = this.context()) { return normalizeFolderState(this.extensionSettings[PRESET_GROUPS_KEY]?.[context?.key], context?.prompts || [], context?.key); }
    persist(context, state) {
        if (!this.valid(context)) throw new Error('预设或角色已切换，请重新操作');
        for (const prompt of context.prompts) if (Object.hasOwn(state.assignments, prompt.identifier)) state.fingerprints = { ...state.fingerprints, [prompt.identifier]: promptFingerprint(prompt) };
        const previous = this.extensionSettings[PRESET_GROUPS_KEY];
        const next = { ...previous, [context.key]: state }; this.extensionSettings[PRESET_GROUPS_KEY] = next;
        try { this.saveSettings(); } catch (error) { if (this.extensionSettings[PRESET_GROUPS_KEY] === next) this.extensionSettings[PRESET_GROUPS_KEY] = previous; throw error; }
    }
    commit(context, state) { this.persist(context, state); this.render(); }
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
        const parent = this.select(this.folderOptions(state, '最外层'), '上级文件夹'); parent.value = folder?.parentId || parentId || '';
        if (!moving) menu.append(name);
        if (!folder || moving) menu.append(parent);
        const save = () => {
            if (!this.valid(context)) throw new Error('预设已切换');
            const next = this.state(context);
            if (folder) { if (moving) moveFolder(next, folder.id, parent.value || null); else renameFolder(next, folder.id, name.value); }
            else { const id = createFolder(next, name.value, parent.value || null); if (ids) assignEntries(next, context.prompts, ids, id); }
            this.commit(context, next); onDone(); this.host.closeMenu();
        };
        name.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); this.run(save); } });
        menu.append(this.button('保存', save)); if (!moving) name.focus();
    }
    showFolderMenu(button, context, folderId) {
        if (!this.valid(context)) return;
        this.host.closeMenu(); const menu = this.node('div', '', 'cla-preset-entry-menu cla-preset-group-menu'); menu.setAttribute('role', 'menu');
        const folder = this.state(context).folders.find(item => item.id === folderId);
        menu.append(this.button(folder ? '新建子文件夹…' : '新建文件夹…', () => this.folderForm(menu, context, { parentId: folderId })));
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
        if (this.valid(context)) this.commit(context, state);
    }
    exportMetadata(context) {
        if (!this.valid(context)) return;
        const state = this.state(context); this.persist(context, state);
        const win = this.host.document.defaultView, url = win.URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
        const link = this.node('a'); link.href = url; link.download = 'preset-folders.json'; this.host.document.body.append(link); link.click(); link.remove(); setTimeout(() => win.URL.revokeObjectURL(url), 1000);
    }
    preview(context, kind, container) {
        if (!this.valid(context)) return;
        container.replaceChildren(); const proposals = folderSuggestions(this.entries(context), this.state(context), kind);
        container.append(this.node('small', `${proposals.length} 项待审核建议。仅在本机分析；没有可靠线索的条目保持未分类。已保存的分类不会覆盖。`));
        const choices = [];
        for (const proposal of proposals) {
            const row = this.node('div', '', 'cla-preset-suggestion-row'), label = this.node('span', proposal.name); label.title = proposal.reason;
            const path = JSON.stringify(proposal.path), select = this.select([['@skip', '暂不应用'], [`@path:${path}`, `建议：${proposal.path.join(' / ')}`], ...this.folderOptions(this.state(context)).filter(([id]) => id)], `建议目标：${proposal.name}`);
            // Structure proposals restore an explicitly requested author layout;
            // mixed semantic evidence stays skipped until individually reviewed.
            select.value = proposal.confidence === '混合内容' ? '@skip' : `@path:${path}`;
            row.append(label, select, this.node('small', proposal.reason)); container.append(row); choices.push({ proposal, select });
        }
        if (proposals.length) container.append(this.button('应用审核后的建议', async () => {
            const selected = choices.filter(choice => choice.select.value !== '@skip');
            if (!selected.length) return;
            if (!await this.host.confirm(`将 ${selected.length} 个条目按以上建议归类？仅保存分类元数据，不改变内容、开关或执行顺序。`)) return;
            if (!this.valid(context)) return;
            const state = this.state(context);
            for (const { proposal, select } of selected) {
                if (Object.hasOwn(state.assignments, proposal.id)) continue;
                let folderId = select.value;
                if (folderId.startsWith('@path:')) {
                    let parentId = null;
                    for (const name of JSON.parse(folderId.slice(6))) { let folder = state.folders.find(item => item.parentId === parentId && item.name === name); if (!folder) { const id = createFolder(state, name, parentId); folder = state.folders.find(item => item.id === id); } parentId = folder.id; }
                    folderId = parentId;
                }
                assignEntries(state, context.prompts, [proposal.id], folderId, 'accepted');
            }
            this.commit(context, state);
        }));
    }
    moveGroup(context, source, target, after) {
        const state = this.state(context), from = state.folders.find(folder => folder.id === source), to = state.folders.find(folder => folder.id === target);
        if (!from || !to || from.parentId !== to.parentId) throw new Error('请拖到同一级文件夹上；跨层移动请使用更多菜单');
        const find = nodes => { for (const node of nodes) { if (node.id === source) return nodes; const nested = find(node.children); if (nested) return nested; } };
        const siblings = find(folderTree(state, this.entries(context))), order = siblings.map(folder => folder.id).filter(id => id && id !== source);
        order.splice(order.indexOf(target) + (after ? 1 : 0), 0, source); state.order = { ...state.order, [from.parentId || ROOT]: order }; this.commit(context, state);
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
    clearDisplay() {
        this.finishDrag(false);
        for (const header of this.headers) header.remove();
        this.headers = [];
        for (const [row, previous] of this.rowStyles) {
            if (row.style.getPropertyValue('order') === previous.applied) {
                if (previous.value) row.style.setProperty('order', previous.value, previous.priority);
                else row.style.removeProperty('order');
            }
            row.classList.remove('cla-preset-group-hidden'); delete row.dataset.claPresetGroup; delete row.dataset.claPresetBlock;
        }
        this.rowStyles.clear();
        this.list?.classList.remove('cla-preset-grouped-list');
        if (this.list) this.protectSortable(this.list, false);
    }
    startDrag(event, header, context, name) {
        if (event.button > 0 || !this.valid(context) || this.rawOrder) return;
        event.preventDefault(); event.stopPropagation(); this.finishDrag(false);
        this.drag = { pointerId: event.pointerId, source: event.currentTarget, header, context, name,
            x: event.clientX, y: event.clientY, started: Date.now(), active: false };
        this.dragMove = move => this.moveDrag(move);
        this.dragEnd = end => { if (end.pointerId === this.drag?.pointerId) this.finishDrag(end.type === 'pointerup'); };
        const doc = this.host.document;
        doc.addEventListener('pointermove', this.dragMove, { capture: true, passive: false });
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) doc.addEventListener(type, this.dragEnd, true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    moveDrag(event) {
        const drag = this.drag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!this.valid(drag.context)) { this.finishDrag(false); return; }
        if (!drag.active && Date.now() - drag.started >= 150 && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 8) {
            drag.active = true; drag.header.classList.add('cla-preset-group-dragging');
        }
        if (!drag.active) return;
        event.preventDefault();
        for (const header of this.headers) header.classList.remove('cla-preset-group-drop-before', 'cla-preset-group-drop-after');
        const hit = this.host.document.elementFromPoint(event.clientX, event.clientY);
        const target = hit?.closest('.cla-preset-fold-header, [data-pm-identifier]');
        const name = target?.dataset.claPresetBlock;
        const header = this.headers.find(node => node.dataset.claPresetBlock === name);
        drag.target = null;
        if (header && name !== drag.name) {
            const rect = target.getBoundingClientRect();
            drag.after = event.clientY > rect.top + rect.height / 2; drag.target = name;
            header.classList.add(drag.after ? 'cla-preset-group-drop-after' : 'cla-preset-group-drop-before');
        }
    }
    finishDrag(commit) {
        const drag = this.drag;
        if (!drag) return;
        this.drag = null;
        const doc = this.host.document;
        doc.removeEventListener('pointermove', this.dragMove, true);
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) doc.removeEventListener(type, this.dragEnd, true);
        if (drag.source.hasPointerCapture?.(drag.pointerId)) drag.source.releasePointerCapture(drag.pointerId);
        for (const header of this.headers) header.classList.remove('cla-preset-group-dragging', 'cla-preset-group-drop-before', 'cla-preset-group-drop-after');
        if (commit && drag.active && drag.target && this.valid(drag.context)) this.run(() => this.moveGroup(drag.context, drag.name, drag.target, drag.after));
    }
    render() {
        const list = this.host.manager?.listElement, context = this.context();
        if (!list?.isConnected || !context) { this.clear(); return; }
        if (this.sortable(list)?.dragging) return;
        if (this.key !== context.key) { this.rawOrder = false; this.query = ''; this.filter = 'all'; }
        this.key = context.key;
        const managementOpen = this.root?.querySelector('details')?.open || false;
        const active = this.host.document.activeElement, searchFocused = active === this.search, caret = this.search?.selectionStart;
        this.root?.remove(); this.clearDisplay(); this.list = list;
        for (const [element, record] of this.sortRecords) if (!element.isConnected) { for (const type of ['pointerdown', 'mousedown', 'touchstart']) element.removeEventListener(type, record.refresh, true); this.sortRecords.delete(element); }
        const state = this.state(context), entries = this.entries(context), raw = this.extensionSettings[PRESET_GROUPS_KEY]?.[context.key];
        if (raw && raw.schema !== 4) this.persist(context, state);
        // Refresh only fingerprints of saved references after native edits. The
        // import/change hooks reconcile incoming content before it is applied.
        else if (raw && entries.some(prompt => Object.hasOwn(state.assignments, prompt.identifier) && state.fingerprints[prompt.identifier] !== promptFingerprint(prompt))) this.persist(context, state);
        this.root = this.node('section', '', 'cla-preset-groups'); this.root.setAttribute('aria-label', '预设分类管理');
        const bar = this.node('div', '', 'cla-preset-group-tools cla-preset-folder-search');
        this.search = this.input('搜索名称或内容', 'search'); this.search.value = this.query;
        this.search.addEventListener('input', () => { if (!this.valid(context)) return; this.query = this.search.value; this.render(); });
        const filter = this.select([['all', '全部状态'], ['enabled', '已启用'], ['disabled', '已禁用'], ['ungrouped', '未分类']], '条目筛选'); filter.value = this.filter;
        filter.addEventListener('change', () => { if (!this.valid(context)) return; this.filter = filter.value; this.render(); });
        bar.append(this.search, filter, this.button(this.rawOrder ? '分类浏览' : '原始顺序', () => { if (!this.valid(context)) return; this.rawOrder = !this.rawOrder; this.query = ''; this.filter = 'all'; this.render(); this.host.selection?.render(); }));
        const details = this.node('details'); details.open = managementOpen; details.append(this.node('summary', '条目分组与文件夹设置'));
        const body = this.node('div', '', 'cla-preset-group-body'), tools = this.node('div', '', 'cla-preset-group-tools');
        tools.append(this.button('新建文件夹', () => {
            const button = tools.querySelector('button'), menu = this.node('div', '', 'cla-preset-entry-menu cla-preset-group-menu'); menu.setAttribute('role', 'menu');
            this.host.closeMenu(); this.folderForm(menu, context); this.host.showMenu(menu, button);
        }),
            this.button('全部展开', () => this.commit(context, { ...this.state(context), collapsed: [] })),
            this.button('全部折叠', () => this.commit(context, { ...this.state(context), collapsed: [...state.folders.map(folder => folder.id), '@ungrouped'] })));
        const importInput = this.input('导入分类文件', 'file'); importInput.accept = '.json,application/json'; importInput.hidden = true;
        importInput.addEventListener('change', () => this.run(() => this.importMetadata(context, importInput.files?.[0])));
        tools.append(this.button('导出分类', () => this.exportMetadata(context)), this.button('导入分类', () => importInput.click()), importInput);
        const suggestions = this.node('details'); suggestions.append(this.node('summary', '分类建议（先预览，再确认）'));
        const preview = this.node('div', '', 'cla-preset-suggestions');
        suggestions.append(this.button('按原头尾结构预览', () => this.preview(context, 'boundaries', preview)), this.button('本地内容建议', () => this.preview(context, 'content', preview)), preview);
        this.feedback = this.node('small', '', 'cla-preset-group-feedback'); this.feedback.setAttribute('role', 'status');
        body.append(tools, suggestions, this.node('small', '分类和文件夹拖动仅改变显示。长按条目约半秒进入多选；电脑也可 Ctrl/Cmd 点击。'), this.feedback); details.append(body); this.root.append(bar, details);
        if (this.rawOrder) this.root.append(this.node('small', this.query || this.filter !== 'all' ? '当前：原始顺序。请清除搜索/筛选后使用原生手柄排序。' : '当前：原始顺序，按 SillyTavern 的 prompt_order 显示。'));
        const container = this.host.manager.containerElement;
        if (container?.contains(list)) container.prepend(this.root); else list.before(this.root);
        const rows = [...list.querySelectorAll(':scope > [data-pm-identifier]')], byId = new Map(rows.map(row => [row.dataset.pmIdentifier, row]));
        const orderEntries = new Map(context.order.map(item => [item.identifier, item]));
        const query = this.query.trim().toLocaleLowerCase(), filtering = !!query || this.filter !== 'all';
        const matches = prompt => (!query || `${prompt.name || ''}\n${typeof prompt.content === 'string' ? prompt.content : ''}\n${folderPath(state, assignedFolder(state, prompt.identifier))}`.toLocaleLowerCase().includes(query))
            && (this.filter !== 'enabled' || orderEntries.get(prompt.identifier)?.enabled === true)
            && (this.filter !== 'disabled' || orderEntries.get(prompt.identifier)?.enabled !== true)
            && (this.filter !== 'ungrouped' || !assignedFolder(state, prompt.identifier));
        let order = 0;
        const place = (prompt, hidden, folderId = null) => {
            const row = byId.get(prompt.identifier); if (!row) return;
            const applied = this.rawOrder ? '' : String(order++);
            this.rowStyles.set(row, { value: row.style.getPropertyValue('order'), priority: row.style.getPropertyPriority('order'), applied });
            if (!this.rawOrder) row.style.setProperty('order', applied);
            row.classList.toggle('cla-preset-group-hidden', hidden); row.dataset.claPresetBlock = folderId || ''; row.dataset.claPresetGroup = folderId || '';
        };
        if (this.rawOrder) for (const prompt of entries) place(prompt, !matches(prompt));
        else {
            list.classList.add('cla-preset-grouped-list');
            const total = node => node.items.length + node.children.reduce((sum, child) => sum + total(child), 0);
            const matching = node => node.items.some(matches) || node.children.some(matching);
            const draw = (nodes, depth = 0, parentHidden = false) => {
                for (const folder of nodes) {
                    const isMatch = matching(folder), hidden = parentHidden || (filtering && !isMatch);
                    const collapseId = folder.id || '@ungrouped', folded = state.collapsed.includes(collapseId) && !filtering;
                    const header = this.node('li', '', 'cla-preset-fold-header'); header.dataset.claPresetBlock = folder.id || ''; header.dataset.claPresetGroup = folder.id || '';
                    header.style.order = String(order++); header.style.setProperty('--cla-preset-depth', String(depth)); header.classList.toggle('cla-preset-group-hidden', hidden);
                    const arrow = this.button(folded ? '▸' : '▾', () => {
                        const next = this.state(context), set = new Set(next.collapsed); if (set.has(collapseId)) set.delete(collapseId); else set.add(collapseId); this.commit(context, { ...next, collapsed: [...set] });
                    }, 'cla-preset-folder-arrow');
                    arrow.title = folded ? '展开文件夹' : '折叠文件夹'; arrow.setAttribute('aria-label', `${arrow.title}：${folder.name}`); arrow.setAttribute('aria-expanded', String(!folded));
                    const icon = this.node('button', '', 'cla-preset-fold-drag'); icon.type = 'button'; icon.title = `拖动文件夹：${folder.name}`; icon.setAttribute('aria-label', icon.title); icon.append(this.node('i', '', 'fa-regular fa-folder'));
                    if (folder.id) icon.addEventListener('pointerdown', event => this.startDrag(event, header, context, folder.id)); else icon.disabled = true;
                    const name = this.button('', () => arrow.click(), 'cla-preset-fold-toggle'); name.title = folderPath(state, folder.id);
                    name.setAttribute('aria-label', `${folder.name}，${total(folder)} 条`); name.append(this.node('span', folder.name, 'cla-preset-fold-name'), this.node('small', `${total(folder)} 条`));
                    const more = this.button('⋯', () => this.showFolderMenu(more, context, folder.id), 'cla-preset-fold-action'); more.setAttribute('aria-label', `更多：${folder.name}`);
                    header.append(arrow, icon, name, more); list.append(header); this.headers.push(header);
                    draw(folder.children, depth + 1, hidden || folded);
                    for (const prompt of folder.items) place(prompt, hidden || folded || !matches(prompt), folder.id);
                }
            };
            draw(folderTree(state, entries));
        }
        this.protectSortable(list, !this.rawOrder || filtering);
        if (searchFocused) { this.search.focus({ preventScroll: true }); if (caret != null) this.search.setSelectionRange(caret, caret); }
        this.host.selection?.render();
    }
    clear() {
        this.clearDisplay(); this.root?.remove(); this.root = null;
        for (const [list, record] of this.sortRecords) { this.protectSortable(list, false); for (const type of ['pointerdown', 'mousedown', 'touchstart']) list.removeEventListener(type, record.refresh, true); }
        this.sortRecords.clear(); this.list = null; this.key = null;
    }
    stop() { for (const [type, handler] of this.listeners) this.eventSource?.removeListener(type, handler); this.listeners = []; this.clear(); }
}
