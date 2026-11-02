// Isolated desktop/touch regression using official secrets.js for native
// delete/read/reconnect behavior. Server storage, popup and jQuery are fixtures.
// Requires Playwright, CLA_NATIVE_SECRETS; optional CLA_BROWSER_EXECUTABLE,
// CLA_TEST_THEME. Never point this fixture at a live secret store.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const native = await readFile(process.env.CLA_NATIVE_SECRETS, 'utf8');
const imports = [...native.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g)]
    .flatMap(match => match[1].split(',').map(name => name.trim())).filter(Boolean);
const assets = new Map(await Promise.all(['modules/secret-key-batch.js', 'style.css'].map(async path =>
    ['/' + path, await readFile(new URL('../' + path, import.meta.url), 'utf8')])));
assets.set('/secrets.js', native.replace(/from ['"][^'"]+['"]/g, "from '/stub.js'"));
assets.set('/theme.css', process.env.CLA_TEST_THEME ? await readFile(process.env.CLA_TEST_THEME, 'utf8') : '');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/theme.css">
<style>
*{box-sizing:border-box}body{font:16px sans-serif;margin:0;background:#c6d9e9;color:#22303e;--SmartThemeBodyColor:#22303e;--SmartThemeQuoteColor:#527ac9}
.popup{position:fixed;inset:16px;padding:16px;border:1px solid #fff8;border-radius:20px;background:#eef6fcaa;backdrop-filter:blur(16px);display:flex;flex-direction:column}
.secretKeyManager{display:flex;flex:1;flex-direction:column;min-height:0}.secretKeyManagerHeader{flex-shrink:0}
.secretKeyManagerSubtitle{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}.flex-container{display:flex;gap:8px}.secretKeyManagerList{overflow-y:auto;min-height:0;display:flex;flex-direction:column;gap:8px}
.secretKeyManagerItem{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px;border-radius:12px;background:#65748144;border:1px solid #64768866;flex-shrink:0}.secretKeyManagerItemInfo{min-width:0;overflow-wrap:anywhere}.secretKeyManagerItem.active{border-color:#6da5df;background:#fff3}.secretKeyManagerItemActionsRow{display:flex;gap:6px}.secretKeyManagerItemActions{flex-shrink:0}
.menu_button{background:#fff4;border:1px solid #fff6;border-radius:8px;padding:6px;color:inherit;cursor:pointer;font:inherit}.secretKeyManagerItemId{font-size:12px}.secretKeyManagerItemHeader{font-size:17px}.secretKeyManagerItemHeader small{margin-left:6px}.secretKeyManagerItemSubtitle{display:flex;gap:6px}
dialog{max-width:calc(100vw - 24px);border-radius:16px;border:1px solid #aab8c8;padding:20px}dialog::backdrop{background:#0004}
@media(max-width:600px){.popup{inset:6px;padding:12px}.secretKeyManagerItem{padding:8px}.secretKeyManagerItemActionsRow{gap:2px}.secretKeyManagerItemHeader{font-size:15px}}
</style>
<div hidden><button id="viewSecrets" key_saved_text="已保存" missing_key_text="未保存"></button><input id="api_key_custom"><input id="api_key_openai"><select id="main_api"></select></div>
<div class="popup"><div class="secretKeyManager"><div class="secretKeyManagerHeader"><div class="secretKeyManagerSubtitle"><div class="secretKeyManagerInfo"><div class="flex-container">API: <span>Custom (OpenAI-compatible)</span></div><div class="flex-container">密钥：<code>api_key_custom</code></div></div><div class="secretKeyManagerActions"><button class="menu_button" data-action="add-secret">＋ 添加密钥</button></div></div></div><hr><div class="secretKeyManagerList" role="list"></div><div class="secretKeyManagerListEmpty" style="display:none">无保存的密钥。</div></div><button class="menu_button" id="close">确定</button></div>
<script type="module">
import * as secrets from '/secrets.js';import {SecretKeyBatchActions} from '/modules/secret-key-batch.js';
window.store={};window.requests=[];window.notices=[];window.events=[];window.reconnects=0;window.nativeClicks=0;
window.$=selector=>{const nodes=typeof selector==='string'?[...document.querySelectorAll(selector)]:[selector];const result={attr:(key,value)=>{if(value===undefined)return nodes[0]?.getAttribute(key);for(const node of nodes)node.setAttribute(key,value);return result},trigger:type=>{for(const node of nodes)node.dispatchEvent(new Event(type));return result}};return result;};
document.querySelector('#main_api').onchange=()=>reconnects++;
window.nativeDeps={getRequestHeaders:()=>({'X-CSRF-Token':'fixture'}),t:(parts,...values)=>parts.reduce((out,p,i)=>out+p+(values[i]??''),''),
event_types:{SECRET_DELETED:'deleted'},eventSource:{emit:async(...args)=>events.push(args)},Popup:{show:{confirm:async(header,content)=>new Promise(resolve=>{
window.confirmations=(window.confirmations||0)+1;const dialog=document.createElement('dialog');dialog.id='confirm';dialog.append(content);
for(const [id,text,value] of [['approve','删除所选',1],['cancel','取消',0]]){const button=document.createElement('button');button.id=id;button.className='menu_button';button.textContent=text;button.onclick=()=>{dialog.close();dialog.remove();resolve(value)};dialog.append(button)}
dialog.oncancel=e=>{e.preventDefault();dialog.remove();resolve(null)};document.body.append(dialog);dialog.showModal();})}}};
window.toastr=Object.fromEntries(['success','warning','error'].map(level=>[level,message=>notices.push({level,message})]));
window.fetch=async(url,options)=>{const body=options.body?JSON.parse(options.body):null;requests.push({url,body,headers:options.headers});
if(url==='/api/secrets/delete'){
 await window.deleteGate;
 if(window.networkFail)throw Error('offline');if(window.failId===body.id)return {ok:false,status:503};
 store[body.key]=(store[body.key]||[]).filter(s=>s.id!==body.id);if(!store[body.key].some(s=>s.active)&&store[body.key].length)store[body.key][0].active=true;
 return {ok:true};
}if(url==='/api/secrets/read'){if(window.readFail)return {ok:false,status:503};return {ok:true,json:async()=>structuredClone(store)}};throw Error('Unexpected request '+url);};
window.render=()=>{const list=document.querySelector('.secretKeyManagerList');list.replaceChildren();for(const item of store.api_key_custom||[]){const row=document.createElement('div');row.className='secretKeyManagerItem'+(item.active?' active':'');row.setAttribute('role','listitem');
row.innerHTML='<div class="secretKeyManagerItemInfo"><div class="secretKeyManagerItemHeader"><strong></strong><small>*******abc</small></div><div class="secretKeyManagerItemSubtitle"><strong>ID:</strong><span class="secretKeyManagerItemId" data-action="copy-id"></span></div></div><div class="secretKeyManagerItemActions"><div class="secretKeyManagerItemActionsRow"><button class="menu_button" data-action="rotate-secret">✓</button><button class="menu_button" data-action="copy-secret">⧉</button></div><div class="secretKeyManagerItemActionsRow"><button class="menu_button" data-action="rename-secret">✎</button><button class="menu_button" data-action="delete-secret">⌫</button></div></div>';
row.querySelector('.secretKeyManagerItemHeader strong').textContent=item.label;row.querySelector('.secretKeyManagerItemId').textContent=item.id;
for(const b of row.querySelectorAll('button'))b.dataset.id=item.id;list.append(row);}
document.querySelector('.secretKeyManagerListEmpty').style.display=store.api_key_custom?.length?'none':'';};
window.reset=async()=>{window.failId=null;window.networkFail=false;window.readFail=false;window.deleteGate=null;
store={api_key_custom:['one','active','three','four','five','six','seven','eight'].map((id,i)=>({id,label:i===0?'<img src=x onerror=window.injected=true>':'测试密钥 '+id,active:id==='active',value:'*******abc'})),api_key_openai:[{id:'unrelated',active:true,value:'*******xyz'}]};
await secrets.readSecretState();render();adapter.refresh();requests.length=0;events.length=0;notices.length=0;reconnects=0;};
window.adapter=new SecretKeyBatchActions();await adapter.start();await reset();
document.addEventListener('click',e=>{if(e.target.closest('[data-action]'))nativeClicks++;});
document.querySelector('#close').onclick=()=>document.querySelector('.popup').remove();window.ready=true;
</script>`;
// Native dependency stubs must exist before module evaluation.
const prelude = html.replace('<script type="module">', '<script>window.nativeDeps={};</script><script type="module">');
// Imports evaluate first, so expose lazy proxy functions to the runtime fixtures.
assets.set('/stub.js', [...new Set(imports)].map(name => {
    if (['eventSource','event_types','Popup'].includes(name)) return `export const ${name}=new Proxy({}, {get:(_,key)=>window.nativeDeps.${name}?.[key]});`;
    return `export const ${name}=(...args)=>window.nativeDeps.${name}?.(...args);`;
}).join('\n'));
// Native Popup helper is accessed at runtime by the adapter's lazy import.
assets.set('/popup.js', 'export const Popup={show:{confirm:(...args)=>window.nativeDeps.Popup.show.confirm(...args)}};export const POPUP_RESULT={AFFIRMATIVE:1};');
const server = createServer((req,res)=>{res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(assets.get(req.url)??prelude)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser=await chromium.launch({headless:true,...(process.env.CLA_BROWSER_EXECUTABLE?{executablePath:process.env.CLA_BROWSER_EXECUTABLE}:{})});
 for(const mobile of [false,true]) {
  const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1100,height:900},isMobile:mobile,hasTouch:mobile});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.ready);
  const action=name=>page.locator('[data-cla-secret-action="'+name+'"]');
  const row=id=>page.locator('.secretKeyManagerItem').filter({has:page.locator('[data-action="delete-secret"][data-id="'+id+'"]')});
  const press=async locator=>mobile?locator.tap():locator.click();
  const reset=async()=>{await page.evaluate(async()=>{adapter.mode=false;adapter.selected.clear();await reset()});await press(action('toggle'));};
  await press(row('one').locator('[data-action="rename-secret"]'));
  assert.equal(await page.evaluate(()=>nativeClicks),1);
  await press(action('toggle'));await press(row('one').locator('input'));
  assert.deepEqual(await page.evaluate(()=>[...adapter.selected]),['one']);
  await press(row('active').locator('.secretKeyManagerItemHeader'));
  assert.equal(await page.evaluate(()=>adapter.selected.size),2);
  await press(row('three').locator('[data-action="delete-secret"]'));
  assert.equal(await page.evaluate(()=>nativeClicks),1,'native buttons cannot race batch selection');
  await press(action('delete'));
  assert.match(await page.locator('#confirm').innerText(),/当前使用.*重新连接/);
  assert.equal(await page.locator('#confirm img').count(),0,'labels cannot inject HTML');
  await press(page.locator('#cancel'));await page.waitForFunction(()=>!adapter.busy);
  assert.equal(await page.evaluate(()=>requests.length),0);
  await press(action('delete'));await press(page.locator('#approve'));await page.waitForFunction(()=>!adapter.busy);
  assert.deepEqual(await page.evaluate(()=>requests.map(r=>r.url)),['/api/secrets/delete','/api/secrets/read','/api/secrets/delete','/api/secrets/read']);
  assert.deepEqual(await page.evaluate(()=>requests.filter(r=>r.url.endsWith('delete')).map(r=>r.body)),[{key:'api_key_custom',id:'one'},{key:'api_key_custom',id:'active'}]);
  assert.ok(await page.evaluate(()=>requests.every(r=>r.headers['X-CSRF-Token']==='fixture')));
  assert.deepEqual(await page.evaluate(()=>events),[['deleted','api_key_custom'],['deleted','api_key_custom']]);
  assert.equal(await page.evaluate(()=>reconnects),2);
  assert.equal(await row('one').count(),0);assert.equal(await row('active').count(),0);
  assert.equal(await row('three').evaluate(node=>node.classList.contains('active')),true);
  assert.equal(await page.evaluate(()=>store.api_key_openai.length),1);
  assert.equal(await page.locator('#api_key_custom').getAttribute('placeholder'),'已保存 (测试密钥 three)');
  assert.equal(await page.locator('#api_key_custom_datalist option').count(),6);
  await reset();await press(action('all'));assert.equal(await page.evaluate(()=>adapter.selected.size),8);
  await press(action('clear'));assert.equal(await action('delete').isDisabled(),true);
  await press(action('all'));await page.evaluate(()=>{failId='active'});
  await press(action('delete'));await press(page.locator('#approve'));await page.waitForFunction(()=>!adapter.busy);
  assert.equal(await row('one').count(),0);assert.equal(await row('active').count(),1);assert.equal(await row('three').count(),1);
  assert.equal(await page.evaluate(()=>adapter.selected.size),7);assert.match(await page.evaluate(()=>notices.at(-1).message),/已删除 1.*剩余 7.*未确认/);
  const bounds=await page.locator('.cla-secret-batch-toolbar button:visible').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return {left:b.left,right:b.right}}));
  assert.ok(bounds.every(b=>b.left>=0&&b.right<=(mobile?390:1100)),'controls fit viewport');
  await page.screenshot({path:'/private/tmp/cla-secret-batch-'+(mobile?'touch':'desktop')+'.png'});
  await reset();await press(row('one').locator('input'));await page.evaluate(()=>{readFail=true});
  await press(action('delete'));await press(page.locator('#approve'));await page.waitForFunction(()=>!adapter.busy);
  assert.equal(await row('one').count(),1,'state read failure cannot falsely claim success');
  assert.match(await page.evaluate(()=>notices.at(-1).message),/已删除 0.*未确认/);
  await reset();await press(action('all'));await press(action('delete'));
  await page.evaluate(()=>{const root=document.querySelector('.secretKeyManager');const parent=root.parentNode;root.remove();parent.prepend(root)});
  await press(page.locator('#approve'));await page.waitForFunction(()=>!adapter.busy);
  assert.equal(await page.evaluate(()=>requests.length),0,'same-node close/reopen invalidates confirmation');
  await reset();await press(action('all'));await page.evaluate(()=>{deleteGate=new Promise(r=>window.releaseDelete=r)});
  await press(action('delete'));await press(page.locator('#approve'));await page.waitForFunction(()=>requests.some(r=>r.url.endsWith('delete')));
  await press(page.locator('#close'));await page.evaluate(()=>releaseDelete());await page.waitForFunction(()=>!adapter.busy);
  assert.equal(await page.evaluate(()=>requests.filter(r=>r.url.endsWith('delete')).length),1,'closing stops remaining queue');
  await page.reload();await page.waitForFunction(()=>window.ready);await press(action('toggle'));await press(action('all'));
  await press(action('delete'));await press(page.locator('#approve'));await page.waitForFunction(()=>!adapter.busy);
  assert.equal(await page.locator('.secretKeyManagerItem').count(),0);assert.equal(await page.locator('.secretKeyManagerListEmpty').isVisible(),true);
  await reset();await press(action('toggle'));await press(row('one').locator('[data-action="copy-secret"]'));
  assert.equal(await page.evaluate(()=>nativeClicks),1,'native single-key actions resume after leaving batch mode');
  await press(action('toggle'));await page.evaluate(()=>adapter.stop());
  assert.equal(await page.locator('.cla-secret-batch-toolbar, .cla-secret-batch-choice').count(),0);
  assert.equal(await page.locator('.cla-secret-batch-mode').count(),0);
  assert.deepEqual(errors,[]);
  console.log((mobile?'Touch':'Desktop')+': native delete/read/reconnect/events, selection, cancellation, partial failure, stale read, close/reopen, empty list, layout and cleanup passed');
  await page.close();
 }
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
