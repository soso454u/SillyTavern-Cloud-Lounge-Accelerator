import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getRegexCollectionName,
    getRegexCollectionKey,
    matchesRegexOrganizerFilter,
    normalizeRegexCollectionName,
    RegexUiAdapter,
    shouldShowRegexOrganizerRow,
} from '../modules/regex-ui-adapter.js';

const LIST_SELECTOR = '#saved_regex_scripts, #saved_scoped_scripts, #saved_preset_scripts';

test('groups bracket-prefixed regex names into organizer collections', () => {
    assert.equal(getRegexCollectionName('[月下美化]思维链：蓝色'), '月下美化');
    assert.equal(getRegexCollectionName('【剧情工具】状态栏'), '剧情工具');
    assert.equal(getRegexCollectionName('「播放器」隐藏播放器文字'), '播放器');
    assert.equal(getRegexCollectionName('『播放器』不发送提示词'), '播放器');
    assert.equal(getRegexCollectionName('普通正则'), '未分类');
});

function collectionFixture(settings = {}) {
    const scripts = {
        GLOBAL: [{ id:'a', scriptName:'[旧组]正则 A', findRegex:'a', replaceString:'A', disabled:true }, { id:'b', scriptName:'普通规则', placement:[1,2] }],
        PRESET: [{ id:'a', scriptName:'[旧组]预设正则' }],
        SCOPED: [{ id:'a', scriptName:'[旧组]角色正则' }],
    };
    const original = structuredClone(scripts);
    let saves = 0, refreshes = 0;
    const current = { preset:'预设 A', api:'openai' };
    const adapter = new RegexUiAdapter({ extensionSettings:settings, onSaved:() => assert.fail('classification must not refresh chat') });
    adapter.engine = {
        SCRIPT_TYPES:{ GLOBAL:'GLOBAL', PRESET:'PRESET', SCOPED:'SCOPED' },
        getScriptsByType:scope => scripts[scope],
        saveScriptsByType:() => assert.fail('classification must not rewrite native scripts'),
        getCurrentPresetAPI:() => current.api,
        getCurrentPresetName:() => current.preset,
    };
    adapter.scriptApi = { characters:[{ avatar:'a.png' },{ avatar:'b.png' }], this_chid:0, saveSettingsDebounced:() => saves++ };
    adapter.refreshOrganizerRows = () => refreshes++;
    adapter.getRows = () => [];
    function row(scope, id, checked=true) {
        return { id, closest:() => ({id:{ GLOBAL:'saved_regex_scripts', PRESET:'saved_preset_scripts', SCOPED:'saved_scoped_scripts' }[scope]}),
            querySelector:() => ({checked}) };
    }
    return { adapter, scripts, original, settings, current, row, get saves() { return saves; }, get refreshes() { return refreshes; } };
}

test('creates persistent empty collections and rejects duplicate or reserved names', () => {
    const f = collectionFixture();
    f.adapter.createCollection('GLOBAL','  自建空组  ');
    assert.deepEqual(f.adapter.getCollectionState('GLOBAL').groups,['自建空组']);
    const reload = collectionFixture(JSON.parse(JSON.stringify(f.settings)));
    assert.deepEqual(reload.adapter.getCollectionState('GLOBAL').groups,['自建空组']);
    assert.throws(() => f.adapter.createCollection('GLOBAL','自建空组'),/同名/);
    for (const name of ['', ' ', '未分类', 'all', 'a\nb', 'x'.repeat(61)]) assert.throws(() => normalizeRegexCollectionName(name));
    assert.equal(normalizeRegexCollectionName('<分组> "自定义"'),'<分组> "自定义"');
    assert.equal(f.saves,1);
});

test('renames inferred collections without changing native names, content, permissions or order', () => {
    const f = collectionFixture();
    f.adapter.renameCollection('GLOBAL','旧组','新组');
    assert.equal(f.adapter.getAssignedCollection('GLOBAL','a','[旧组]正则 A'),'新组');
    assert.equal(f.adapter.getAssignedCollection('PRESET','a','[旧组]预设正则'),'旧组');
    assert.equal(f.adapter.getAssignedCollection('GLOBAL','b','普通规则'),'未分类');
    assert.deepEqual(f.scripts,f.original);
    assert.equal(f.saves,1);
    assert.equal(f.refreshes,1);
});

test('renames empty and unclassified collections and rejects collisions without partial writes', () => {
    const f = collectionFixture();
    f.adapter.createCollection('GLOBAL','空组');
    f.adapter.renameCollection('GLOBAL','空组','空组新名');
    assert.deepEqual(f.adapter.getCollectionState('GLOBAL').groups,['空组新名']);
    f.adapter.renameCollection('GLOBAL','未分类','其他工具');
    assert.equal(f.adapter.getAssignedCollection('GLOBAL','b','普通规则'),'其他工具');
    const before = JSON.stringify(f.settings);
    assert.throws(() => f.adapter.renameCollection('GLOBAL','旧组','其他工具'),/同名/);
    assert.equal(JSON.stringify(f.settings),before);
});

test('separates catalogs by API/preset name and stable character avatar rather than array index', () => {
    const f = collectionFixture();
    f.adapter.createCollection('PRESET','预设 A 分组');
    f.current.preset='预设 B';
    assert.deepEqual(f.adapter.getCollectionState('PRESET').groups,[]);
    f.current.preset='预设 A';
    f.current.api='kobold';
    assert.deepEqual(f.adapter.getCollectionState('PRESET').groups,[]);
    f.current.api='openai';
    assert.deepEqual(f.adapter.getCollectionState('PRESET').groups,['预设 A 分组']);
    f.adapter.createCollection('SCOPED','角色 A 分组');
    f.adapter.scriptApi.this_chid=1;
    assert.deepEqual(f.adapter.getCollectionState('SCOPED').groups,[]);
    f.adapter.scriptApi.characters.reverse();
    assert.deepEqual(f.adapter.getCollectionState('SCOPED').groups,['角色 A 分组']);
    assert.deepEqual(f.adapter.getCollectionState('GLOBAL').groups,[]);
});

test('moves checked rules across independent scopes and can override prefixes with unclassified', () => {
    const f = collectionFixture();
    f.adapter.getRows=() => [f.row('GLOBAL','a'),f.row('GLOBAL','b',false),f.row('PRESET','a')];
    f.adapter.moveSelectedToCollection('自建分组');
    for (const scope of ['GLOBAL','PRESET']) assert.equal(f.adapter.getAssignedCollection(scope,'a','[旧组]x'),'自建分组');
    assert.equal(f.adapter.getAssignedCollection('GLOBAL','b','普通规则'),'未分类');
    assert.equal(f.adapter.getAssignedCollection('SCOPED','a','[旧组]x'),'旧组');
    f.adapter.moveSelectedToCollection('未分类');
    assert.equal(f.adapter.getAssignedCollection('GLOBAL','a','[旧组]x'),'未分类');
    assert.deepEqual(f.scripts,f.original);
    assert.equal(f.saves,2,'one settings save for each bulk action');
});

test('invalid selections or missing scope contexts cannot partially save a group move', () => {
    const f = collectionFixture();
    assert.throws(() => f.adapter.moveSelectedToCollection('目标'),/先勾选/);
    f.adapter.getRows=() => [f.row('GLOBAL','a'),f.row('PRESET','missing')];
    assert.throws(() => f.adapter.moveSelectedToCollection('目标'),/列表已变化/);
    assert.deepEqual(f.settings,{});
    f.current.preset=null;
    assert.throws(() => f.adapter.createCollection('PRESET','新组'),/选择/);
    f.adapter.scriptApi.this_chid=undefined;
    assert.throws(() => f.adapter.createCollection('SCOPED','新组'),/选择/);
    assert.equal(f.saves,0);
});

test('untrusted rule IDs are stored as own data keys and never change object prototypes', () => {
    const f = collectionFixture();
    f.scripts.GLOBAL[0].id='__proto__';
    f.adapter.getRows=() => [f.row('GLOBAL','__proto__')];
    f.adapter.moveSelectedToCollection('安全分组');
    const assignments=f.adapter.getCollectionState('GLOBAL').assignments;
    assert.equal(Object.getPrototypeOf(assignments),Object.prototype);
    assert.equal(Object.hasOwn(assignments,'__proto__'),true);
    assert.equal(f.adapter.getAssignedCollection('GLOBAL','__proto__','[旧组]x'),'安全分组');
});

test('filters regex collections by name, scope, and search text', () => {
    const row = { name: '[月下美化]思维链：蓝色', collection: '月下美化', scope: 'PRESET' };
    assert.equal(matchesRegexOrganizerFilter({ ...row, selectedCollection: '月下美化', selectedScope: 'PRESET', query: '蓝色' }), true);
    assert.equal(matchesRegexOrganizerFilter({ ...row, selectedCollection: '月下美化', selectedScope: 'GLOBAL', query: '' }), false);
    assert.equal(matchesRegexOrganizerFilter({ ...row, selectedCollection: 'all', selectedScope: 'all', query: '黑色' }), false);
});

test('shows only expanded collections when automatic folding is enabled', () => {
    const row = { name: '[月下美化]思维链', collection: '月下美化', scope: 'PRESET' };
    assert.equal(shouldShowRegexOrganizerRow({
        ...row,
        selectedCollection: 'all',
        selectedScope: 'all',
        autoCollapse: true,
        openCollections: new Set(),
    }), false);
    assert.equal(shouldShowRegexOrganizerRow({
        ...row,
        selectedCollection: 'all',
        selectedScope: 'all',
        autoCollapse: true,
        openCollections: new Set([getRegexCollectionKey('PRESET', '月下美化')]),
    }), true);
    assert.equal(shouldShowRegexOrganizerRow({
        ...row,
        selectedCollection: 'all',
        selectedScope: 'all',
        autoCollapse: false,
    }), true);
});

test('keeps same-name and unclassified collections independent across regex scopes', () => {
    for (const collection of ['未分类', '月下美化']) {
        const scopes = ['GLOBAL', 'PRESET', 'SCOPED'];
        const adapter = new RegexUiAdapter();
        if (collection === '未分类') {
            for (const scope of scopes) {
                assert.equal(shouldShowRegexOrganizerRow({ collection, scope, autoCollapse: true, openCollections: adapter.openCollections }), true);
            }
        }
        for (const openScope of scopes) {
            const openCollections = new Set([getRegexCollectionKey(openScope, collection)]);
            for (const scope of scopes) {
                assert.equal(shouldShowRegexOrganizerRow({ collection, scope, autoCollapse: true, openCollections }), scope === openScope);
            }
        }
    }
});

function fixture(t, { typeKey = 'PRESET', scopeOnly = false, known = true, disabled = true } = {}) {
    class Element {
        closest(selector) { return this.matchesBySelector?.[selector] || null; }
    }
    class Input extends Element {
        matches(selector) { return selector === '.disable_regex' && !scopeOnly; }
    }
    const originals = { Element: globalThis.Element, HTMLInputElement: globalThis.HTMLInputElement };
    globalThis.Element = Element;
    globalThis.HTMLInputElement = Input;
    t.after(() => {
        for (const [name, value] of Object.entries(originals)) {
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
        }
    });
    const list = { id: { GLOBAL: 'saved_regex_scripts', SCOPED: 'saved_scoped_scripts', PRESET: 'saved_preset_scripts' }[typeKey] };
    const checkbox = new Input();
    checkbox.checked = disabled;
    const label = new Element();
    label.id = 'imported-regex';
    label.querySelector = selector => selector === '.disable_regex' ? checkbox : null;
    const icon = new Element();
    icon.classList = { contains: name => name === (disabled ? 'regex-toggle-off' : 'regex-toggle-on') };
    for (const element of [icon, checkbox, label]) {
        element.matchesBySelector = {
            '.regex-script-label[id]': scopeOnly ? null : label,
            [LIST_SELECTOR]: scopeOnly ? null : list,
        };
    }
    icon.matchesBySelector['.regex-toggle-on, .regex-toggle-off'] = icon;
    let scripts = known ? [{ id: label.id, disabled }] : [];
    const saved = [];
    let notifications = 0;
    const adapter = new RegexUiAdapter({ onSaved: () => { notifications += 1; } });
    adapter.started = true;
    adapter.popupApi = {};
    adapter.scriptApi = {};
    adapter.engine = {
        SCRIPT_TYPES: { GLOBAL: 0, SCOPED: 1, PRESET: 2 },
        getScriptsByType: () => scripts,
        saveScriptsByType: async (next, type) => { scripts = next; saved.push({ next, type }); },
    };
    function event(target) {
        return {
            target, prevented: false, stopped: false,
            preventDefault() { this.prevented = true; },
            stopImmediatePropagation() { this.stopped = true; },
        };
    }
    return { adapter, icon, checkbox, event, saved, notifications: () => notifications };
}

for (const typeKey of ['PRESET', 'SCOPED']) {
    for (const disabled of [true, false]) {
        test(`${typeKey} permission icon (${disabled ? 'off' : 'on'}) retains native label activation`, async t => {
            const f = fixture(t, { typeKey, scopeOnly: true, disabled });
            const click = f.event(f.icon);
            f.adapter.onClick(click);
            assert.equal(click.prevented, false);
            assert.equal(click.stopped, false);
            const input = f.event(f.checkbox);
            f.adapter.onInput(input);
            assert.equal(input.stopped, false);
            await f.adapter.saveQueue;
            assert.equal(f.saved.length, 0);
        });
    }
}

for (const typeKey of ['GLOBAL', 'SCOPED', 'PRESET']) {
    test(`${typeKey} individual script can be enabled and disabled with optimization active`, async t => {
        const f = fixture(t, { typeKey });
        const click = f.event(f.icon);
        f.adapter.onClick(click);
        await f.adapter.saveQueue;
        assert.equal(click.prevented, true);
        assert.equal(click.stopped, true);
        assert.equal(f.checkbox.checked, false);
        assert.equal(f.saved[0].next[0].disabled, false);
        assert.equal(f.saved[0].type, f.adapter.engine.SCRIPT_TYPES[typeKey]);
        f.icon.classList.contains = name => name === 'regex-toggle-on';
        f.adapter.onClick(f.event(f.icon));
        await f.adapter.saveQueue;
        assert.equal(f.checkbox.checked, true);
        assert.equal(f.saved[1].next[0].disabled, true);
        assert.equal(f.notifications(), 2);
    });
}

test('unknown script rows fall through without swallowing clicks or input', async t => {
    const f = fixture(t, { known: false });
    const click = f.event(f.icon);
    f.adapter.onClick(click);
    const input = f.event(f.checkbox);
    f.adapter.onInput(input);
    assert.equal(click.prevented, false);
    assert.equal(click.stopped, false);
    assert.equal(input.stopped, false);
    await f.adapter.saveQueue;
    assert.equal(f.saved.length, 0);
});

test('queued checkbox changes preserve each input event value', async t => {
    const f = fixture(t);
    f.checkbox.checked = false;
    f.adapter.onInput(f.event(f.checkbox));
    f.checkbox.checked = true;
    f.adapter.onInput(f.event(f.checkbox));
    await f.adapter.saveQueue;
    assert.deepEqual(f.saved.map(call => call.next[0].disabled), [false, true]);
});
