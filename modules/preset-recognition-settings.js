import { preservePresetAnchor } from './preset-scroll-anchor.js';
import { DEFAULT_SECTION_RULES, normalizeRecognition, validateSectionRule } from './preset-section-boundaries.js';

export function renderRecognitionSettings(ui, context, panel) {
    const config = ui.state(context).recognition;
    const save = change => {
        const state = ui.state(context); change(state.recognition);
        preservePresetAnchor(panel.closest('details'), () => {
            ui.persist(context, state); ui.render(); renderRecognitionSettings(ui, context, panel);
        });
    };
    panel.replaceChildren();
    const mode = ui.select([['off', '关闭自动识别'], ['pair', '成对头尾识别'], ['heading', '单标题分组'], ['mixed', '混合模式']], '头尾识别模式');
    mode.value = config.mode; mode.addEventListener('change', () => ui.run(() => save(next => { next.mode = mode.value; })));
    const label = (text, control) => { const row = ui.node('label', '', 'cla-preset-setting-row'); row.append(ui.node('span', text), control); return row; };
    const checkbox = (text, checked, action) => {
        const input = ui.input(text, 'checkbox'); input.checked = checked; input.addEventListener('change', () => ui.run(() => action(input.checked))); return label(text, input);
    };
    panel.append(label('头尾识别', mode));
    const rules = ui.node('div', '', 'cla-preset-rules');
    const editor = ui.node('div', '', 'cla-preset-rule-editor'); editor.hidden = true;
    const edit = original => {
        editor.replaceChildren(); editor.hidden = false;
        const rule = original || { id: globalThis.crypto?.randomUUID?.() || `rule-${Date.now()}`, name: '', type: 'pair', scope: 'name', trim: true, normalize: true, regex: false, enabled: true, start: '', end: '', level: 1 };
        const name = ui.input('规则名称'); name.value = rule.name; name.maxLength = 60;
        const type = ui.select([['pair', '成对头尾'], ['heading', '单标题'], ['manual', '手动指定区间']], '规则类型'); type.value = rule.type;
        const start = ui.input('开始标记模板'); start.value = rule.start; start.maxLength = 500;
        const end = ui.input('结束标记模板'); end.value = rule.end; end.maxLength = 500;
        const scope = ui.select([['name', '只匹配 name'], ['content', '匹配正文 content（明确启用）']], '匹配范围'); scope.value = rule.scope;
        const level = ui.input('标题层级', 'number'); level.min = 1; level.max = 20; level.value = rule.level;
        const trim = ui.input('忽略首尾空格', 'checkbox'); trim.checked = rule.trim;
        const normalize = ui.input('全角半角归一化', 'checkbox'); normalize.checked = rule.normalize;
        const regex = ui.input('高级正则表达式', 'checkbox'); regex.checked = rule.regex;
        const help = ui.node('small', '普通模板用 {name} 提取名称，例如 ====↓[{name}]↓====。正则必须整条匹配，使用 (?<name>...) 或第一个捕获组。手动指定填写开始/结束条目的 identifier。');
        const endRow = label('结束标记模板 / identifier', end), levelRow = label('标题层级', level);
        const refresh = () => { endRow.hidden = type.value === 'heading'; levelRow.hidden = type.value !== 'heading'; }; type.addEventListener('change', refresh);
        const error = ui.node('small', '', 'cla-preset-group-feedback'); error.setAttribute('role', 'alert');
        const submit = ui.button('保存规则', () => {
            const next = { ...rule, name: name.value.trim(), type: type.value, start: start.value, end: end.value, scope: scope.value,
                trim: trim.checked, normalize: normalize.checked, regex: regex.checked, level: Number(level.value) || 1 };
            try { validateSectionRule(next); } catch (failure) { error.textContent = failure.message; return; }
            save(value => { const index = value.rules.findIndex(item => item.id === next.id); if (index < 0) value.rules.push(next); else value.rules[index] = next; });
        });
        editor.append(label('规则名称', name), label('规则类型', type), label('开始标记模板 / identifier', start), endRow,
            label('匹配范围', scope), levelRow, label('忽略首尾空格', trim), label('全角半角归一化', normalize), label('高级正则表达式', regex), help,
            error, submit, ui.button('取消编辑', () => { editor.hidden = true; })); refresh(); name.focus({ preventScroll: true });
    };
    config.rules.forEach((rule, index) => {
        const row = ui.node('div', '', 'cla-preset-rule-row');
        row.append(checkbox(`${rule.name} · ${rule.builtin ? '内置' : '自定义'}`, rule.enabled, enabled => save(next => { next.rules[index].enabled = enabled; })),
            ui.button('编辑', () => edit(rule)), ui.button('↑', () => save(next => { if (index) [next.rules[index - 1], next.rules[index]] = [next.rules[index], next.rules[index - 1]]; })),
            ui.button('↓', () => save(next => { if (index < next.rules.length - 1) [next.rules[index + 1], next.rules[index]] = [next.rules[index], next.rules[index + 1]]; })));
        if (!rule.builtin) row.append(ui.button('删除', () => save(next => { next.rules.splice(index, 1); })));
        row.querySelectorAll('button')[1].setAttribute('aria-label', `提高优先级：${rule.name}`);
        row.querySelectorAll('button')[2].setAttribute('aria-label', `降低优先级：${rule.name}`);
        rules.append(row);
    });
    panel.append(ui.node('small', '头尾规则管理（手动区间、自定义、内置；同类按顺序）'), rules, ui.button('+ 添加自定义规则', () => edit()), editor,
        checkbox('新文件夹默认展开', config.defaultExpanded, checked => save(next => { next.defaultExpanded = checked; })),
        checkbox('隐藏已配对的头尾标记（仅视觉）', config.hideMarkers, checked => save(next => { next.hideMarkers = checked; })),
        ui.button('恢复默认识别规则', () => save(next => { next.rules = normalizeRecognition({ rules: [...DEFAULT_SECTION_RULES, ...next.rules.filter(rule => !rule.builtin)] }).rules; })));
}
