import test from 'node:test';
import assert from 'node:assert/strict';
import { ContentTransferService, NativeTransferRepository } from '../modules/content-transfer.js';
import { RegexUiAdapter } from '../modules/regex-ui-adapter.js';

const scopes = ['GLOBAL', 'PRESET', 'SCOPED'];

function setup(t) {
    const restoreWindow = globalThis.window;
    t.after(() => {
        if (restoreWindow) globalThis.window = restoreWindow;
        else delete globalThis.window;
    });
    const rules = Object.fromEntries(scopes.map(scope => [scope, [
        { id: `${scope}-one`, scriptName: '[原组]一', placement: [2], trimStrings: ['x'], disabled: true },
        { id: `${scope}-two`, scriptName: '[原组]二', placement: [1], findRegex: '/test/g' },
        { id: `${scope}-stay`, scriptName: '[保留]原件' },
    ]]));
    const extensionSettings = { regex: rules.GLOBAL };
    const writes = [];
    const state = { fail: null, preset: 'P', overlap: false };
    const nativeFetch = async () => {
        writes.push('GLOBAL');
        if (state.fail === 'GLOBAL') return Response.json({ error: 'save failed' });
        rules.GLOBAL = structuredClone(extensionSettings.regex);
        return Response.json({ result: 'ok' });
    };
    globalThis.window = { fetch: nativeFetch };
    const character = { avatar: 'a.png', data: { extensions: { regex_scripts: rules.SCOPED } } };
    const scriptApi = {
        this_chid: 0, characters: [character], settingsReady: true, getRequestHeaders: () => ({}),
        saveSettings: async () => {
            await window.fetch('/api/settings/save', { method: 'POST' });
            if (state.overlap) await window.fetch('/api/settings/save', { method: 'POST' });
        },
    };
    const preset = { extensions: { regex_scripts: rules.PRESET } };
    const manager = {
        getAllPresets: () => ['P'], getCompletionPresetByName: () => preset,
        getPresetList: () => ({}), getSelectedPresetName: () => state.preset,
        readPresetExtensionField: () => rules.PRESET,
        writePresetExtensionField: async ({ value }) => {
            writes.push('PRESET');
            if (state.fail === 'PRESET') throw new Error('preset save failed');
            rules.PRESET = value;
        },
    };
    const fetchImpl = async (url, { body }) => {
        if (url === '/api/characters/get') return Response.json({ data: { extensions: { regex_scripts: rules.SCOPED } } });
        assert.equal(url, '/api/characters/merge-attributes');
        writes.push('SCOPED');
        if (state.fail === 'SCOPED') return new Response(null, { status: 500 });
        rules.SCOPED = JSON.parse(body).data.extensions.regex_scripts;
        return Response.json({ ok: true });
    };
    const repository = new NativeTransferRepository({
        scriptApi, extensionSettings, verifyCurrentCharacter: true,
        presetApi: { getPresetManager: api => api === 'openai' ? manager : null }, fetchImpl,
    });
    const adapter = new RegexUiAdapter({ extensionSettings });
    adapter.started = true;
    adapter.scriptApi = scriptApi;
    adapter.engine = { getCurrentPresetAPI: () => 'openai', getCurrentPresetName: () => state.preset };
    let sequence = 0;
    adapter.loadScopeMove = async () => ({
        service: new ContentTransferService(repository), uuidv4: () => `new-${++sequence}`,
    });
    const applied = [];
    adapter.refreshMovedRules = (...args) => applied.push(args);
    const move = (sourceScope, targetScope, options) => adapter.moveRulesAcrossScopes({
        sourceScope, sourceKey: adapter.getCollectionContext(sourceScope),
        targetScope, targetKey: adapter.getCollectionContext(targetScope), ...options,
    });
    return { adapter, move, rules, writes, state, extensionSettings, nativeFetch, applied, character };
}

for (const source of scopes) for (const target of scopes.filter(scope => scope !== source)) {
    test(`moves a whole collection from ${source} to ${target} in native order`, async t => {
        const f = setup(t);
        const original = structuredClone(f.rules[source]);
        const existing = structuredClone(f.rules[target]);
        f.adapter.saveCollectionState(source, {
            groups: ['手动合集'], order: ['手动合集'],
            assignments: { [original[0].id]: '手动合集', [original[1].id]: '手动合集' },
        });
        await f.move(source, target, { ids: [], collection: '手动合集', targetCollection: '其他分组' });
        assert.deepEqual(f.writes, [target, source]);
        assert.deepEqual(f.rules[source], [original[2]]);
        assert.deepEqual(f.rules[target], [...existing, { ...original[0], id: 'new-1' }, { ...original[1], id: 'new-2' }]);
        assert.equal(f.adapter.getAssignedCollection(target, 'new-1', original[0].scriptName), '手动合集');
        assert.deepEqual(f.adapter.getCollectionState(source), { groups: [], assignments: {}, order: [] });
        assert.deepEqual(f.applied, [[source, target, original.slice(0, 2), ['new-1', 'new-2'], true]]);
        assert.equal(window.fetch, f.nativeFetch);
    });
}

test('single and multi-rule drops can use a destination group without moving the source group', async t => {
    const f = setup(t);
    await f.move('PRESET', 'SCOPED', { ids: ['PRESET-one'], targetCollection: '角色合集' });
    await f.move('SCOPED', 'GLOBAL', { ids: ['SCOPED-two', 'SCOPED-one'], targetCollection: '合集' });
    assert.deepEqual(f.rules.SCOPED.map(rule => rule.id), ['SCOPED-stay', 'new-1']);
    assert.equal(f.adapter.getAssignedCollection('SCOPED', 'new-1', '[原组]一'), '角色合集');
    assert.deepEqual(f.rules.GLOBAL.slice(-2).map(rule => rule.scriptName), ['[原组]一', '[原组]二']);
    assert.equal(f.adapter.getAssignedCollection('GLOBAL', 'new-3', '[原组]二'), '合集');
});

test('a failed global acknowledgement leaves the source and in-memory global rules intact', async t => {
    const f = setup(t);
    const original = structuredClone(f.rules);
    f.state.fail = 'GLOBAL';
    await assert.rejects(f.move('SCOPED', 'GLOBAL', { ids: ['SCOPED-one'] }), /未确认/);
    assert.deepEqual(f.writes, ['GLOBAL']);
    assert.deepEqual(f.rules, original);
    assert.deepEqual(f.extensionSettings.regex, original.GLOBAL);
    assert.equal(window.fetch, f.nativeFetch);
});

test('overlapping global saves do not authorize source removal', async t => {
    const f = setup(t);
    f.state.overlap = true;
    await assert.rejects(f.move('SCOPED', 'GLOBAL', { ids: ['SCOPED-one'] }), /未确认/);
    assert.deepEqual(f.writes, ['GLOBAL', 'GLOBAL']);
    assert.equal(f.rules.SCOPED.length, 3);
});

test('failure removing the source preserves the confirmed copy and its group', async t => {
    const f = setup(t);
    f.state.fail = 'SCOPED';
    await assert.rejects(f.move('SCOPED', 'PRESET', { ids: ['SCOPED-one'], targetCollection: '目标合集' }), /来源原件保留/);
    assert.deepEqual(f.writes, ['PRESET', 'SCOPED']);
    assert.equal(f.rules.SCOPED.length, 3);
    assert.equal(f.rules.PRESET.at(-1).id, 'new-1');
    assert.equal(f.adapter.getAssignedCollection('PRESET', 'new-1', '[原组]一'), '目标合集');
});

test('unsaved character changes keep the live data from being overwritten', async t => {
    const f = setup(t);
    f.character.data.extensions.regex_scripts = [{ id: 'unsaved', scriptName: '尚未同步' }];
    await assert.rejects(f.move('GLOBAL', 'SCOPED', { ids: ['GLOBAL-one'] }), /保存前发生变化/);
    assert.deepEqual(f.writes, []);
    assert.equal(f.rules.GLOBAL.length, 3);
});
