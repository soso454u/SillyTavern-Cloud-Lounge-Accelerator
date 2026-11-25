import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { folderLayout, PRESET_GROUPS_KEY } from '../modules/preset-folder-model.js';
import { findPresetSections } from '../modules/preset-section-boundaries.js';
import { PresetEntryGroups } from '../modules/preset-entry-groups.js';

const entries = (...names) => names.map((name, index) => ({ name, identifier: String(index) }));
const flatten = nodes => nodes.flatMap(node => node.entry ? [node.entry] : flatten(node.children));

test('nested pairs leave every native row in order, including rows outside groups', () => {
    const prompts = entries('身份1', '身份2', '『 写作规则', '正文', '====↓[内层]↓====', '内文', '====↑[内层]↑====', '写作规则 』', '收尾');
    const layout = folderLayout(prompts);
    assert.deepEqual(layout.map(node => node.entry?.name ?? node.name), ['身份1', '身份2', '写作规则', '收尾']);
    assert.equal(layout[2].children[2].name, '内层');
    assert.deepEqual(flatten(layout), prompts);
});

test('unpaired, mismatched and crossed boundaries do not create folders', () => {
    const prompts = entries('=== 基调等 ===', '『 写作规则', '====↓[A]↓====', '写作规则 』',
        '====↑[A]↑====', '↓没有结尾↓', '正文', '↑不同名↑', '末尾');
    assert.deepEqual(findPresetSections(prompts).filter(s => s.name !== '基调等'), []);
    assert.deepEqual(flatten(folderLayout(prompts)), prompts);
});

test('a one-sided heading groups rows until the next divider or its parent end', () => {
    const prompts = entries('---- 外层 ----', '----孤立标题----', '正文', '---- 外层结束 ----', '=== 基调 ===', '甲', '乙', '---- 下一段 ----', '丙', '---- 下一段结束 ----');
    assert.deepEqual(findPresetSections(prompts).map(s => [s.name, s.start, s.end]),
        [['外层', 0, 3], ['基调', 4, 6], ['下一段', 7, 9]]);
    assert.deepEqual(flatten(folderLayout(prompts)), prompts);
});

test('neighbours sharing a name stem fold together; manual groups win', () => {
    const prompts = entries('开头', '身份1', '身份2', '身份3', '「写卡」甲', '「写卡」乙', '「写卡」丙', '单独');
    assert.deepEqual(findPresetSections(prompts).map(s => [s.name, s.start, s.end]), [['身份', 1, 3], ['写卡', 4, 6]]);
    const layout = folderLayout(prompts, [{ start: '2', end: '5', name: '我的' }], {});
    assert.deepEqual(layout.map(n => n.name ?? n.entry.name), ['开头', '身份1', '我的', '「写卡」丙', '单独']);
    assert.deepEqual(flatten(layout), prompts);
});

test('deleted auto groups are hidden without touching rows', () => {
    const prompts = entries('↓A↓', '甲', '↑A↑');
    const layout = folderLayout(prompts, [], {}, [JSON.stringify(['0', '2'])]);
    assert.deepEqual(layout.map(n => n.entry.name), ['↓A↓', '甲', '↑A↑']);
});

test('renamed folders keep their original name for reset', () => {
    const prompts = entries('↓A↓', '甲', '↑A↑');
    const [folder] = folderLayout(prompts, [], { [JSON.stringify(['0', '2'])]: '新名' });
    assert.equal(folder.name, '新名'); assert.equal(folder.original, 'A');
});

test('same-named pairs on separate intervals get independent fold identities', () => {
    const layout = folderLayout(entries('↓A↓', '甲', '↑A↑', '无分组', '↓A↓', '乙', '↑A↑'));
    assert.deepEqual(layout.map(node => node.name ?? node.entry.name), ['A', '无分组', 'A']);
    assert.notEqual(layout[0].id, layout[2].id);
});

test('upgrading clears the old rule and manual grouping store once', () => {
    const legacy = { schema: 4, assignments: { a: { folderId: 'manual' } }, recognition: { rules: [{ id: 'old' }] } };
    const native = { unrelated: { setting: 1 }, [PRESET_GROUPS_KEY]: { a: legacy, b: legacy } };
    let saves = 0;
    const groups = new PresetEntryGroups({ extensionSettings: native, saveSettings: () => saves++ });
    groups.start();
    groups.start();
    assert.equal(saves, 1);
    assert.deepEqual(native, { unrelated: { setting: 1 }, [PRESET_GROUPS_KEY]: { schema: 5, expandedByPreset: {} } });
});

test('rebuilding native rows in the same list releases removed row style references', () => {
    const list = { isConnected: true, classList: { add() {} }, querySelectorAll: () => [], contains: () => false };
    const groups = new PresetEntryGroups({ host: { manager: { listElement: list } } });
    const context = { key: 'same-preset', order: [], prompts: [] };
    groups.key = context.key;
    groups.list = list;
    groups.context = () => context;
    groups.entries = () => [];
    groups.meta = () => ({});
    groups.expanded = () => new Set();
    groups.groupedDrag = { reconcile() {} };
    groups.sortable = () => null;
    for (const method of ['renderToolbar', 'protectSortable', 'watchMultiDrag', 'watchStatus']) groups[method] = () => {};
    for (let rebuild = 0; rebuild < 50; rebuild++) {
        // Native PromptManager replaces list children without replacing the list.
        const removedRow = { isConnected: false };
        groups.rowStyles.set(removedRow, [{ property: 'display', value: '', applied: 'none' }]);
        groups.render();
        assert.equal(groups.rowStyles.size, 0, `removed rows retained after native rebuild ${rebuild}`);
    }
});

test('real v1.35 recognizes paired dividers and keeps identity rows above writing', { skip: !process.env.CLA_PRESET_FIXTURE }, async () => {
    const preset = JSON.parse(await readFile(process.env.CLA_PRESET_FIXTURE, 'utf8'));
    const byId = new Map(preset.prompts.map(prompt => [prompt.identifier, prompt]));
    const ordered = preset.prompt_order[0].order.map(row => byId.get(row.identifier));
    const before = JSON.stringify(preset);
    assert.deepEqual(findPresetSections(ordered).map(x => x.name),
        ['身份', '写卡', '写作规则', '基调等', '不要动', '规则', '小剧场', 'NSFW', '缱绻 (二选一)', '姿势库', 'CP', '⦉ User攻 ⦊', '文风', '肉文', '视角模式', '双视角', '群像', '剧情选项', '选一', '思维链', '不一定管用的破限']);
    const layout = folderLayout(ordered);
    const writing = layout.findIndex(node => node.name === '写作规则');
    assert.deepEqual(layout.slice(0, writing).find(node => node.name === '身份').children.map(node => node.entry.name),
        ['身份1', '身份2', '身份3', '身份4', '身份5']);
    assert.deepEqual(flatten(layout), ordered);
    assert.equal(JSON.stringify(preset), before);
});
