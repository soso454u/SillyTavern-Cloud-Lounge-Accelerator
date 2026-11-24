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
        '====↑[A]↑====', '↓没有结尾↓', '正文', '↑不同名↑', '---普通分隔---', '末尾');
    assert.deepEqual(findPresetSections(prompts), []);
    assert.deepEqual(flatten(folderLayout(prompts)), prompts);
});

test('an unmatched decorative row inside a valid pair stays an ordinary row', () => {
    const prompts = entries('---- 外层 ----', '----孤立标题----', '正文', '---- 外层结束 ----');
    assert.deepEqual(findPresetSections(prompts), [{ start: 0, end: 3, name: '外层' }]);
    assert.equal(folderLayout(prompts)[0].children[1].entry.name, '----孤立标题----');
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

test('real v1.35 recognizes paired dividers and keeps identity rows above writing', { skip: !process.env.CLA_PRESET_FIXTURE }, async () => {
    const preset = JSON.parse(await readFile(process.env.CLA_PRESET_FIXTURE, 'utf8'));
    const byId = new Map(preset.prompts.map(prompt => [prompt.identifier, prompt]));
    const ordered = preset.prompt_order[0].order.map(row => byId.get(row.identifier));
    const before = JSON.stringify(preset);
    assert.deepEqual(findPresetSections(ordered).map(x => x.name),
        ['写作规则', '不要动', 'USER信息', '规则', '小剧场', 'NSFW', '缱绻 (二选一)', '⦉ User攻 ⦊', '文风', '视角模式', '选一', '思维链', '不一定管用的破限']);
    const layout = folderLayout(ordered);
    const writing = layout.findIndex(node => node.name === '写作规则');
    assert.deepEqual(layout.slice(0, writing).filter(node => /^身份\d$/u.test(node.entry?.name)).map(node => node.entry.name),
        ['身份1', '身份2', '身份3', '身份4', '身份5']);
    assert.deepEqual(flatten(layout), ordered);
    assert.equal(JSON.stringify(preset), before);
});
