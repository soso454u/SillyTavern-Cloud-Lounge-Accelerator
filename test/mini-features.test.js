import test from 'node:test';
import assert from 'node:assert/strict';
import { MiniFeatures } from '../modules/mini-features.js';
import { normalizeSettings } from '../settings.js';
const keys=['regexCollections','transferTools','presetEntryActions','presetTokenPreview','secretKeyBatch','chatHistoryBatch','autoConnect'];
function fixture(){
 const events=[],modules={};
 for(const key of keys.filter(key=>key!=='regexCollections'))modules[key]={started:false,async start(){if(this.started)return;this.started=true;events.push(key+':start');await this.gate},stop(){this.started=false;events.push(key+':stop')}};
 const regexUiAdapter={started:false,collections:true,setCollectionsEnabled(value){this.collections=value},async start(){this.started=true},stop(){this.started=false}};
 return {events,modules,regexUiAdapter,features:new MiniFeatures({modules,regexUiAdapter})};
}
test('all mini features default on, preserve explicit off, and are independent of performance switches',()=>{
 const defaults=normalizeSettings({pageAcceleration:false,chatOptimization:false,interactionOptimization:false});
 for(const key of keys)assert.equal(defaults[key],true,key);
 const off=normalizeSettings(Object.fromEntries(keys.map(key=>[key,false])));for(const key of keys)assert.equal(off[key],false,key);
});
test('default startup enables tools even when all three performance switches are off',async()=>{
 const f=fixture();await f.features.apply(normalizeSettings({pageAcceleration:false,chatOptimization:false,interactionOptimization:false}));
 assert.ok(Object.values(f.modules).every(module=>module.started));assert.equal(f.regexUiAdapter.started,true);
});
test('turning one tool off leaves every other tool active',async()=>{
 const f=fixture(),settings=normalizeSettings({});await f.features.apply(settings);await f.features.apply({...settings,transferTools:false});
 assert.equal(f.modules.transferTools.started,false);assert.equal(f.modules.autoConnect.started,true);assert.equal(f.modules.secretKeyBatch.started,true);assert.equal(f.regexUiAdapter.collections,true);
});
test('classification off retains native regex operation adapter while chat optimization is on',async()=>{
 const f=fixture();await f.features.apply(normalizeSettings({regexCollections:false}));assert.equal(f.regexUiAdapter.collections,false);assert.equal(f.regexUiAdapter.started,true);
 await f.features.apply(normalizeSettings({regexCollections:false,chatOptimization:false}));assert.equal(f.regexUiAdapter.started,false);
});
test('preset wrappers restart in reverse stop order when an independent switch changes',async()=>{
 const f=fixture(),settings=normalizeSettings({});await f.features.apply(settings);f.events.length=0;
 await f.features.apply({...settings,presetEntryActions:false});
 assert.ok(f.events.indexOf('presetTokenPreview:stop')<f.events.indexOf('presetEntryActions:stop'));
 assert.equal(f.modules.presetTokenPreview.started,true);assert.equal(f.modules.presetEntryActions.started,false);
 await f.features.apply(settings);assert.equal(f.modules.presetEntryActions.started,true);assert.equal(f.modules.presetTokenPreview.started,true);
});
test('disable during pending imports prevents late startup and cleans up all tools',async()=>{
 const f=fixture();let release;f.modules.presetEntryActions.gate=new Promise(resolve=>release=resolve);
 const pending=f.features.apply(normalizeSettings({}));await new Promise(resolve=>setImmediate(resolve));f.features.stop();release();await pending;
 assert.ok(Object.values(f.modules).every(module=>!module.started));assert.equal(f.regexUiAdapter.started,false);
});
test('a newer off preference wins while the previous apply is pending',async()=>{
 const f=fixture();let release;f.modules.transferTools.gate=new Promise(resolve=>release=resolve);
 const settings=normalizeSettings({});const first=f.features.apply(settings);await new Promise(resolve=>setImmediate(resolve));const second=f.features.apply({...settings,transferTools:false});release();await Promise.all([first,second]);
 assert.equal(f.modules.transferTools.started,false);assert.equal(f.modules.autoConnect.started,true);
});
