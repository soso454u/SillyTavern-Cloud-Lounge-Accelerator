import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { emptyFolders, normalizeFolderState, assignedFolder, folderPath, folderLayout, createFolder, renameFolder, moveFolder, deleteFolder, assignEntries, syncPresetSections, importFolderMetadata, promptFingerprint } from '../modules/preset-folder-model.js';
import { findPresetSections } from '../modules/preset-section-boundaries.js';
import { PresetEntryGroups, PRESET_GROUPS_KEY } from '../modules/preset-entry-groups.js';

const prompts = () => [{ identifier: 'later', name: '[看似分类]示例', role: 'system', content: 'ordinary rule', injection_position: 1, injection_depth: 4, injection_order: 25 },
    { identifier: 'first', name: 'plain', content: 'retain exact body', marker: false }, { identifier: 'marker', name: 'history', marker: true, system_prompt: true }];
const ordered = items => [items[1], items[2], items[0]];
let sequence = 0; const uuid = () => `folder-${++sequence}`;

test('folders have stable IDs, arbitrary nesting, safe parent changes and deletion without native mutation', () => {
    const native = { prompts: prompts(), prompt_order: [{ character_id: 1, order: [{ identifier: 'first', enabled: true }, { identifier: 'marker', enabled: true }, { identifier: 'later', enabled: false }] }] };
    const before = JSON.stringify(native), state = emptyFolders();
    const parent = createFolder(state, '资料', null, uuid), child = createFolder(state, '风格', parent, uuid), deep = createFolder(state, '成人文风', child, uuid);
    assignEntries(state, native.prompts, ['first', 'marker'], deep); renameFolder(state, child, '文风');
    assert.equal(folderPath(state, deep), '资料 / 文风 / 成人文风');
    assert.throws(() => moveFolder(state, parent, deep), /不能移入/);
    deleteFolder(state, child); assert.equal(state.folders.find(folder => folder.id === deep).parentId, parent);
    assert.equal(assignedFolder(state, 'first'), deep); deleteFolder(state, deep);
    assert.equal(assignedFolder(state, 'first'), parent); deleteFolder(state, parent);
    assert.equal(assignedFolder(state, 'first'), null); assert.equal(state.folders.length, 0);
    assert.equal(JSON.stringify(native), before);
});

const projectedEntries = nodes => nodes.flatMap(node => node.entry ? [node.entry] : projectedEntries(node.children));

test('folder layout keeps the full native sequence even with manual folders spanning separate intervals', () => {
    const items = prompts(), state = emptyFolders();
    const outer = createFolder(state, '文风', null, uuid), child = createFolder(state, 'NSFW', outer, uuid);
    assignEntries(state, items, ['first', 'later'], child);
    state.order['@root'] = [child, outer]; // obsolete saved visual order
    const layout = folderLayout(state, ordered(items));
    assert.deepEqual(layout.map(node => node.id || node.entry.identifier), [outer, 'marker', outer]);
    assert.deepEqual(projectedEntries(layout), ordered(items));
    assert.deepEqual(layout.filter(node => node.id).map(node => node.total), [1, 1]);
});

test('legacy migration retains only explicit references, archives old metadata, and never guesses from a name', () => {
    const old = { groups: ['自建'], assignments: { first: '自建', missing: '过期' }, autoPrefix: true, rules: [{ group: '猜测', value: 'plain' }] };
    const state = normalizeFolderState(old, prompts(), 'scope');
    assert.equal(state.schema, 4); assert.equal(state.folders.length, 1);
    assert.equal(assignedFolder(state, 'later'), null); assert.equal(state.assignments.missing, undefined);
    assert.ok(assignedFolder(state, 'first')); assert.deepEqual(state.legacyBackup, old);
    assert.deepEqual(normalizeFolderState(state, prompts()), state);
});

test('metadata round-trip checks identifiers and content signatures; imports cannot rebind changed content', () => {
    const items = prompts(), state = emptyFolders(), folder = createFolder(state, '保留', null, uuid);
    assignEntries(state, items, ['first', 'later'], folder);
    const exported = JSON.parse(JSON.stringify(state));
    assert.equal(importFolderMetadata(exported, items).skipped, 0);
    const incoming = structuredClone(items); incoming[1].content = 'a different preset with the same identifier';
    const result = importFolderMetadata(exported, incoming);
    assert.equal(result.skipped, 1); assert.equal(assignedFolder(result.state, 'first'), null); assert.equal(assignedFolder(result.state, 'later'), folder);
    assert.equal(promptFingerprint(items[1]), exported.fingerprints.first);
    assert.throws(() => importFolderMetadata({ folders: [] }, items), /分类文件/);
});

const namedEntries = names => names.map((name, i) => ({ identifier: String(i), name, content: 'body' }));

test('matches nested structural dividers and keeps rows between and outside the intervals in place', () => {
    const entries = namedEntries(['开场', '====↓[规则]↓====', '直属一', '『 写作规则', '内部', '写作规则 』', '直属二', '====↑[规则]↑====', '结尾']);
    const state = emptyFolders();
    assert.deepEqual(findPresetSections(entries), [{ start: 1, end: 7, name: '规则' }, { start: 3, end: 5, name: '写作规则' }]);
    assert.ok(syncPresetSections(state, entries));
    const layout = folderLayout(state, entries), outer = layout[1];
    assert.equal(outer.total, 7);
    assert.deepEqual(outer.children.map(node => node.entry?.name || node.name), ['====↓[规则]↓====', '直属一', '写作规则', '直属二', '====↑[规则]↑====']);
    assert.equal(folderPath(state, assignedFolder(state, '4')), '规则 / 写作规则');
    assert.deepEqual(projectedEntries(layout), entries);
    assert.equal(syncPresetSections(state, entries), false);
});

test('replaces old automatic folders, preserves explicit moves, and never recreates deleted sections', () => {
    const entries = namedEntries(['开场', '<!-- == 视角模式 == -->', '内容', '另一条', '<!-- ===== -->', '尾声']);
    const state = emptyFolders(), old = createFolder(state, '文风', null, uuid);
    assignEntries(state, entries, ['0', '2'], old, 'auto');
    assignEntries(state, entries, ['3'], null);
    assert.ok(syncPresetSections(state, entries));
    assert.equal(assignedFolder(state, '0'), null);
    assert.equal(state.folders.some(folder => folder.id === old), false);
    assert.deepEqual(state.assignments['3'], { folderId: null, source: 'manual' });
    const id = assignedFolder(state, '2');
    assert.equal(folderPath(state, id), '视角模式');
    assert.equal(assignedFolder(normalizeFolderState(state), '2'), id);
    deleteFolder(state, id);
    assert.ok(syncPresetSections(state, entries));
    assert.equal(state.folders.length, 0);
    assert.equal(assignedFolder(state, '2'), null);
});

test('repeated decorated labels are separate sections, and orphan or crossing headings stay ungrouped', () => {
    const entries = namedEntries(['꒰১┈┈文风┈┈໒꒱', '甲', '꒰১┈┈文风┈┈໒꒱', '无分组', '꒰১┈┈文风┈┈໒꒱', '乙', '꒰১┈┈文风┈┈໒꒱',
        '↓A', '↓B', '丙', '↑A', '↑B', '『 未闭合', '末尾']);
    const state = emptyFolders();
    syncPresetSections(state, entries);
    assert.equal(state.folders.length, 2);
    assert.notEqual(assignedFolder(state, '1'), assignedFolder(state, '5'));
    assert.equal(assignedFolder(state, '9'), null);
    assert.equal(assignedFolder(state, '13'), null);
    assert.deepEqual(projectedEntries(folderLayout(state, entries)), entries);
});

test('respects saved expanded folders while defaulting newly created folders to folded', () => {
    const state = emptyFolders(), parent = createFolder(state, '自建', null, uuid);
    state.collapsed = [];
    const saved = normalizeFolderState(state);
    const child = createFolder(saved, '新子目录', parent, uuid);
    assert.deepEqual(saved.collapsed, [child]);
    assert.deepEqual(normalizeFolderState(saved).collapsed, [child]);
});

test('scope isolation and stale UI guards protect the native preset and newer settings', () => {
    const items = prompts(), settings = {}, context = { prompts: items, order: ordered(items).map(item => ({ identifier: item.identifier, enabled: true })), characterId: '1' };
    let preset = 'A', saves = 0;
    const host = { context: () => context, current: value => value?.prompts === context.prompts && value?.order === context.order };
    const groups = new PresetEntryGroups({ host, extensionSettings: settings, saveSettings: () => saves++, getPresetName: () => preset }); groups.render = () => {};
    const snapshot = JSON.stringify(context), first = groups.context();
    const folder = groups.create(first, '文件夹'); groups.assign(first, ['first'], folder);
    assert.equal(saves, 2); preset = 'B'; assert.equal(groups.state().folders.length, 0);
    assert.throws(() => groups.create(first, '过期'), /切换/); preset = 'A'; assert.equal(groups.state().folders.length, 1);
    const before = JSON.stringify(settings); groups.saveSettings = () => { throw Error('offline'); };
    assert.throws(() => groups.create(groups.context(), '失败'), /offline/); assert.equal(JSON.stringify(settings), before);
    assert.equal(JSON.stringify(context), snapshot); assert.ok(settings[PRESET_GROUPS_KEY]);
});

test('identifier dictionaries and imported parent cycles are handled as data', () => {
    const items = [{ identifier: '__proto__', content: 'original' }], state = emptyFolders(), id = createFolder(state, '安全', null, uuid);
    assignEntries(state, items, ['__proto__'], id);
    assert.equal(Object.hasOwn(state.assignments, '__proto__'), true);
    assert.equal(assignedFolder(normalizeFolderState(JSON.parse(JSON.stringify(state)), items), '__proto__'), id);
    const cycle = normalizeFolderState({ schema: 4, folders: [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }] });
    assert.ok(cycle.folders.some(folder => folder.parentId === null));
});

test('same-name native imports invalidate changed content references without mutating native data', () => {
    const items = prompts(), context = { prompts: items, order: ordered(items).map(item => ({ identifier: item.identifier })), characterId: '1' }, settings = {}, listeners = new Map();
    const host = { context: () => context, current: value => value?.prompts === items && value?.order === context.order };
    const groups = new PresetEntryGroups({ host, extensionSettings: settings, getPresetName: () => 'A', saveSettings() {},
        eventSource: { on: (type, handler) => listeners.set(type, handler), removeListener: type => listeners.delete(type) }, eventTypes: { OAI_PRESET_IMPORT_READY: 'import' } });
    groups.render = () => {}; groups.start(); const folder = groups.create(groups.context(), '目录'); groups.assign(groups.context(), ['first'], folder);
    const incoming = structuredClone(items); incoming[1].content = 'Different import'; const snapshot = JSON.stringify(context);
    listeners.get('import')({ presetName: 'A', data: { prompts: incoming } });
    assert.equal(assignedFolder(groups.state(), 'first'), null); assert.equal(JSON.stringify(context), snapshot);
    groups.stop(); assert.equal(listeners.size, 0);
});

test('real preset compatibility: classify references, fold and delete folders while every native byte remains unchanged', { skip: !process.env.CLA_PRESET_FIXTURE }, async () => {
    const data = JSON.parse(await readFile(process.env.CLA_PRESET_FIXTURE, 'utf8')), before = JSON.stringify(data);
    const byId = new Map(data.prompts.map(prompt => [prompt.identifier, prompt])), holder = data.prompt_order.toSorted((a, b) => b.order.length - a.order.length)[0], entries = holder.order.map(item => byId.get(item.identifier)).filter(Boolean);
    const state = emptyFolders(), parent = createFolder(state, '测试目录', null, uuid), child = createFolder(state, '测试子目录', parent, uuid);
    assignEntries(state, data.prompts, entries.slice(0, 8).map(prompt => prompt.identifier), child); state.collapsed.push(parent);
    assert.ok(syncPresetSections(state, entries));
    assert.deepEqual(projectedEntries(folderLayout(state, entries)), entries);
    assert.ok(entries.slice(0, 8).every(prompt => assignedFolder(state, prompt.identifier) === child));
    deleteFolder(state, child); deleteFolder(state, parent);
    assert.equal(JSON.stringify(data), before);
    assert.deepEqual(entries.map(entry => entry.identifier), holder.order.filter(item => byId.has(item.identifier)).map(item => item.identifier));
});
