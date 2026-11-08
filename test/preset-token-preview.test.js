import test from 'node:test';
import assert from 'node:assert/strict';
import { PresetTokenPreview } from '../modules/preset-token-preview.js';
async function fixture(t) {
    const attrs=new Map([['data-pm-tokens','-']]);
    const cell={isConnected:true,innerHTML:'<span> </span>-',textContent:' -',dataset:{},getAttribute:name=>attrs.get(name)??null,setAttribute:(name,value)=>attrs.set(name,value),removeAttribute:name=>attrs.delete(name)};
    const fields={prompt:{value:'original',after(element){element.isConnected=true}},role:{value:'system'},save:{dataset:{pmPrompt:'id'}}};
    const prompt={identifier:'id',role:'system',content:'original'};
    const manager={configuration:{prefix:'completion_'},serviceSettings:{prompts:[prompt]},listElement:{children:[{dataset:{pmIdentifier:'id'},classList:{contains:()=>false},querySelector:selector=>selector==='.prompt-manager-edit-action'?{}:cell}]},
        getPromptById(id){return this.serviceSettings.prompts.find(p=>p.identifier===id)},preparePrompt(){throw Error('Macros must not be executed')},
        loadPromptIntoEditForm(p){fields.prompt.value=p.content;fields.role.value=p.role;fields.save.dataset.pmPrompt=p.identifier},clearEditForm(){fields.save.dataset.pmPrompt=''},async renderPromptManagerListItems(){}};
    const documentRef={addEventListener(){},removeEventListener(){},getElementById(id){return fields[id.replace('completion_prompt_manager_popup_entry_form_','')]},createElement(){return {isConnected:false,setAttribute(){},remove(){this.isConnected=false}}}};
    const requests=[];let model='A';
    const preview=new PresetTokenPreview({documentRef,delay:100000,loadApi:async()=>({manager,model:()=>model,count:async message=>{requests.push(message);return message.content.length+message.role.length}})});
    await preview.start();t.after(()=>preview.stop());
    return {preview,manager,fields,prompt,cell,requests, rowPreview:()=>attrs.get('data-cla-preset-raw-tokens'),setModel:value=>model=value};
}
test('counts raw draft text with native role, does not execute macros or save drafts',async t=>{
    const f=await fixture(t);f.manager.loadPromptIntoEditForm(f.prompt);f.fields.prompt.value='{{setvar::x::y}}';await f.preview.refresh();
    assert.equal(f.rowPreview(),'22');assert.equal(f.cell.getAttribute('data-pm-tokens'),'-');assert.equal(f.cell.innerHTML,'<span> </span>-');assert.deepEqual(f.requests,[{role:'system',content:'{{setvar::x::y}}'}]);assert.equal(f.prompt.content,'original');assert.equal(f.preview.badge.textContent,'草稿：22 tokens');
});
test('cancel returns row preview to saved content and removes draft badge',async t=>{
    const f=await fixture(t);f.manager.loadPromptIntoEditForm(f.prompt);f.fields.prompt.value='changed';await f.preview.refresh();f.manager.clearEditForm();await f.preview.refresh();
    assert.equal(f.rowPreview(),'14');assert.equal(f.preview.badge,null);assert.equal(f.prompt.content,'original');
});
test('empty draft counts zero without tokenizer request',async t=>{
    const f=await fixture(t);f.manager.loadPromptIntoEditForm(f.prompt);f.fields.prompt.value='';await f.preview.refresh();assert.equal(f.rowPreview(),'0');assert.equal(f.requests.length,0);
});
test('late count cannot paint a newer draft or a stopped preview',async t=>{
    const f=await fixture(t);f.manager.loadPromptIntoEditForm(f.prompt);let release;f.preview.count=()=>new Promise(resolve=>release=resolve);
    const pending=f.preview.refresh();f.fields.prompt.value='latest';f.preview.schedule();release(999);await pending;assert.equal(f.rowPreview(),undefined);
    const stopped=f.preview.refresh();f.preview.stop();release(888);await stopped;assert.equal(f.cell.innerHTML,'<span> </span>-');assert.equal(f.preview.badge,null);
});
test('failed tokenizer retains previous row count and reports unavailable',async t=>{
    const f=await fixture(t);f.manager.loadPromptIntoEditForm(f.prompt);f.preview.count=async()=>{throw Error('offline')};await f.preview.refresh();assert.equal(f.rowPreview(),undefined);assert.equal(f.preview.badge.textContent,'token 计数暂不可用');
});
test('model changes invalidate an in-flight count and do not reuse prior model cache',async t=>{
    const f=await fixture(t);f.manager.loadPromptIntoEditForm(f.prompt);await f.preview.refresh();assert.equal(f.requests.length,1);
    f.setModel('B');await f.preview.refresh();assert.equal(f.requests.length,2);
    f.fields.prompt.value='new';let release;f.preview.count=()=>new Promise(resolve=>release=resolve);const pending=f.preview.refresh();f.setModel('C');release(999);await pending;assert.equal(f.rowPreview(),'14');
});
test('switching prompt scope invalidates the prior count',async t=>{
    const f=await fixture(t);f.manager.loadPromptIntoEditForm(f.prompt);let release;f.preview.count=()=>new Promise(resolve=>release=resolve);const pending=f.preview.refresh();f.manager.serviceSettings.prompts=[{...f.prompt,content:'another preset'}];release(999);await pending;assert.equal(f.rowPreview(),undefined);
});
test('a newly saved draft continues counting after its prompt array is replaced',async t=>{
    const f=await fixture(t);const draft={identifier:'id',role:'system',content:'new draft'};f.manager.serviceSettings.prompts=[];f.manager.loadPromptIntoEditForm(draft);await f.preview.refresh();
    f.manager.serviceSettings.prompts=[{...draft,content:'saved draft'}];f.manager.clearEditForm();await f.manager.renderPromptManagerListItems();await f.preview.refresh();assert.equal(f.rowPreview(),'17');assert.equal(f.preview.badge,null);
});
test('a later third-party wrapper cannot revive token UI after disable',async t=>{
    const f=await fixture(t);const wrapped=f.manager.loadPromptIntoEditForm;f.manager.loadPromptIntoEditForm=(...args)=>wrapped(...args);f.preview.stop();f.manager.loadPromptIntoEditForm(f.prompt);assert.equal(f.preview.badge,null);assert.equal(f.preview.draft,null);
});
test('reenabling beneath a later wrapper leaves older generations dormant',async t=>{
    const f=await fixture(t);const old=f.manager.loadPromptIntoEditForm;f.manager.loadPromptIntoEditForm=(...args)=>old(...args);f.preview.stop();await f.preview.start();let badges=0;const ensure=f.preview.ensureBadge.bind(f.preview);f.preview.ensureBadge=()=>{badges++;ensure()};f.manager.loadPromptIntoEditForm(f.prompt);assert.equal(badges,1);
});

test('preserves native numbers while a normal prompt still gets a live draft count', async t => {
    const f = await fixture(t);
    f.manager.loadPromptIntoEditForm(f.prompt);
    await f.preview.refresh();
    assert.equal(f.rowPreview(), '14');
    f.cell.setAttribute('data-pm-tokens', '578');
    f.cell.innerHTML = '<span class="native-indicator"></span>578';
    f.fields.prompt.value = 'edited';
    await f.preview.refresh();
    assert.equal(f.rowPreview(), undefined);
    assert.equal(f.cell.getAttribute('data-pm-tokens'), '578');
    assert.equal(f.cell.innerHTML, '<span class="native-indicator"></span>578');
    assert.equal(f.preview.badge.textContent, '草稿：12 tokens');
});

test('chat history never receives a raw preview even if an imported preset omits its marker flag', async t => {
    const f = await fixture(t);
    f.manager.loadPromptIntoEditForm(f.prompt);
    const history = { identifier: 'chatHistory', role: 'system', content: 'placeholder' };
    f.manager.serviceSettings.prompts.push(history);
    f.manager.listElement.children[0].dataset.pmIdentifier = history.identifier;
    f.manager.loadPromptIntoEditForm(history);
    await f.preview.refresh();
    assert.equal(f.preview.badge, null);
    assert.deepEqual(f.requests, []);
    assert.equal(f.rowPreview(), undefined);
    assert.equal(f.cell.getAttribute('data-pm-tokens'), '-');
});
