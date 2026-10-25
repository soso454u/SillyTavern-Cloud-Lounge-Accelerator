import test from 'node:test';
import assert from 'node:assert/strict';
import { RegexUiAdapter } from '../modules/regex-ui-adapter.js';

function fixture(t) {
    const oldDocument = globalThis.document;
    const types = { GLOBAL: 0, SCOPED: 1, PRESET: 2 };
    const data = Object.fromEntries(Object.keys(types).map(scope => [scope, Array.from({length:30}, (_,i) => ({
        id:`${scope}-${i}`, scriptName:`rule-${i}`, findRegex:'a', replaceString:'b', trimStrings:[], placement:[2],
        disabled:false, markdownOnly:true, promptOnly:false, runOnEdit:true, substituteRegex:0, minDepth:null, maxDepth:null,
    }))]));
    const calls = [], order = [];
    let gate = null, failScope = null, refreshes = 0, closes = 0, fullSaves = 0;
    const adapter = new RegexUiAdapter({ onSaved:() => { refreshes++; order.push('refresh'); } });
    adapter.started = true;
    adapter.engine = {
        SCRIPT_TYPES:types,
        getScriptsByType:type => data[Object.keys(types).find(scope => types[scope]===type)],
        async saveScriptsByType(next,type) {
            const scope=Object.keys(types).find(scope=>types[scope]===type);
            calls.push({scope,next});data[scope]=next;
            await gate;
            if(scope===failScope)throw new Error('server rejected write');
        },
        getCurrentPresetAPI:()=>'openai', getCurrentPresetName:()=>'preset-A',
        allowScopedScripts:()=>order.push('allow'), allowPresetScripts:()=>order.push('allow'),
        RegexProvider:{instance:{clear:()=>order.push('clear')}},
    };
    adapter.scriptApi={characters:[{avatar:'a.png'}],this_chid:0,saveSettingsDebounced:()=>fullSaves++};
    adapter.scheduleOrganizerRefresh=()=>order.push('organizer');
    const rows=[];
    function row(scope,id) {
        const label={id,removed:false,closest:()=>({id:{GLOBAL:'saved_regex_scripts',SCOPED:'saved_scoped_scripts',PRESET:'saved_preset_scripts'}[scope]}),
            remove(){this.removed=true;},querySelector:()=>({textContent:'',title:''})};
        rows.push(label);return label;
    }
    const popup={completeCancelled:async()=>{closes++;order.push('close');}};
    globalThis.document={getElementById:()=>({querySelector:()=>({})})};
    t.after(()=>{if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;});
    function editor(draft) {
        const values={'.regex_script_name':'scriptName','.find_regex':'findRegex','.regex_replace_string':'replaceString',
            'select[name="substitute_regex"]':'substituteRegex','input[name="min_depth"]':'minDepth','input[name="max_depth"]':'maxDepth'};
        const checks={disabled:'disabled',only_format_display:'markdownOnly',only_format_prompt:'promptOnly',run_on_edit:'runOnEdit'};
        return {querySelectorAll:()=>draft.placement.map(value=>({value})),querySelector:selector=>{
            if(selector==='.regex_trim_strings')return {value:draft.trimStrings.join('\n')};
            if(values[selector])return {value:draft[values[selector]]??''};
            const key=selector.match(/^input\[name="(.+)"\]$/)?.[1];
            return key&&checks[key]?{checked:draft[checks[key]]}:null;
        }};
    }
    return {adapter,data,calls,order,row,rows,popup,editor,
        context:scope=>({id:`${scope}-0`,typeKey:scope,scopeKey:adapter.getCollectionContext(scope)}),
        contexts:()=>new Map(Object.keys(types).map(scope=>[scope,adapter.getCollectionContext(scope)])),
        set gate(value){gate=value;},set failScope(value){failScope=value;},
        get refreshes(){return refreshes;},get closes(){return closes;},get fullSaves(){return fullSaves;},
    };
}

test('sixty selected rules across three scopes require three writes and one chat refresh', async t=>{
    const f=fixture(t);
    const labels=Object.keys(f.data).flatMap(scope=>f.data[scope].slice(0,20).map(script=>f.row(scope,script.id)));
    const remaining=Object.fromEntries(Object.entries(f.data).map(([scope,scripts])=>[scope,structuredClone(scripts.slice(20))]));
    await f.adapter.saveDelete(labels,f.contexts());
    assert.equal(f.calls.length,3);
    assert.deepEqual(f.data,remaining);
    assert.ok(labels.every(row=>row.removed));
    assert.equal(f.refreshes,1);
    assert.equal(f.fullSaves,0);
    assert.equal(f.order.includes('allow'),false);
    assert.equal(f.order.includes('clear'),false,'native patterns are keyed by their full source and stay reusable');
});

test('pending deletion keeps rows until the native write resolves',async t=>{
    const f=fixture(t);let release;
    f.gate=new Promise(resolve=>{release=resolve;});
    const row=f.row('PRESET','PRESET-0');
    const pending=f.adapter.saveDelete([row],f.contexts());
    assert.equal(row.removed,false);
    assert.equal(f.refreshes,0);
    release();await pending;
    assert.equal(row.removed,true);
});

test('failed scoped deletion preserves rows, restores its native array and reports partial success',async t=>{
    const f=fixture(t);f.failScope='PRESET';
    const original=structuredClone(f.data.PRESET);
    const global=f.row('GLOBAL','GLOBAL-0'),preset=f.row('PRESET','PRESET-0');
    await assert.rejects(f.adapter.saveDelete([global,preset],f.contexts()),/已删除 1 条/);
    assert.equal(global.removed,true);assert.equal(preset.removed,false);
    assert.deepEqual(f.data.PRESET,original);
    assert.equal(f.refreshes,1);
});

test('stale scope context refuses writes instead of deleting from a different preset',async t=>{
    const f=fixture(t),contexts=f.contexts();
    f.adapter.engine.getCurrentPresetName=()=>'preset-B';
    await assert.rejects(f.adapter.saveDelete([f.row('PRESET','PRESET-0')],contexts),/已切换/);
    assert.equal(f.calls.length,0);
});

test('unchanged editor closes without saving or refreshing chat',async t=>{
    const f=fixture(t),context=f.context('GLOBAL');
    const draft=structuredClone(f.data.GLOBAL[0]);
    await f.adapter.saveExistingEditor({popupInstance:f.popup,editor:f.editor(draft),context,draft});
    assert.equal(f.calls.length,0);assert.equal(f.closes,1);assert.equal(f.refreshes,0);
});

test('edited draft uses native persistence and starts closing before scheduling the chat refresh',async t=>{
    const f=fixture(t),context=f.context('PRESET');
    const draft={...f.data.PRESET[0],replaceString:'updated'};
    await f.adapter.saveExistingEditor({popupInstance:f.popup,editor:f.editor(draft),context,draft});
    assert.equal(f.calls.length,1);assert.equal(f.data.PRESET[0].replaceString,'updated');
    assert.ok(f.order.indexOf('close')<f.order.indexOf('refresh'));
    assert.equal(f.fullSaves,0);
});

test('failed editor save does not close and restores only its own native in-memory write',async t=>{
    const f=fixture(t),context=f.context('PRESET');f.failScope='PRESET';
    const before=structuredClone(f.data.PRESET);
    await assert.rejects(f.adapter.saveExistingEditor({popupInstance:f.popup,editor:{},context,draft:{...before[0],replaceString:'bad'}}),/server rejected/);
    assert.equal(f.closes,0);assert.equal(f.refreshes,0);assert.deepEqual(f.data.PRESET,before);
});

test('queued operations cancelled by a lifecycle change cannot start native writes',async t=>{
    const f=fixture(t);let release;
    const gate=new Promise(resolve=>{release=resolve;});
    f.adapter.enqueue(()=>gate);
    let called=false;f.adapter.enqueue(()=>{called=true;});
    await Promise.resolve();f.adapter.started=false;f.adapter.generation++;
    release();await f.adapter.saveQueue;
    assert.equal(called,false);
});

test('typing a newer draft during persistence keeps the editor open instead of losing it',async t=>{
    const f=fixture(t),context=f.context('PRESET');let release;
    const draft={...f.data.PRESET[0],replaceString:'first save'};
    const live={...draft};f.gate=new Promise(resolve=>{release=resolve;});
    const pending=f.adapter.saveExistingEditor({popupInstance:f.popup,editor:f.editor(live),context,draft});
    live.replaceString='new typing';release();await pending;
    assert.equal(f.data.PRESET[0].replaceString,'first save');
    assert.equal(f.closes,0);assert.equal(f.refreshes,1);
});
