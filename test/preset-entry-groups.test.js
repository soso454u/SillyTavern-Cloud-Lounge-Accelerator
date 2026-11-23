import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyPresetGroup, classifyPresetEntries, parsePresetSectionMarker, normalizePresetGroup, PresetEntryGroups, PRESET_GROUPS_KEY, readPresetGroups } from '../modules/preset-entry-groups.js';

test('preset names recognize brackets, categories and numbered packs without reading content', () => {
    for (const [name, group] of [
        ['【文风】描写', '文风'], ['[规则]约束', '规则'], ['「世界观」背景', '世界观'],
        ['身份：设定', '身份'], ['文风·描写', '文风'], ['00b | 世界观 | 背景', '世界观'],
        ['普通条目', '未分类'], ['[ ]空前缀', '未分类'],
    ]) assert.equal(identifyPresetGroup({ identifier: 'a', name, get content() { throw Error('body accessed'); } }), group);
    assert.equal(identifyPresetGroup({ identifier: 'a', name: '[规则]约束' }, { autoPrefix: false }), '未分类');
});

test('manual assignment (including ungrouped) wins; custom rules use first match and ignore case', () => {
    const prompt = { identifier: '__proto__', name: '[规则]STYLE 描写' };
    const state = { rules: [{ mode: 'contains', value: 'style', group: '文风' }, { mode: 'prefix', value: '[规则]', group: '规则' }] };
    assert.equal(identifyPresetGroup(prompt, state), '文风');
    state.assignments = JSON.parse('{"__proto__":"手动"}');
    assert.equal(identifyPresetGroup(prompt, state), '手动');
    state.assignments = JSON.parse('{"__proto__":"未分类"}');
    assert.equal(identifyPresetGroup(prompt, state), '未分类');
    assert.equal(identifyPresetGroup({ identifier: 'x', name: 'STYLES' }, { rules: [{ mode: 'prefix', value: 'style', group: '文风' }] }), '文风');
});

test('paired wrapper headings group intervening entries in native order, including disabled headings', () => {
    const entries = ['====↓[文风]', '自适应文风', '晋江', '窄门', '文学灵气', '====↑[文风]', '普通条目']
        .map((name, index) => ({ identifier: String(index), name, enabled: false }));
    const before = JSON.stringify(entries);
    assert.deepEqual([...classifyPresetEntries(entries).values()], ['文风', '文风', '文风', '文风', '文风', '文风', '未分类']);
    assert.equal(classifyPresetEntries(entries, { autoSections: false }).get('1'), '未分类');
    assert.equal(classifyPresetEntries(entries, { autoPrefix: false }).get('1'), '文风');
    const overrides = { assignments: { 1: '我的分类', 2: '未分类' }, rules: [{ mode: 'contains', value: '窄门', group: '作品' }] };
    assert.deepEqual([...classifyPresetEntries(entries, overrides).values()], ['文风', '我的分类', '未分类', '作品', '文风', '文风', '未分类']);
    assert.equal(JSON.stringify(entries), before);
    assert.deepEqual(parsePresetSectionMarker('＝＝⬇【文风开始】＝＝'), { direction: 'start', group: '文风' });
    assert.deepEqual(parsePresetSectionMarker('──⬆【文风结束】──'), { direction: 'end', group: '文风' });
    assert.equal(parsePresetSectionMarker('正文里提到 ↓[文风]'), null);
});

test('nested wrappers select the innermost group; unpaired, mismatched and crossing wrappers cannot swallow later entries', () => {
    const classify = names => [...classifyPresetEntries(names.map((name, index) => ({ identifier: String(index), name }))).values()];
    assert.deepEqual(classify(['↓[规则]', '外部', '↓[文风]', '内部', '↑[文风]', '外部2', '↑[规则]', '组外']),
        ['规则', '规则', '文风', '文风', '文风', '规则', '规则', '未分类']);
    for (const names of [['↓[规则]', '普通', '组外'], ['↓[规则]', '普通', '↑[文风]', '组外'],
        ['↓[规则]', '↓[文风]', '普通', '↑[规则]', '↑[文风]', '组外']]) {
        assert.ok(classify(names).every(group => group === '未分类'));
    }
});

function fixture() {
    const extensionSettings = {}; let name = 'A', saves = 0;
    const prompts = [{ identifier: 'a', name: '[规则]A' }, { identifier: 'b', name: '普通条目' }];
    const order = [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: false }];
    let native = { prompts, order, characterId: '1' };
    const host = { context: () => native, current: context => context.prompts === native.prompts && context.order === native.order && context.characterId === native.characterId };
    const groups = new PresetEntryGroups({ host, extensionSettings, getPresetName: () => name, saveSettings: () => saves++ });
    groups.render = () => {};
    return { groups, extensionSettings, prompts, order, saves: () => saves, change: (preset, character = '1') => { name = preset; native = { ...native, characterId: character }; } };
}

test('create, batch assign, rename, delete and resume auto save metadata only, isolated by preset and character', () => {
    const f = fixture(), g = f.groups, context = g.context();
    const before = JSON.stringify({ prompts: f.prompts, order: f.order });
    g.create(context, '自定义'); g.assign(context, ['a', 'b'], '自定义');
    assert.equal(f.saves(), 2);
    g.rename(context, '自定义', '我的组');
    assert.deepEqual(g.state().assignments, { a: '我的组', b: '我的组' });
    g.remove(context, '我的组');
    assert.deepEqual(g.state().assignments, { a: '未分类', b: '未分类' });
    g.assign(context, ['a'], '@auto');
    assert.equal(identifyPresetGroup(f.prompts[0], g.state()), '规则');
    f.change('B'); assert.deepEqual(g.state().assignments, {});
    assert.throws(() => g.create(context, '过期操作'), /切换/);
    f.change('A', '2'); assert.deepEqual(g.state().assignments, {});
    f.change('A'); assert.equal(g.state().assignments.b, '未分类');
    assert.equal(JSON.stringify({ prompts: f.prompts, order: f.order }), before);
    assert.ok(f.extensionSettings[PRESET_GROUPS_KEY]);
    assert.deepEqual(readPresetGroups(JSON.parse(JSON.stringify(f.extensionSettings)), context.key), g.state());
});

test('reject duplicate/invalid names and missing IDs; rename/delete cover rules and absent library entries', () => {
    const f = fixture(), g = f.groups, context = g.context();
    for (const name of ['', '未分类', '@auto', 'a\nb', 'a'.repeat(61)]) assert.throws(() => normalizePresetGroup(name));
    assert.throws(() => g.create(context, '规则'), /同名/);
    assert.throws(() => g.assign(context, ['missing'], '新组'), /不在当前列表/);
    g.commit(context, { ...g.state(), groups: ['文风'], assignments: { absent: '文风' }, rules: [{ mode: 'contains', value: '普通', group: '文风' }] });
    g.rename(context, '文风', '描写');
    assert.equal(g.state().rules[0].group, '描写'); assert.equal(g.state().assignments.absent, '描写');
    g.remove(context, '描写');
    assert.deepEqual(g.state().rules, []); assert.equal(g.state().assignments.absent, '未分类');
    g.saveSettings = () => { throw Error('save failed'); };
    const before = JSON.stringify(f.extensionSettings);
    assert.throws(() => g.create(context, '保存失败'), /save failed/);
    assert.equal(JSON.stringify(f.extensionSettings), before);
});

test('group order and fold state persist separately from native execution order; stale dragging cannot write', () => {
    const f = fixture(), g = f.groups, context = g.context();
    const before = JSON.stringify(f.order);
    g.create(context, '我的组');
    assert.equal(g.collapsedNames(context).has('规则'), true);
    assert.equal(g.collapsedNames(context).has('未分类'), false);
    g.moveGroup(context, '我的组', '规则', false);
    assert.equal(g.orderedNames(context)[0], '我的组');
    g.commit(context, { ...g.state(), collapsed: ['规则'] });
    g.rename(context, '规则', '要求');
    assert.deepEqual(g.state().collapsed, ['要求']);
    assert.ok(g.state().groupOrder.includes('要求'));
    assert.equal(JSON.stringify(f.order), before);
    f.change('B'); assert.deepEqual(g.state().groupOrder, []);
    assert.throws(() => g.moveGroup(context, '我的组', '要求', true), /切换/);
    f.change('A'); assert.equal(g.orderedNames(g.context())[0], '我的组');
});
