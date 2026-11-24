import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { emptyFolders, normalizeFolderState, assignedFolder, folderPath, folderTree, createFolder, renameFolder, moveFolder, deleteFolder, assignEntries, importFolderMetadata, promptFingerprint } from '../modules/preset-folder-model.js';
import { semanticSuggestion, folderSuggestions } from '../modules/preset-folder-suggestions.js';
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

test('initial display order comes from prompt_order, not prompts storage; explicit folder order remains separate', () => {
    const items = prompts(), state = emptyFolders();
    const later = createFolder(state, '后段', null, uuid), first = createFolder(state, '前段', null, uuid);
    assignEntries(state, items, ['first'], first); assignEntries(state, items, ['later'], later);
    assert.deepEqual(folderTree(state, ordered(items)).map(folder => folder.id), [first, later, null]);
    state.order['@root'] = [later, first];
    assert.equal(folderTree(state, ordered(items))[0].id, later);
    assert.deepEqual(ordered(items).map(item => item.identifier), ['first', 'marker', 'later']);
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

test('user decisions, including unclassified, override reviewed suggestions; mixed adult style is a style subfolder suggestion', () => {
    const state = emptyFolders(), items = prompts(), folder = createFolder(state, '用户归属', null, uuid), other = createFolder(state, '建议', null, uuid);
    assignEntries(state, items, ['first'], folder); assignEntries(state, items, ['later'], null);
    assignEntries(state, items, ['first', 'later'], other, 'accepted');
    assert.equal(assignedFolder(state, 'first'), folder); assert.equal(assignedFolder(state, 'later'), null);
    assert.equal(semanticSuggestion({ name: '[NSFW]成人', content: 'plain unknown words' }), null);
    assert.equal(semanticSuggestion({ content: 'Literary style and prose sentence rhythm may mention desire as an aesthetic.' }).path[0], '文风');
    const mixed = semanticSuggestion({ content: 'Literary style, prose sentence rhythm, sexual scenes and sexual anatomy with foreplay.' });
    assert.deepEqual(mixed.path, ['文风', '成人文风']); assert.equal(mixed.confidence, '混合内容');
    assert.equal(semanticSuggestion({ content: 'Unstructured ambiguous instruction' }), null);
});

test('boundaries are optional preview context, handle repeated arrows and split brackets without altering data', () => {
    const entries = ['====↓[任意名称]↓====', 'ordinary', '====↑[任意名称]↑====', '『 Outer', 'nested', 'Outer 』'].map((name, i) => ({ identifier: String(i), name, content: '' }));
    const before = JSON.stringify(entries), state = emptyFolders();
    assert.equal(findPresetSections(entries).length, 2);
    assert.equal(folderSuggestions(entries, state, 'boundaries').length, 6);
    assert.equal(folderSuggestions(entries, state, 'content').length, 0);
    assert.deepEqual(state.assignments, {}); assert.equal(JSON.stringify(entries), before);
    assert.equal(findPresetSections([{ name: '====↓[缺少结束]↓====' }, { name: 'ordinary' }]).length, 0);
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

test('folder dragging saves only stable folder IDs and preserves unrelated parent order', () => {
    const items = prompts(), context = { prompts: items, order: ordered(items).map(prompt => ({ identifier: prompt.identifier, enabled: true })), characterId: '1' }, settings = {};
    const host = { context: () => context, current: value => value?.order === context.order && value?.prompts === items };
    const groups = new PresetEntryGroups({ host, extensionSettings: settings, getPresetName: () => 'A' }); groups.render = () => {};
    const snapshot = JSON.stringify(context), a = groups.create(groups.context(), 'A'), b = groups.create(groups.context(), 'B'), child = groups.create(groups.context(), '子层', a);
    groups.moveGroup(groups.context(), b, a, false);
    assert.deepEqual(groups.state().order['@root'], [b, a]);
    assert.throws(() => groups.moveGroup(groups.context(), child, b, false), /同一级/);
    assert.equal(JSON.stringify(context), snapshot);
});

test('real preset compatibility: classify references, fold and delete folders while every native byte remains unchanged', { skip: !process.env.CLA_PRESET_FIXTURE }, async () => {
    const data = JSON.parse(await readFile(process.env.CLA_PRESET_FIXTURE, 'utf8')), before = JSON.stringify(data);
    const byId = new Map(data.prompts.map(prompt => [prompt.identifier, prompt])), holder = data.prompt_order.find(group => group.order?.length), entries = holder.order.map(item => byId.get(item.identifier)).filter(Boolean);
    const state = emptyFolders(), parent = createFolder(state, '测试目录', null, uuid), child = createFolder(state, '测试子目录', parent, uuid);
    assignEntries(state, data.prompts, entries.slice(0, 8).map(prompt => prompt.identifier), child); state.collapsed.push(parent);
    assert.equal(folderTree(state, entries).flatMap(folder => folder.items).length, entries.length - 8);
    assert.ok(folderSuggestions(entries, state, 'boundaries').every(item => !Object.hasOwn(state.assignments, item.id)));
    deleteFolder(state, child); deleteFolder(state, parent);
    assert.equal(JSON.stringify(data), before);
    assert.deepEqual(entries.map(entry => entry.identifier), holder.order.filter(item => byId.has(item.identifier)).map(item => item.identifier));
});
