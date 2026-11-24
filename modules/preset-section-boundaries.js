// Recognition is opt-in by rule, on names by default. No content guessing.
export const DEFAULT_SECTION_RULES = [
    { id: 'builtin-arrows', name: '箭头方括号', type: 'pair', start: '====↓[{name}]↓====', end: '====↑[{name}]↑====', enabled: true },
    { id: 'builtin-quotes', name: '中文书名号', type: 'pair', start: '『 {name}', end: '{name} 』', enabled: true },
    { id: 'builtin-title', name: '单标题等号', type: 'heading', start: '=== {name} ===', end: '', enabled: false },
].map(rule => ({ ...rule, builtin: true, scope: 'name', trim: true, normalize: true, regex: false, level: 1 }));
export function normalizeRecognition(raw) {
    return { mode: ['off', 'pair', 'heading', 'mixed'].includes(raw?.mode) ? raw.mode : 'pair',
        defaultExpanded: raw?.defaultExpanded === true, hideMarkers: raw?.hideMarkers === true,
        rules: (Array.isArray(raw?.rules) ? raw.rules : DEFAULT_SECTION_RULES).filter(rule => rule && typeof rule === 'object').map((rule, index) => ({
            id: String(rule.id || `rule-${index}`), name: String(rule.name || '自定义规则'),
            type: ['pair', 'heading', 'manual'].includes(rule.type) ? rule.type : 'pair',
            start: String(rule.start || ''), end: String(rule.end || ''), enabled: rule.enabled !== false,
            builtin: DEFAULT_SECTION_RULES.some(item => item.id === rule.id), scope: rule.scope === 'content' ? 'content' : 'name',
            trim: rule.trim !== false, normalize: rule.normalize !== false, regex: rule.regex === true,
            level: Math.max(1, Math.min(20, Number(rule.level) || 1)),
        })).filter((rule, index, rules) => rules.findIndex(item => item.id === rule.id) === index) };
}
const clean = (value, rule) => { let text = String(value ?? ''); if (rule.normalize) text = text.normalize('NFKC'); return rule.trim ? text.trim() : text; };
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function compile(pattern, rule) {
    pattern = clean(pattern, rule);
    if (!pattern || pattern.length > 500) throw Error('标记模板请输入 1–500 个字符');
    if (!rule.regex && pattern.split('{name}').length !== 2) throw Error('普通模板必须包含一个 {name}');
    const expression = rule.regex ? pattern : pattern.split('{name}').map(escape).join('(?<name>.+?)');
    try { return new RegExp(`^(?:${expression})$`, 'u'); } catch (error) { throw Error(`正则表达式无效：${error.message}`); }
}
export function validateSectionRule(rule) {
    if (!rule.name.trim() || rule.name.length > 60) throw Error('规则名称请输入 1–60 个字符');
    if (rule.type === 'manual') { if (!rule.start || !rule.end || rule.start === rule.end) throw Error('请指定不同的开始与结束条目 identifier'); return; }
    compile(rule.start, rule); if (rule.type === 'pair') compile(rule.end, rule);
}
export function recognizePresetSections(entries, raw) {
    const config = normalizeRecognition(raw), diagnostics = [], sections = [], pending = [], headings = [], markerIds = new Set();
    if (config.mode === 'off') return { sections, diagnostics, markerIds };
    const rules = config.rules.filter(rule => rule.enabled && (rule.type === 'manual' || config.mode === 'mixed' || rule.type === config.mode))
        .sort((a, b) => Number(b.type === 'manual') - Number(a.type === 'manual') || Number(a.builtin) - Number(b.builtin)).flatMap(rule => {
            try { validateSectionRule(rule); return [{ ...rule, head: rule.type !== 'manual' && compile(rule.start, rule), tail: rule.type === 'pair' && compile(rule.end, rule) }]; }
            catch (error) { diagnostics.push(`${rule.name}：${error.message}`); return []; }
        });
    const seen = new Map();
    for (const rule of rules) {
        const signature = JSON.stringify([rule.type, rule.scope, rule.regex, clean(rule.start, rule)]);
        if (seen.has(signature)) diagnostics.push(`${rule.name} 与 ${seen.get(signature)} 的开始规则冲突，按优先级使用先匹配的规则`);
        else seen.set(signature, rule.name);
    }
    const key = (value, rule) => clean(value, rule);
    const emit = (open, end) => {
        sections.push({ start: open.index, end, name: open.group, ruleId: open.rule.id, type: open.rule.type,
            key: JSON.stringify([open.rule.id, entries[open.index].identifier, open.rule.type === 'heading' ? '@heading' : entries[end].identifier]) });
    };
    entries.forEach((entry, index) => {
        const matches = [];
        for (const rule of rules) {
            const text = clean(entry[rule.scope], rule);
            for (const [direction, expression] of [['start', rule.head], ['end', rule.tail]]) {
                const result = rule.type === 'manual' ? entry.identifier === rule[direction === 'start' ? 'start' : 'end'] : (expression ? expression.exec(text) : null);
                if (!result) continue;
                const matchName = rule.type === 'manual' ? rule.name : (result.groups?.name || result[1] || '');
                const group = matchName.trim();
                if (!group || group.length > 60 || /[\u0000-\u001f\u007f]/u.test(group)) { diagnostics.push(`${entry.name}：规则需要提取 1–60 字的分类名称（正则使用 (?<name>...)）`); continue; }
                matches.push({ direction, group, matchName, rule, index });
            }
            // Priority resolves overlapping rules; ambiguous directions within a rule do not.
            if (matches.length) break;
        }
        if (!matches.length) return;
        if (matches.length === 2 && !matches[0].rule.regex && matches[0].rule.type !== 'manual') {
            const rule = matches[0].rule;
            const specificity = pattern => clean(pattern, rule).replace('{name}', '').length;
            const difference = specificity(rule.start) - specificity(rule.end);
            if (difference) matches.splice(difference > 0 ? 1 : 0, 1);
        }
        if (matches.length !== 1) { diagnostics.push(`${entry.name}：开始与结束标记冲突`); return; }
        const marker = matches[0];
        if (marker.rule.type === 'heading') {
            while (headings.length && (headings.at(-1).rule.level >= marker.rule.level || headings.at(-1).pairDepth !== pending.length)) emit(headings.pop(), index - 1);
            headings.push({ ...marker, pairDepth: pending.length }); return;
        }
        if (marker.direction === 'start') {
            // An explicit pair is a boundary for the current heading interval.
            // It cannot make that heading straddle the pair's opening marker.
            while (headings.length && headings.at(-1).pairDepth >= pending.length) emit(headings.pop(), index - 1);
            pending.push(marker); return;
        }
        const match = pending.findLastIndex(item => item.rule.id === marker.rule.id && key(item.matchName, item.rule) === key(marker.matchName, marker.rule));
        if (match < 0) { diagnostics.push(`${entry.name}：结束标记未配对`); return; }
        if (match !== pending.length - 1) {
            for (const item of pending.splice(match)) diagnostics.push(`${entries[item.index].name}：交叉或错误嵌套`);
            return;
        }
        while (headings.length && headings.at(-1).pairDepth >= pending.length) emit(headings.pop(), index - 1);
        emit(pending.pop(), index);
    });
    for (const marker of pending) diagnostics.push(`${entries[marker.index].name}：开始标记未配对`);
    while (headings.length) { const heading = headings.pop(); if (!heading.pairDepth) emit(heading, entries.length - 1); else diagnostics.push(`${heading.group}：所在区间未闭合`); }
    // A heading must never cross an explicit pair boundary or a rejected interval.
    const crossing = (a, b) => a.start < b.start && b.start <= a.end && a.end < b.end;
    const valid = sections.filter(a => !sections.some(b => crossing(a, b) || crossing(b, a)))
        .sort((a, b) => a.start - b.start || b.end - a.end);
    for (const section of valid) { markerIds.add(entries[section.start].identifier); if (section.type !== 'heading') markerIds.add(entries[section.end].identifier); }
    return { sections: valid, diagnostics, markerIds };
}
export function findPresetSections(entries, config) { return recognizePresetSections(entries, config).sections.map(({ start, end, name }) => ({ start, end, name })); }
export function parsePresetSectionMarker(name) {
    for (const rule of DEFAULT_SECTION_RULES.filter(rule => rule.enabled)) for (const [direction, pattern] of [['start', rule.start], ['end', rule.end]]) {
        const result = compile(pattern, rule).exec(clean(name, rule));
        if (result) return { direction, group: result.groups.name, family: rule.id };
    }
    return null;
}
