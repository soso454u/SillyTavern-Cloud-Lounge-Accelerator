import test from 'node:test';
import assert from 'node:assert/strict';
import { ContentTransferService, NativeTransferRepository, planTransfer, editTransferEntry, transferCollection } from '../modules/content-transfer.js';
const clone = value => structuredClone(value);
const rule = (id, extra = {}) => ({ id, scriptName: '同名规则', findRegex: '/abc/g', replaceString: '<div>$1</div>', disabled: true, placement: [1,2], trimStrings:['x'], minDepth:2, maxDepth:8, runOnEdit:true, markdownOnly:true, unknown:{future:true}, ...extra });

test('world copies preserve all content/settings and metadata, allocate independent UIDs and append order', () => {
    const source = { entries:{0:{uid:0,comment:'世界设定',content:'正文',key:['甲'],keysecondary:['乙'],disable:true,position:4,depth:8,order:77,vectorized:true,unknown:{x:1}}}, originalData:{entries:[{uid:0,text:'原始正文',unknown:2}]}, extensions:{keep:true} };
    const target = { entries:{0:{uid:0,content:'已有内容',displayIndex:4}}, originalData:{entries:[]}, extensions:{target:true} };
    const before = clone([source,target]);
    const p=planTransfer('world',source,target,['0']);
    assert.deepEqual([source,target],before);
    assert.deepEqual(p.nextTarget.entries[1],{...source.entries[0],uid:1,displayIndex:5});
    assert.equal(p.nextTarget.entries[0].content,'已有内容');
    assert.equal(p.nextTarget.originalData.entries[0].uid,1);
    assert.deepEqual(p.nextSource.entries,{}); assert.deepEqual(p.nextSource.originalData.entries,[]);
    assert.deepEqual(p.nextTarget.extensions,{target:true});
});
for(const kind of ['character','preset']) test(`${kind} copies preserve every regex option, keep same-name rules and use new IDs`,()=>{
    const source=[rule('a'),rule('b')],target=[rule('a',{findRegex:'/different/'})];
    const p=planTransfer(kind,source,target,['a'],()=> 'new-id');
    assert.deepEqual(p.nextTarget,[...target,{...source[0],id:'new-id'}]);
    assert.deepEqual(p.nextSource,[source[1]]);assert.equal(source.length,2);assert.equal(target.length,1);
    p.nextTarget[1].unknown.future=false;assert.equal(source[0].unknown.future,true);
});
test('empty, disappeared, duplicate IDs and a duplicate generated ID are rejected',()=>{
    for(const ids of [[],['missing']])assert.throws(()=>planTransfer('preset',[rule('a')],[],ids));
    assert.throws(()=>planTransfer('preset',[rule('a'),rule('a')],[],['a']));
    assert.throws(()=>planTransfer('preset',[rule('a')],[rule('b')],['a'],()=> 'b'));
});

function fixture() {
    const source={kind:'character',id:'A',avatar:'A.png'}, target={kind:'character',id:'B',avatar:'B.png'};
    const store={A:[rule('a'),rule('b')],B:[rule('existing')]}, writes=[];
    const repository={read:async ref=>clone(store[ref.id]),write:async(ref,data)=>{writes.push(ref.id);store[ref.id]=clone(data)}};
    return {source,target,store,writes,repository,service:new ContentTransferService(repository)};
}
test('copy writes only the target; move saves destination before source',async()=>{
    const f=fixture();let job=await f.service.prepare('character',f.source,f.target,['a']);
    let result=await f.service.execute(job);assert.deepEqual(f.writes,['B']);assert.equal(result.moved,false);assert.equal(f.store.A.length,2);
    job=await f.service.prepare('character',f.source,f.target,['b']);result=await f.service.execute(job,{move:true});
    assert.deepEqual(f.writes,['B','B','A']);assert.equal(result.moved,true);assert.deepEqual(f.store.A.map(s=>s.id),['a']);
});
for(const point of ['source','target','closed'])test(`${point} changes after confirmation cause zero writes`,async()=>{
    const f=fixture();const job=await f.service.prepare('character',f.source,f.target,['a']);
    if(point==='source')f.store.A[0].replaceString='changed';if(point==='target')f.store.B.push(rule('late'));
    await assert.rejects(f.service.execute(job,{move:true,valid:()=>point!=='closed'}));assert.equal(f.writes.length,0);
});
test('target failure never removes source',async()=>{
    const f=fixture();const job=await f.service.prepare('character',f.source,f.target,['a']);
    f.repository.write=async()=>{throw Error('offline')};await assert.rejects(f.service.execute(job,{move:true}),error=>!error.targetSaved);
    assert.equal(f.store.A.length,2);assert.equal(f.service.busy,false);
});
for(const point of ['source-failure','close-after-copy','changed-source','changed-target'])test(`${point} retains saved copies and does not perform an unsafe source delete`,async()=>{
    const f=fixture();const job=await f.service.prepare('character',f.source,f.target,['a']);let valid=true;
    f.repository.write=async(ref,data)=>{
        f.writes.push(ref.id);if(ref.id==='A')throw Error('source offline');f.store[ref.id]=clone(data);
        if(point==='close-after-copy')valid=false;
        if(point==='changed-source')f.store.A.push(rule('external'));
        if(point==='changed-target')f.store.B[0].findRegex='external';
    };
    await assert.rejects(f.service.execute(job,{move:true,valid:()=>valid}),error=>error.targetSaved===true);
    assert.equal(f.store.B.length,2);assert.ok(f.store.A.some(s=>s.id==='a'));
    assert.deepEqual(f.writes,point==='source-failure'?['B','A']:['B']);
});
test('concurrent execute is refused while a save is pending',async()=>{
    const f=fixture();let release;f.repository.write=()=>new Promise(resolve=>release=resolve);
    const job=await f.service.prepare('character',f.source,f.target,['a']);const pending=f.service.execute(job);
    await new Promise(resolve=>setImmediate(resolve));await assert.rejects(f.service.execute(job),/正在保存/);release();await pending;
});
test('same source and target rejected',async()=>{const f=fixture();await assert.rejects(f.service.prepare('character',f.source,f.source,['a']),/不能相同/)});

test('native world writer detects swallowed HTTP failure and restores cache',async()=>{
    const previous={entries:{0:{uid:0,content:'original'}}};let cached=clone(previous);
    const worldApi={worldInfoCache:{get:()=>clone(cached),set:(_,value)=>cached=value},saveWorldInfo:async(_,data)=>{cached=data}};
    const repo=new NativeTransferRepository({scriptApi:{getRequestHeaders:()=>({})},worldApi,fetchImpl:async()=>({ok:true,json:async()=>clone(previous)})});
    await assert.rejects(repo.writeWorld('world',{entries:{1:{uid:1,content:'copy'}}}),/保存未确认/);
    assert.deepEqual(cached,previous);
});
test('native character writer checks response, targets avatar, verifies stored data and patches only regex fields',async t=>{
    const before=globalThis.document;globalThis.document={getElementById:()=>null};t.after(()=>{if(before===undefined)delete globalThis.document;else globalThis.document=before});
    const character={avatar:'A.png',name:'角色',data:{extensions:{other:42,regex_scripts:[rule('a')]}},json_data:JSON.stringify({data:{extensions:{other:42}}})};
    let stored=[rule('a')];const requests=[];
    const repo=new NativeTransferRepository({scriptApi:{characters:[character],this_chid:0,getRequestHeaders:()=>({'X-CSRF-Token':'fixture'})},worldApi:{},presetApi:{},fetchImpl:async(url,options)=>{
        const body=JSON.parse(options.body);requests.push({url,body,headers:options.headers});
        if(url.endsWith('merge-attributes'))stored=clone(body.data.extensions.regex_scripts);
        return {ok:true,json:async()=>({data:{extensions:{regex_scripts:clone(stored)}}})};
    }});
    await repo.write({kind:'character',id:'A.png',avatar:'A.png'},[],[rule('a')]);
    assert.equal(requests.find(r=>r.url.endsWith('merge-attributes')).body.avatar,'A.png');
    assert.ok(requests.every(r=>r.headers['X-CSRF-Token']==='fixture'));
    assert.deepEqual(character.data.extensions,{other:42,regex_scripts:[]});assert.equal(JSON.parse(character.json_data).data.extensions.other,42);
});
test('preset failure rolls back only our regex field, retains other extensions and never switches preset',async()=>{
    const preset={extensions:{other:true,regex_scripts:[rule('a')]}},settings={extensions:{unrelated:3,regex_scripts:[rule('a')]}};
    const manager={getAllPresets:()=>['P'],getCompletionPresetByName:()=>preset,getPresetList:()=>({settings}),getSelectedPresetName:()=> 'P',
        readPresetExtensionField:()=>settings.extensions.regex_scripts,writePresetExtensionField:async({value})=>{preset.extensions.regex_scripts=value;settings.extensions.regex_scripts=value;throw Error('save failed')}};
    const repo=new NativeTransferRepository({scriptApi:{saveSettingsDebounced(){}},worldApi:{},presetApi:{getPresetManager:id=>id==='openai'?manager:null}});
    await assert.rejects(repo.write({kind:'preset',id:'["openai","P"]',apiId:'openai',name:'P'},[],[rule('a')]));
    assert.deepEqual(preset.extensions,{other:true,regex_scripts:[rule('a')]});assert.equal(settings.extensions.unrelated,3);
});

test('character-to-preset and preset-to-character moves save the correct destination then the fixed source',async()=>{
 for(const [from,to] of [['character','preset'],['preset','character']]){
  const f=fixture();f.source.kind=from;f.target.kind=to;const kinds=[];
  f.repository.write=async(ref,data)=>{kinds.push(ref.kind);f.store[ref.id]=clone(data)};
  const job=await f.service.prepare(from,f.source,f.target,['a']);await f.service.execute(job,{move:true});
  assert.deepEqual(kinds,[to,from]);assert.equal(f.store.B.length,2);assert.deepEqual(f.store.A.map(rule=>rule.id),['b']);
 }
});
test('world books cannot be accidentally mixed with regex endpoints',async()=>{const f=fixture();f.target.kind='world';await assert.rejects(f.service.prepare('character',f.source,f.target,['a']),/不能混合/)});

test('editing changes only name/body fields and preserves identity, options and original metadata',()=>{
 const world={entries:{0:{uid:0,comment:'old',content:'old body',disable:true,depth:9,unknown:{x:1}}},originalData:{entries:[{uid:0,content:'old body',unknown:42}]}};
 const edited=editTransferEntry('world',world,'0',{name:'new',content:'new body'});assert.equal(world.entries[0].content,'old body');assert.equal(edited.entries[0].uid,0);assert.equal(edited.entries[0].depth,9);assert.equal(edited.originalData.entries[0].content,'new body');assert.equal(edited.originalData.entries[0].unknown,42);
 const source=[rule('a')];const next=editTransferEntry('preset',source,'a',{name:'new',findRegex:'/new/g',replaceString:'replacement'});
 assert.deepEqual(next[0],{...source[0],scriptName:'new',findRegex:'/new/g',replaceString:'replacement'});assert.throws(()=>editTransferEntry('preset',source,'a',{name:' '}),/不能为空/);assert.throws(()=>editTransferEntry('world',world,'missing',{}),/不存在/);
});
test('transfer groups use the same numbered/bracket rules and honor per-endpoint manual assignment',()=>{
 const ref={kind:'character',avatar:'A.png'};assert.equal(transferCollection(ref,{id:'a',scriptName:'01 | 社交动态 | 正文'}),'社交动态');assert.equal(transferCollection(ref,{id:'b',scriptName:'[月下] 正文'}),'月下');
 const settings={cloud_lounge_accelerator_regex_collections:{'["SCOPED","A.png"]':{assignments:{a:'自定义'}}}};
 assert.equal(transferCollection(ref,{id:'a',scriptName:'01 | 社交动态 | 正文'},settings),'自定义');assert.equal(transferCollection({kind:'character',avatar:'B.png'},{id:'a',scriptName:'01 | 社交动态 | 正文'},settings),'社交动态');
});
