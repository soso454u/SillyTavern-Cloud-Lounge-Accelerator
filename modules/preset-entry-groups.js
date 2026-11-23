export const PRESET_GROUPS_KEY = 'cloud_lounge_accelerator_preset_groups';
export const UNGROUPED = '未分类';
const AUTO = '@auto';

export function normalizePresetGroup(value) {
    const name = String(value || '').trim();
    if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/u.test(name)
        || [UNGROUPED, AUTO].includes(name)) throw new Error('分组名请输入 1–60 个字符，且不能使用系统名称');
    return name;
}

// Only inspect names, never prompt bodies or macros. Explicit assignments win.
export function identifyPresetGroup(prompt, state = {}, section = null) {
    const assigned = state.assignments || {};
    if (Object.hasOwn(assigned, prompt.identifier)) return assigned[prompt.identifier];
    const name = String(prompt.name || '').trim();
    for (const rule of state.rules || []) {
        const source = name.toLocaleLowerCase(), value = rule.value.toLocaleLowerCase();
        if (rule.mode === 'prefix' ? source.startsWith(value) : source.includes(value)) return rule.group;
    }
    if (section) return section;
    if (state.autoPrefix === false) return UNGROUPED;
    const bracket = name.match(/^(?:\[([^\]]+)\]|【([^】]+)】|〔([^〕]+)〕|［([^］]+)］|「([^」]+)」|『([^』]+)』)/u);
    const prefix = bracket?.slice(1).find(Boolean)?.trim()
        || name.match(/^[0-9０-９]+[a-z]?\s*[|｜│]\s*([^|｜│]+)[|｜│]\s*\S/iu)?.[1]?.trim()
        || name.match(/^([^:：|｜·・‧]{1,24})\s*[:：|｜·・‧]\s*\S/u)?.[1]?.trim();
    return prefix && prefix.length <= 60 && prefix !== AUTO ? prefix : UNGROUPED;
}

export function parsePresetSectionMarker(value) {
    const match = String(value || '').trim().match(/^[\s=＝─━—_~～*＊·・|｜:：-]*([↓⇩⬇▼▽↑⇧⬆▲△]+)\s*(?:\[([^\]]+)\]|【([^】]+)】|〔([^〕]+)〕|［([^］]+)］|「([^」]+)」|『([^』]+)』)[\s=＝─━—_~～*＊·・|｜:：-]*$/u);
    if (!match) return null;
    const direction = /^[↓⇩⬇▼▽]+$/u.test(match[1]) ? 'start' : /^[↑⇧⬆▲△]+$/u.test(match[1]) ? 'end' : null;
    const label = match.slice(2).find(Boolean)?.trim();
    const group = label?.replace(/[\s:：·/_-]*(开始|起始|结束|终止)$/u, '').trim();
    return direction && group && group.length <= 60 && group !== AUTO ? { direction, group } : null;
}

// Match complete, properly nested boundaries first. An unmatched opener must
// never claim the rest of a preset. Disabled heading rows still define ranges.
export function classifyPresetEntries(entries, state = {}) {
    const pending = [], pairs = new Map();
    if (state.autoSections !== false) entries.forEach((prompt, index) => {
        const marker = parsePresetSectionMarker(prompt.name);
        if (!marker) return;
        if (marker.direction === 'start') pending.push({ ...marker, start: index });
        else if (pending.at(-1)?.group === marker.group) {
            const opening = pending.pop(); pairs.set(opening.start, { group: opening.group, end: index });
        } else pending.length = 0;
    });
    const active = [], groups = new Map();
    entries.forEach((prompt, index) => {
        if (pairs.has(index)) active.push(pairs.get(index));
        groups.set(prompt.identifier, identifyPresetGroup(prompt, state, active.at(-1)?.group));
        if (active.at(-1)?.end === index) active.pop();
    });
    return groups;
}

export function readPresetGroups(settings, key) {
    const state = key && settings[PRESET_GROUPS_KEY]?.[key];
    return {
        groups: [...new Set((Array.isArray(state?.groups) ? state.groups : []).filter(x => typeof x === 'string'))],
        assignments: { ...state?.assignments },
        autoPrefix: state?.autoPrefix !== false,
        autoSections: state?.autoSections !== false,
        collapsed: Array.isArray(state?.collapsed) ? state.collapsed.filter(name => typeof name === 'string') : null,
        groupOrder: Array.isArray(state?.groupOrder) ? state.groupOrder.filter(name => typeof name === 'string') : [],
        rules: (Array.isArray(state?.rules) ? state.rules : []).filter(rule => rule
            && typeof rule.group === 'string' && typeof rule.value === 'string' && rule.value.trim()
            && ['prefix', 'contains'].includes(rule.mode)).map(rule => ({ ...rule })),
    };
}

// Group the flex display, keeping native prompt nodes in their original DOM
// order. Native execution order is edited in the explicit original-order view.
export class PresetEntryGroups {
    constructor({ host, extensionSettings = {}, saveSettings = () => {}, getPresetName = () => '' }) {
        Object.assign(this, { host, extensionSettings, saveSettings, getPresetName });
        this.headers = []; this.rowStyles = new Map(); this.sortRecords = new Map(); this.rawOrder = false;
    }

    context() {
        const native = this.host.context(), name = this.getPresetName();
        return native && name ? { ...native, key: JSON.stringify(['openai', name, native.characterId]) } : null;
    }

    valid(context) { return this.host.current(context) && this.context()?.key === context.key; }
    state(context = this.context()) { return readPresetGroups(this.extensionSettings, context?.key); }
    entries(context) {
        const byId = new Map(context.prompts.map(prompt => [prompt.identifier, prompt]));
        return context.order.map(item => byId.get(item.identifier)).filter(Boolean);
    }
    names(context, state = this.state(context)) {
        return [...new Set([...state.groups, ...state.rules.map(rule => rule.group),
            ...classifyPresetEntries(this.entries(context), state).values()])].filter(name => name !== UNGROUPED);
    }
    commit(context, state) {
        if (!this.valid(context)) throw new Error('预设或角色已切换，请重新操作');
        const previous = this.extensionSettings[PRESET_GROUPS_KEY];
        this.extensionSettings[PRESET_GROUPS_KEY] = { ...previous, [context.key]: state };
        try { this.saveSettings(); }
        catch (error) { this.extensionSettings[PRESET_GROUPS_KEY] = previous; throw error; }
        this.render();
    }
    assign(context, ids, value) {
        const state = this.state(context), known = new Set(this.entries(context).map(prompt => prompt.identifier));
        if (!ids.length || ids.some(id => !known.has(id))) throw new Error('条目已不在当前列表，请重新操作');
        if (![AUTO, UNGROUPED].includes(value)) normalizePresetGroup(value);
        for (const id of ids) {
            if (value === AUTO) delete state.assignments[id];
            else state.assignments = { ...state.assignments, [id]: value };
        }
        if (![AUTO, UNGROUPED].includes(value) && !state.groups.includes(value)) state.groups.push(value);
        this.commit(context, state);
    }
    create(context, value) {
        const name = normalizePresetGroup(value), state = this.state(context);
        if (this.names(context, state).includes(name)) throw new Error('已有同名分组');
        state.groups.push(name); this.commit(context, state);
    }
    rename(context, previous, value) {
        const name = normalizePresetGroup(value), state = this.state(context);
        if (!this.names(context, state).includes(previous)) throw new Error('请先选择要改名的分组');
        if (name === previous) return;
        if (this.names(context, state).includes(name)) throw new Error('已有同名分组');
        const classified = classifyPresetEntries(this.entries(context), state);
        for (const prompt of this.entries(context)) {
            if (classified.get(prompt.identifier) === previous) state.assignments = { ...state.assignments, [prompt.identifier]: name };
        }
        for (const id of Object.keys(state.assignments)) if (state.assignments[id] === previous) state.assignments[id] = name;
        state.groups = [...new Set([...state.groups.filter(group => group !== previous), name])];
        state.rules = state.rules.map(rule => rule.group === previous ? { ...rule, group: name } : rule);
        if (state.collapsed) state.collapsed = state.collapsed.map(group => group === previous ? name : group);
        state.groupOrder = state.groupOrder.map(group => group === previous ? name : group);
        this.commit(context, state);
    }
    remove(context, name) {
        const state = this.state(context);
        if (!name) throw new Error('请先选择要删除的分组');
        if (name === UNGROUPED) throw new Error('不能删除系统分组');
        if (!this.names(context, state).includes(name)) throw new Error('分组已变化，请重新选择');
        const classified = classifyPresetEntries(this.entries(context), state);
        for (const prompt of this.entries(context)) {
            if (classified.get(prompt.identifier) === name) state.assignments = { ...state.assignments, [prompt.identifier]: UNGROUPED };
        }
        for (const id of Object.keys(state.assignments)) if (state.assignments[id] === name) state.assignments[id] = UNGROUPED;
        state.groups = state.groups.filter(group => group !== name);
        state.rules = state.rules.filter(rule => rule.group !== name);
        if (state.collapsed) state.collapsed = state.collapsed.filter(group => group !== name);
        state.groupOrder = state.groupOrder.filter(group => group !== name);
        this.commit(context, state);
    }

    node(tag, text, className) {
        const node = this.host.document.createElement(tag);
        if (text) node.textContent = text;
        if (className) node.className = className;
        return node;
    }
    button(label, action) {
        const button = this.node('button', label, 'menu_button'); button.type = 'button';
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); this.run(action); });
        return button;
    }
    run(action) {
        try { action(); if (this.feedback) this.feedback.textContent = ''; }
        catch (error) {
            if (this.feedback) this.feedback.textContent = error.message;
            globalThis.toastr?.warning?.(error.message, '预设分组');
        }
    }
    input(placeholder) {
        const input = this.node('input', '', 'text_pole'); input.placeholder = placeholder;
        input.setAttribute('aria-label', placeholder); return input;
    }
    select(options, label) {
        const select = this.node('select', '', 'text_pole'); select.setAttribute('aria-label', label);
        for (const [value, text] of options) { const option = this.node('option', text); option.value = value; select.append(option); }
        return select;
    }

    orderedNames(context, state = this.state(context)) {
        const names = [...this.names(context, state), UNGROUPED];
        return [...new Set([...state.groupOrder.filter(name => names.includes(name)), ...names])];
    }
    collapsedNames(context, state = this.state(context)) {
        return new Set(state.collapsed ?? this.orderedNames(context, state).filter(name => name !== UNGROUPED));
    }
    moveGroup(context, source, target, after) {
        const state = this.state(context), order = this.orderedNames(context, state);
        if (source === target) return;
        if (!order.includes(source) || !order.includes(target)) throw new Error('分组已变化，请重新拖动');
        state.groupOrder = order.filter(name => name !== source);
        state.groupOrder.splice(state.groupOrder.indexOf(target) + (after ? 1 : 0), 0, source);
        this.commit(context, state);
    }
    icon(label, symbol, action, className = '') {
        const button = this.button('', action);
        button.className = `cla-preset-fold-action ${className}`;
        button.title = label; button.setAttribute('aria-label', label);
        const icon = this.node('i', '', `fa-solid ${symbol}`); icon.setAttribute('aria-hidden', 'true');
        button.append(icon); return button;
    }
    nameForm(parent, context, previous = null) {
        parent.querySelector('.cla-preset-group-name-form')?.remove();
        const form = this.node('form', '', 'cla-preset-group-name-form');
        const input = this.input(previous === null ? '新分组名称' : '分组新名称');
        input.maxLength = 60; input.value = previous || '';
        const save = this.button('保存', () => {
            if (previous === null) this.create(context, input.value);
            else this.rename(context, previous, input.value);
        });
        const cancel = this.button('取消', () => form.remove());
        form.addEventListener('submit', event => { event.preventDefault(); save.click(); });
        form.append(input, save, cancel); parent.append(form); input.focus(); input.select();
    }
    assignmentMenu(menu, context, id) {
        if (!this.valid(context)) return;
        menu.classList.add('cla-preset-group-menu');
        const current = classifyPresetEntries(this.entries(context), this.state(context)).get(id);
        for (const name of this.orderedNames(context)) {
            const button = this.button(`${name === current ? '✓ ' : ''}${name}`, () => {
                this.assign(context, [id], name); this.host.closeMenu();
            });
            button.setAttribute('role', 'menuitem'); menu.append(button);
        }
        menu.append(this.button('恢复自动识别', () => { this.assign(context, [id], AUTO); this.host.closeMenu(); }),
            this.button('＋ 新建分组并归入', () => {
                menu.replaceChildren();
                const input = this.input('新分组名称'); input.maxLength = 60;
                const save = () => {
                    const name = normalizePresetGroup(input.value);
                    this.assign(context, [id], name); this.host.closeMenu();
                };
                input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); this.run(save); } });
                menu.append(input, this.button('保存', save)); input.focus();
            }));
    }
    sortable(list) {
        const jquery = globalThis.jQuery || globalThis.$;
        if (!jquery?.fn?.sortable) return null;
        try { return jquery(list).sortable('instance'); } catch { return null; }
    }
    protectSortable(list, grouped) {
        let record = this.sortRecords.get(list);
        if (!record) {
            record = { refresh: () => this.protectSortable(list, list.classList.contains('cla-preset-grouped-list')) };
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
            row.classList.remove('cla-preset-group-hidden'); delete row.dataset.claPresetGroup;
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
        const name = target?.dataset.claPresetGroup;
        const header = this.headers.find(node => node.dataset.claPresetGroup === name);
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
        if (this.key !== context.key) this.rawOrder = false;
        this.key = context.key;
        const expanded = this.root?.open || false;
        this.root?.remove(); this.clearDisplay(); this.list = list;
        // Drop disconnected sortable records after native panel replacement.
        for (const [element, record] of this.sortRecords) if (!element.isConnected) {
            for (const type of ['pointerdown', 'mousedown', 'touchstart']) element.removeEventListener(type, record.refresh, true);
            this.sortRecords.delete(element);
        }
        this.root = this.node('details', '', 'cla-preset-groups'); this.root.open = expanded;
        this.root.setAttribute('aria-label', '条目分组设置');
        const state = this.state(context), entries = this.entries(context), names = this.orderedNames(context, state);
        const classified = classifyPresetEntries(entries, state), collapsed = this.collapsedNames(context, state);
        const heading = this.node('summary', '条目分组', 'cla-preset-group-heading');
        const body = this.node('div', '', 'cla-preset-group-body');
        const manage = this.node('div', '', 'cla-preset-group-tools');
        const groupName = this.input('分组名称'); groupName.maxLength = 60;
        manage.append(groupName, this.button('新建分组', () => this.create(context, groupName.value)));
        const groups = this.select(names.filter(name => name !== UNGROUPED).map(name => [name, name]), '要管理的分组');
        manage.append(groups, this.button('改名', () => this.rename(context, groups.value, groupName.value)),
            this.button('删除分组', () => this.remove(context, groups.value)));
        const tools = this.node('div', '', 'cla-preset-group-tools');
        tools.append(this.button('全部展开', () => this.commit(context, { ...this.state(context), collapsed: [] })),
            this.button('全部收起', () => this.commit(context, { ...this.state(context), collapsed: names })),
            this.button(this.rawOrder ? '返回分组' : '原始顺序', () => { if (this.valid(context)) { this.rawOrder = !this.rawOrder; this.render(); } }));
        const rules = this.node('details'); rules.append(this.node('summary', '自动识别设置'));
        const ruleTools = this.node('div', '', 'cla-preset-group-tools');
        for (const [key, label] of [['autoSections', '头尾区间'], ['autoPrefix', '名称前缀']]) {
            const button = this.button(`${label}：${state[key] ? '开' : '关'}`, () => this.commit(context, { ...this.state(context), [key]: !this.state(context)[key] }));
            button.setAttribute('aria-pressed', String(state[key])); ruleTools.append(button);
        }
        rules.append(ruleTools, this.node('small', '自动使用成对头尾标题里的组名。点列表中的分组标题展开或收起；条目归组请用条目 ⋯ 菜单。分组拖动调整显示位置，原始顺序中可调整实际执行顺序。'));
        this.feedback = this.node('small', '', 'cla-preset-group-feedback'); this.feedback.setAttribute('role', 'status');
        body.append(manage, tools, rules, this.feedback); this.root.append(heading, body);
        const container = this.host.manager.containerElement;
        if (container?.contains(list)) container.prepend(this.root); else list.before(this.root);
        if (this.rawOrder) { this.protectSortable(list, false); return; }
        list.classList.add('cla-preset-grouped-list');
        const rows = [...list.querySelectorAll(':scope > [data-pm-identifier]')];
        const members = new Map(names.map(name => [name, []]));
        for (const row of rows) {
            const name = classified.get(row.dataset.pmIdentifier) || UNGROUPED;
            if (!members.has(name)) members.set(name, []);
            members.get(name).push(row);
        }
        let order = 0;
        for (const [name, groupRows] of members) {
            if (!groupRows.length && name === UNGROUPED) continue;
            const header = this.node('li', '', 'cla-preset-fold-header');
            header.dataset.claPresetGroup = name; header.style.order = String(order++);
            const handle = this.node('button', '⠿', 'cla-preset-fold-drag'); handle.type = 'button';
            handle.title = `按住拖动分组：${name}`; handle.setAttribute('aria-label', handle.title);
            handle.addEventListener('pointerdown', event => this.startDrag(event, header, context, name));
            const toggle = this.button('', () => {
                const next = this.state(context), set = this.collapsedNames(context, next);
                if (set.has(name)) set.delete(name); else set.add(name);
                this.commit(context, { ...next, collapsed: [...set] });
            });
            toggle.className = 'cla-preset-fold-toggle'; toggle.setAttribute('aria-expanded', String(!collapsed.has(name)));
            toggle.setAttribute('aria-label', `${name}，${groupRows.length} 条`);
            toggle.append(this.node('span', collapsed.has(name) ? '▸' : '▾', 'cla-preset-fold-arrow'), this.node('span', name, 'cla-preset-fold-name'), this.node('small', `${groupRows.length} 条`));
            header.append(handle, toggle, this.icon('新建分组', 'fa-plus', () => this.nameForm(header, context)));
            if (name !== UNGROUPED) header.append(this.icon('重命名分组', 'fa-pencil', () => this.nameForm(header, context, name)),
                this.icon('删除分组', 'fa-trash-can', () => this.remove(context, name)));
            list.append(header); this.headers.push(header);
            for (const row of groupRows) {
                const applied = String(order++);
                this.rowStyles.set(row, { value: row.style.getPropertyValue('order'), priority: row.style.getPropertyPriority('order'), applied });
                row.style.setProperty('order', applied); row.dataset.claPresetGroup = name;
                row.classList.toggle('cla-preset-group-hidden', collapsed.has(name));
            }
        }
        this.protectSortable(list, true);
    }
    clear() {
        this.clearDisplay(); this.root?.remove(); this.root = null;
        for (const [list, record] of this.sortRecords) {
            this.protectSortable(list, false);
            for (const type of ['pointerdown', 'mousedown', 'touchstart']) list.removeEventListener(type, record.refresh, true);
        }
        this.sortRecords.clear(); this.list = null; this.key = null;
    }
}
