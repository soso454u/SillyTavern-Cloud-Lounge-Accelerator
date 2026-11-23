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
        rules: (Array.isArray(state?.rules) ? state.rules : []).filter(rule => rule
            && typeof rule.group === 'string' && typeof rule.value === 'string' && rule.value.trim()
            && ['prefix', 'contains'].includes(rule.mode)).map(rule => ({ ...rule })),
    };
}

// All controls live outside the native sortable. Filtering only hides rows;
// it never moves them or changes the enabled state / prompt_order arrays.
export class PresetEntryGroups {
    constructor({ host, extensionSettings = {}, saveSettings = () => {}, getPresetName = () => '' }) {
        Object.assign(this, { host, extensionSettings, saveSettings, getPresetName });
        this.selected = new Set(); this.filter = ''; this.query = ''; this.rows = new Set();
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
        if (!ids.length || ids.some(id => !known.has(id))) throw new Error('请先勾选当前列表中的条目');
        if (![AUTO, UNGROUPED].includes(value)) normalizePresetGroup(value);
        for (const id of ids) {
            if (value === AUTO) delete state.assignments[id];
            else state.assignments = { ...state.assignments, [id]: value };
        }
        if (![AUTO, UNGROUPED].includes(value) && !state.groups.includes(value)) state.groups.push(value);
        this.selected.clear(); this.commit(context, state);
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
        if (this.filter === previous) this.filter = name;
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
        if (this.filter === name) this.filter = '';
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
        catch (error) { if (this.feedback) this.feedback.textContent = error.message; }
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

    render() {
        const list = this.host.manager?.listElement, context = this.context();
        if (!list?.isConnected || !context) { this.clear(); return; }
        if (this.key !== context.key || this.prompts !== context.prompts || this.order !== context.order) {
            this.filter = ''; this.query = ''; this.selected.clear();
        }
        this.key = context.key; this.prompts = context.prompts; this.order = context.order;
        const expanded = this.root?.open || false;
        const open = this.root?.querySelector('details')?.open || false;
        this.root?.remove();
        this.root = this.node('details', '', 'cla-preset-groups');
        this.root.open = expanded;
        this.root.setAttribute('aria-label', '预设条目分类');
        const state = this.state(context), entries = this.entries(context), names = this.names(context, state);
        const byId = new Map(entries.map(prompt => [prompt.identifier, prompt]));
        const classified = classifyPresetEntries(entries, state);
        if (this.filter && ![...names, UNGROUPED].includes(this.filter)) this.filter = '';
        const heading = this.node('summary', '', 'cla-preset-group-heading');
        heading.append(this.node('span', '条目分组'), this.node('small', this.filter || `自动 · ${names.length} 组`));
        const body = this.node('div', '', 'cla-preset-group-body');
        const bar = this.node('div', '', 'cla-preset-group-bar');
        for (const group of ['', ...names, UNGROUPED]) {
            const count = entries.filter(prompt => !group || classified.get(prompt.identifier) === group).length;
            const button = this.button(`${group || '全部'} ${count}`, () => {
                if (!this.valid(context)) return;
                this.filter = group; this.selected.clear(); this.render();
            });
            button.setAttribute('aria-pressed', String(this.filter === group)); bar.append(button);
        }
        const search = this.input('搜索条目名称'); search.type = 'search'; search.value = this.query;
        search.addEventListener('input', () => {
            if (!this.valid(context)) return;
            this.query = search.value; this.selected.clear(); this.applyFilter(context, state);
        });
        const details = this.node('details'); details.open = open;
        details.className = 'cla-preset-group-manager';
        details.append(this.node('summary', '管理分组与识别规则'));
        const management = this.node('div', '', 'cla-preset-group-management');
        const manage = this.node('div', '', 'cla-preset-group-tools');
        const groupName = this.input('分组名称');
        manage.append(groupName, this.button('新建分组', () => this.create(context, groupName.value)));
        const groups = this.select(names.map(name => [name, name]), '要管理的分组');
        manage.append(groups, this.button('改名', () => this.rename(context, groups.value, groupName.value)),
            this.button('删除分组', () => this.remove(context, groups.value)));
        const bulk = this.node('div', '', 'cla-preset-group-tools');
        const target = this.select([[AUTO, '恢复自动识别'], [UNGROUPED, UNGROUPED], ...names.map(name => [name, name])], '归组目标');
        this.selectionLabel = this.node('small');
        bulk.append(this.selectionLabel, this.button('全选可见', () => {
            if (!this.valid(context)) return;
            for (const row of this.rows) if (!row.classList.contains('cla-preset-group-hidden')) this.selected.add(row.dataset.pmIdentifier);
            this.syncSelection();
        }), this.button('清空选择', () => { this.selected.clear(); this.syncSelection(); }), target,
        this.button('归入分组', () => this.assign(context, [...this.selected], target.value)));
        const autoLabel = this.node('label', '', 'cla-preset-group-auto');
        const auto = this.node('input'); auto.type = 'checkbox'; auto.checked = state.autoPrefix;
        auto.addEventListener('change', () => this.run(() => this.commit(context, { ...this.state(context), autoPrefix: auto.checked })));
        autoLabel.append(auto, '按名称前缀自动识别');
        const sectionsLabel = this.node('label', '', 'cla-preset-group-auto');
        const sections = this.node('input'); sections.type = 'checkbox'; sections.checked = state.autoSections;
        sections.addEventListener('change', () => this.run(() => this.commit(context, { ...this.state(context), autoSections: sections.checked })));
        sectionsLabel.append(sections, '按头尾标记识别区间分组');
        const help = this.node('small', '优先级：手动归组 → 自定义规则（从上到下首条命中）→ 头尾区间 → 名称前缀 → 未分类。区间示例：====↓[文风] 与 ====↑[文风]，两者之间的条目自动归组（含头尾）。支持嵌套；缺少另一端或名称不一致时不按该区间归组。名称前缀示例：【文风】描写、[规则]约束、文风·描写、身份：设定、00 | 世界观 | 背景。仅识别名称，关键词忽略大小写。删除分组会将现有条目放回未分类，条目内容保留。');
        const rules = this.node('div', '', 'cla-preset-group-rules');
        state.rules.forEach((rule, index) => {
            const row = this.node('div', '', 'cla-preset-group-tools');
            row.append(this.node('span', `${index + 1}. ${rule.mode === 'prefix' ? '开头是' : '包含'}「${rule.value}」→ ${rule.group}`),
                this.button('移除规则', () => { const next = this.state(context); next.rules.splice(index, 1); this.commit(context, next); }));
            rules.append(row);
        });
        const addRule = this.node('div', '', 'cla-preset-group-tools');
        const mode = this.select([['contains', '名称包含'], ['prefix', '名称开头是']], '识别方式');
        const value = this.input('识别关键词'); const ruleGroup = this.input('归入分组名称');
        addRule.append(mode, value, ruleGroup, this.button('添加规则', () => {
            const next = this.state(context), group = normalizePresetGroup(ruleGroup.value), keyword = value.value.trim();
            if (!keyword || keyword.length > 120) throw new Error('关键词请输入 1–120 个字符');
            next.rules.push({ mode: mode.value, value: keyword, group });
            if (!next.groups.includes(group)) next.groups.push(group);
            this.commit(context, next);
        }));
        management.append(manage, bulk, sectionsLabel, autoLabel, rules, addRule);
        const instructions = this.node('details');
        instructions.append(this.node('summary', '识别说明'), help);
        management.append(instructions);
        details.append(management);
        this.feedback = this.node('small', '', 'cla-preset-group-feedback'); this.feedback.setAttribute('role', 'status');
        body.append(bar, search, details, this.feedback);
        this.root.append(heading, body);
        const container = this.host.manager.containerElement;
        if (container?.contains(list)) container.prepend(this.root);
        else list.before(this.root);
        for (const row of this.rows) if (!row.isConnected) this.rows.delete(row);
        for (const row of list.querySelectorAll('[data-pm-identifier]')) {
            this.rows.add(row);
            row.querySelector('.cla-preset-group-choice')?.remove();
            const prompt = byId.get(row.dataset.pmIdentifier);
            if (!prompt) continue;
            const label = this.node('label', '', 'cla-preset-group-choice');
            label.addEventListener('click', event => event.stopPropagation());
            const checkbox = this.node('input'); checkbox.type = 'checkbox'; checkbox.checked = this.selected.has(prompt.identifier);
            checkbox.setAttribute('aria-label', `选择条目：${prompt.name || prompt.identifier}`);
            checkbox.addEventListener('change', () => {
                if (!this.valid(context)) return;
                if (checkbox.checked) this.selected.add(prompt.identifier); else this.selected.delete(prompt.identifier);
                this.syncSelection();
            });
            label.title = `分类：${classified.get(prompt.identifier)}`; label.append(checkbox);
            // Insert into the name cell to preserve the native three-column grid.
            const cell = row.querySelector('.completion_prompt_manager_prompt_name');
            cell?.prepend(label);
        }
        this.applyFilter(context, state);
    }

    applyFilter(context, state) {
        const prompts = new Map(this.entries(context).map(prompt => [prompt.identifier, prompt]));
        const classified = classifyPresetEntries([...prompts.values()], state);
        const query = this.query.trim().toLocaleLowerCase();
        for (const row of this.rows) {
            const prompt = prompts.get(row.dataset.pmIdentifier);
            const visible = prompt && (!this.filter || classified.get(prompt.identifier) === this.filter)
                && (!query || String(prompt.name || '').toLocaleLowerCase().includes(query));
            row.classList.toggle('cla-preset-group-hidden', !visible);
            if (!visible) this.selected.delete(row.dataset.pmIdentifier);
        }
        this.syncSelection();
    }
    syncSelection() {
        for (const row of this.rows) {
            const input = row.querySelector('.cla-preset-group-choice input');
            if (input) input.checked = this.selected.has(row.dataset.pmIdentifier);
        }
        if (this.selectionLabel) this.selectionLabel.textContent = `已选 ${this.selected.size} 项`;
    }
    clear() {
        this.root?.remove(); this.root = null;
        for (const row of this.rows) { row.classList.remove('cla-preset-group-hidden'); row.querySelector('.cla-preset-group-choice')?.remove(); }
        this.rows.clear(); this.selected.clear(); this.key = null;
    }
}
