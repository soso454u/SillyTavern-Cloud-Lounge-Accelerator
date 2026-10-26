import test from 'node:test';
import assert from 'node:assert/strict';
import { RegexUiAdapter, moveOrderedItems } from '../modules/regex-ui-adapter.js';

function fixture(t) {
    const previous = globalThis.document;
    const data = Object.fromEntries(['GLOBAL','PRESET','SCOPED'].map(scope => [scope,
        ['a0','b0','a1','c0','a2','a3'].map(id => ({id,scriptName:`[${id[0].toUpperCase()}] ${id}`,findRegex:'/x/g',replaceString:id,disabled:id==='a1'}))]));
    const initial = structuredClone(data);
    const lists = Object.fromEntries(Object.entries({GLOBAL:'saved_regex_scripts',PRESET:'saved_preset_scripts',SCOPED:'saved_scoped_scripts'}).map(([scope,id]) => [id, {
        children:data[scope].map(script => ({id:script.id,matches:()=>true,dataset:{claRegexCollection:script.id[0].toUpperCase()},closest:()=>({id})})),
        append(row) { this.children.splice(this.children.indexOf(row),1); this.children.push(row); },
    }]));
    globalThis.document = {getElementById:id=>lists[id]};
    t.after(() => {if (previous===undefined) delete globalThis.document; else globalThis.document=previous;});
    let refreshes=0, changes=0, settingSaves=0, allows=0;
    const state={preset:'p1',gate:null,fail:false};
    const writes=[];
    const adapter=new RegexUiAdapter({extensionSettings:{},onSaved:()=>changes++});
    adapter.started=true;
    adapter.engine={SCRIPT_TYPES:{GLOBAL:'GLOBAL',PRESET:'PRESET',SCOPED:'SCOPED'},
        getScriptsByType:scope=>data[scope],
        saveScriptsByType:async(next,scope)=>{writes.push({next,scope});data[scope]=next;await state.gate;if(typeof state.fail==='function'?state.fail(writes.length):state.fail)throw new Error('failed write');},
        getCurrentPresetAPI:()=>'openai',getCurrentPresetName:()=>state.preset,
        allowScopedScripts:()=>allows++,allowPresetScripts:()=>allows++,
    };
    adapter.scriptApi={characters:[{avatar:'a.png'}],this_chid:0,saveSettingsDebounced:()=>settingSaves++};
    adapter.refreshOrganizerRows=()=>refreshes++;
    adapter.getRows=()=>Object.values(lists).flatMap(list=>list.children);
    const options=scope=>({scope,context:adapter.getCollectionContext(scope),collection:'A',sourceId:'a3',targetId:'a0',after:false});
    return {adapter,data,initial,lists,writes,state,options,
        get changes(){return changes;},get refreshes(){return refreshes;},get settingSaves(){return settingSaves;},get allows(){return allows;}};
}

test('moving a selected block preserves its own order and handles before/after and no-op drops',()=>{
    const ids=['a','b','c','d','e'];
    assert.deepEqual(moveOrderedItems(ids,['d','c'],'a'),['c','d','a','b','e']);
    assert.deepEqual(moveOrderedItems(ids,['a','b'],'d',true),['c','d','a','b','e']);
    assert.deepEqual(moveOrderedItems(ids,['b','c'],'b'),ids);
    assert.deepEqual(ids,['a','b','c','d','e']);
    assert.throws(()=>moveOrderedItems(ids,['missing'],'a'),/目标已变化/);
});

test('successive drops update the display immediately while older background writes remain pending',async t=>{
    const f=fixture(t);let release;
    f.state.gate=new Promise(resolve=>{release=resolve;});
    const first=f.adapter.previewRuleOrder({...f.options('PRESET'),sourceIds:['a3']});
    assert.deepEqual(f.lists.saved_preset_scripts.children.map(row=>row.id),['a3','b0','a0','c0','a1','a2']);
    assert.equal(f.writes.length,0);
    f.adapter.saveRulePreview(first);
    await Promise.resolve();
    const second=f.adapter.previewRuleOrder({...f.options('PRESET'),sourceIds:['a2'],targetId:'a3'});
    f.adapter.saveRulePreview(second);
    assert.deepEqual(f.lists.saved_preset_scripts.children.map(row=>row.id),['a2','b0','a3','c0','a0','a1']);
    assert.equal(f.writes.length,1);
    release();await f.adapter.saveQueue;
    assert.equal(f.writes.length,2);
    assert.deepEqual(f.data.PRESET.map(script=>script.id),['a2','b0','a3','c0','a0','a1']);
    assert.deepEqual(f.lists.saved_preset_scripts.children.map(row=>row.id),f.data.PRESET.map(script=>script.id));
    assert.equal(f.adapter.orderPreviews.size,0);
});

test('a failed background sort restores the original display and native definitions',async t=>{
    const f=fixture(t);f.state.fail=true;
    const preview=f.adapter.previewRuleOrder({...f.options('PRESET'),sourceIds:['a3']});
    await f.adapter.saveRulePreview(preview);
    assert.deepEqual(f.data.PRESET,f.initial.PRESET);
    assert.deepEqual(f.lists.saved_preset_scripts.children.map(row=>row.id),['a0','b0','a1','c0','a2','a3']);
    assert.equal(f.changes,0);
});

test('a newer queued drop can preserve its complete intended order after an earlier write fails',async t=>{
    const f=fixture(t);let release;
    f.state.fail=count=>count===1;
    f.state.gate=new Promise(resolve=>{release=resolve;});
    const first=f.adapter.previewRuleOrder({...f.options('PRESET'),sourceIds:['a3']});
    f.adapter.saveRulePreview(first);await Promise.resolve();
    const second=f.adapter.previewRuleOrder({...f.options('PRESET'),sourceIds:['a2'],targetId:'a3'});
    f.adapter.saveRulePreview(second);
    release();await f.adapter.saveQueue;
    assert.deepEqual(f.data.PRESET.map(script=>script.id),['a2','b0','a3','c0','a0','a1']);
    assert.deepEqual(f.lists.saved_preset_scripts.children.map(row=>row.id),f.data.PRESET.map(script=>script.id));
    assert.equal(f.changes,1);
});

test('rules not part of an optimistic preview retain their native group slots',async t=>{
    const f=fixture(t);
    await f.adapter.moveRuleWithinCollection({...f.options('PRESET'),desiredIds:['a3','a0','a1']});
    assert.deepEqual(f.data.PRESET.map(script=>script.id),['a3','b0','a0','c0','a2','a1']);
});

for(const scope of ['GLOBAL','PRESET','SCOPED']) test(`${scope} collection sorting writes native execution order once and preserves other collections' slots`,async t=>{
    const f=fixture(t),originalRefs=[...f.data[scope]];
    await f.adapter.moveRuleWithinCollection(f.options(scope));
    assert.deepEqual(f.data[scope].map(script=>script.id),['a3','b0','a0','c0','a1','a2']);
    assert.deepEqual(f.lists[{GLOBAL:'saved_regex_scripts',PRESET:'saved_preset_scripts',SCOPED:'saved_scoped_scripts'}[scope]].children.map(row=>row.id),['a3','b0','a0','c0','a1','a2']);
    assert.equal(f.data[scope][1],originalRefs[1]);
    assert.equal(f.data[scope][3],originalRefs[3]);
    for(const script of f.data[scope]) assert.deepEqual(script,f.initial[scope].find(item=>item.id===script.id));
    assert.equal(f.writes.length,1);
    assert.equal(f.changes,1);
    assert.equal(f.settingSaves,0);
    assert.equal(f.allows,0);
    assert.equal(f.adapter.reorderMode,false);
});

test('multiple selected rules reorder together in native order while preserving unselected rules',async t=>{
    const f=fixture(t);
    await f.adapter.moveRuleWithinCollection({...f.options('GLOBAL'),sourceIds:['a3','a2'],targetId:'a0'});
    assert.deepEqual(f.data.GLOBAL.map(script=>script.id),['a2','b0','a3','c0','a0','a1']);
    assert.equal(f.writes.length,1);
});

test('no-op drops and stale or cross-collection targets never save',async t=>{
    const f=fixture(t);
    await f.adapter.moveRuleWithinCollection({...f.options('GLOBAL'),sourceId:'a0'});
    await assert.rejects(f.adapter.moveRuleWithinCollection({...f.options('GLOBAL'),targetId:'b0'}),/目标已变化/);
    const stale=f.options('PRESET');f.state.preset='p2';
    await assert.rejects(f.adapter.moveRuleWithinCollection(stale),/已切换/);
    assert.equal(f.writes.length,0);
});

test('failed writes restore native order and keep the displayed order unchanged',async t=>{
    const f=fixture(t);f.state.fail=true;
    await assert.rejects(f.adapter.moveRuleWithinCollection(f.options('PRESET')),/failed write/);
    assert.deepEqual(f.data.PRESET,f.initial.PRESET);
    assert.deepEqual(f.lists.saved_preset_scripts.children.map(row=>row.id),['a0','b0','a1','c0','a2','a3']);
    assert.equal(f.changes,0);assert.equal(f.refreshes,0);
});

test('a rejected background write restores its original preset after the user switches presets',async t=>{
    const f=fixture(t);let release;
    const presets={p1:[...f.data.PRESET],p2:[{id:'other-preset',scriptName:'[A] other'}]};
    const original=structuredClone(presets);
    f.adapter.engine.getScriptsByType=scope=>scope==='PRESET'?presets[f.state.preset]:f.data[scope];
    f.adapter.engine.saveScriptsByType=async next=>{presets[f.state.preset]=next;await new Promise(resolve=>{release=resolve;});throw new Error('rejected');};
    const pending=f.adapter.moveRuleWithinCollection(f.options('PRESET'));
    f.state.preset='p2';release();
    await assert.rejects(pending,/rejected/);
    assert.deepEqual(presets,original);
});

test('a newer external order is retained when an earlier save finishes',async t=>{
    const f=fixture(t);let release;
    f.state.gate=new Promise(resolve=>{release=resolve;});
    const pending=f.adapter.moveRuleWithinCollection(f.options('PRESET'));
    f.data.PRESET=[...f.data.PRESET].reverse();
    const newer=f.data.PRESET.map(script=>script.id);
    release();await pending;
    assert.deepEqual(f.data.PRESET.map(script=>script.id),newer);
    assert.deepEqual(f.lists.saved_preset_scripts.children.map(row=>row.id),newer);
});

for(const action of ['context','restart']) test(`pending sorting waits for acknowledgement and cannot refresh a ${action} changed view`,async t=>{
    const f=fixture(t);let release;
    f.state.gate=new Promise(resolve=>{release=resolve;});
    const pending=f.adapter.moveRuleWithinCollection(f.options('PRESET'));
    assert.deepEqual(f.lists.saved_preset_scripts.children.map(row=>row.id),['a0','b0','a1','c0','a2','a3']);
    if(action==='context')f.state.preset='p2';else f.adapter.generation++;
    release();await pending;
    assert.equal(f.changes,0);assert.equal(f.refreshes,0);
    assert.deepEqual(f.lists.saved_preset_scripts.children.map(row=>row.id),['a0','b0','a1','c0','a2','a3']);
});

test('collection title sorting persists only display order, including empty groups and renaming',t=>{
    const f=fixture(t),scope='GLOBAL';
    f.adapter.createCollection(scope,'空组');
    f.adapter.collectionGroups=['A','B','C','空组'].map(collection=>({scope,collection}));
    f.adapter.moveCollection(scope,'空组','A',false,f.adapter.getCollectionContext(scope));
    assert.deepEqual(f.adapter.getCollectionState(scope).order,['空组','A','B','C']);
    const reloaded=new RegexUiAdapter({extensionSettings:JSON.parse(JSON.stringify(f.adapter.extensionSettings))});
    assert.deepEqual(reloaded.getOrderedCollections(scope,['A','B','C','空组','新组']),['空组','A','B','C','新组']);
    f.adapter.renameCollection(scope,'空组','手机');
    assert.deepEqual(f.adapter.getCollectionState(scope).order,['手机','A','B','C']);
    assert.deepEqual(f.adapter.getCollectionState('PRESET').order,[]);
    assert.deepEqual(f.data,f.initial);
    assert.equal(f.writes.length,0);
    const saves=f.settingSaves;
    assert.throws(()=>f.adapter.moveCollection(scope,'A','B',false,'stale'),/已切换/);
    assert.equal(f.settingSaves,saves);
});
