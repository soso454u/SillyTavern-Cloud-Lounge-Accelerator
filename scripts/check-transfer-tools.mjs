// Isolated browser fixtures: real transfer/controller modules, simulated native
// repositories, popups and storage. Never accesses a user's world books/cards.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
const assets=new Map(await Promise.all(['modules/transfer-tools.js','modules/content-transfer.js','modules/auto-connect.js','utils/transfer-drag.js','utils/press-sweep-selection.js','utils/regex-collections.js','style.css'].map(async path=>['/'+path,await readFile(new URL('../'+path,import.meta.url),'utf8')])));
assets.set('/world-info.js',`
export const world_names=['世界书 A','世界书 B'];export const worldInfoCache=new Map();
export async function loadWorldInfo(name){if(worldInfoCache.has(name))return structuredClone(worldInfoCache.get(name));const data=await (await fetch('/api/worldinfo/get',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})})).json();worldInfoCache.set(name,data);return structuredClone(data)}
export async function saveWorldInfo(name,data){worldInfoCache.set(name,data);await fetch('/api/worldinfo/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,data})})}export function reloadEditor(){}
`);
assets.set('/preset-manager.js',`
const settings={extensions:{other:'keep',regex_scripts:[]}};
const presets={P1:{temperature:0.8,prompts:[{content:'preserve'}],extensions:{other:'A',regex_scripts:[{id:'p1',scriptName:'预设规则',findRegex:'/P/g',replaceString:'PP',placement:[1,2],disabled:true,unknown:42}]}},P2:{temperature:0.2,prompts:[{content:'target'}],extensions:{other:'B',regex_scripts:[]}}};
export const manager={getAllPresets:()=>Object.keys(presets),getCompletionPresetByName:name=>presets[name],getSelectedPresetName:()=> 'P0',getPresetList:()=>({settings}),readPresetExtensionField:({name})=>presets[name]?.extensions.regex_scripts,
writePresetExtensionField:async({name,value})=>{presets[name].extensions.regex_scripts=value;const response=await fetch('/api/presets/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,apiId:'openai',preset:presets[name]})});if(!response.ok)throw Error('preset save failed')}};
export const getPresetManager=id=>!id||id==='openai'?manager:null;window.presetFixtures=presets;
`);
assets.set('/popup.js',`
export const POPUP_TYPE={TEXT:1,CONFIRM:2};export const POPUP_RESULT={AFFIRMATIVE:1};
export class Popup{
constructor(content,type,text,options){this.content=content;this.options=options;this.dialog=document.createElement('dialog');this.dialog.className='fixture-popup';this.dialog.append(content);const close=document.createElement('button');close.id='fixture-close';close.textContent='关闭';close.className='menu_button';close.onclick=()=>this.complete(0);this.dialog.append(close);if(type===2){close.dataset.editorCancel='';close.textContent='取消';const save=document.createElement('button');save.textContent='保存';save.className='menu_button';save.dataset.editorSave='';save.onclick=()=>this.complete(1);this.dialog.append(save)}this.dialog.oncancel=e=>{e.preventDefault();this.complete(0)}}
show(){document.body.append(this.dialog);this.dialog.showModal();return new Promise(r=>this.resolve=r)}
async complete(value){this.result=value;if(await this.options.onClosing?.(this)===false)return;await this.options.onClose?.();this.dialog.close();this.dialog.remove();this.resolve?.(value)}
static show={confirm:async(header,content)=>{window.confirmations++;const dialog=document.createElement('dialog');dialog.id='confirm-transfer';dialog.append(content);document.body.append(dialog);dialog.showModal();return new Promise(resolve=>{for(const [id,text,value]of [['approve','确认',1],['cancel','取消',0]]){const button=document.createElement('button');button.id=id;button.textContent=text;button.className='menu_button';button.onclick=()=>{dialog.close();dialog.remove();resolve(value)};dialog.append(button)};dialog.oncancel=e=>{e.preventDefault();dialog.remove();resolve(null)}})}};
}
`);
assets.set('/secrets.js',`export const SECRET_KEYS={CUSTOM:'custom'};export let secret_state={custom:[{id:'a',active:true}]};export const resolveSecretKey=()=> 'custom';export function rotate(id){secret_state={custom:[{id,active:true}]};}`);
const rule=id=>({id,scriptName:id==='r1'?'01 | 社交动态 | 正文':id==='r2'?'02 | 社交动态 | 标题':'同名角色规则',findRegex:'/abc/g',replaceString:'<div>$1</div>',disabled:true,placement:[1,2],unknown:{keep:true}});
let worlds,cards,savedPresets,writes,fail;
const reset=()=>{worlds={'世界书 A':{entries:{0:{uid:0,comment:'<img src=x onerror=window.injected=true>',content:'世界条目正文',key:['关键词'],disable:true,position:4,depth:8,unknown:42},1:{uid:1,comment:'第二条',content:'搜索内容',key:['甲']}},extensions:{keep:true}},'世界书 B':{entries:{0:{uid:0,comment:'已有条目',content:'不能覆盖',displayIndex:5}},extensions:{target:true}}};for(let i=2;i<16;i++)worlds['世界书 A'].entries[i]={uid:i,comment:'其他条目 '+i,content:'用于检查正常上下滑动'};cards={'A.png':{avatar:'A.png',data:{extensions:{regex_scripts:[rule('r1'),rule('r2')],other:42}}},'B.png':{avatar:'B.png',data:{extensions:{regex_scripts:[rule('existing')],other:77}}}};savedPresets={};writes=[];fail=null};reset();
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>
*{box-sizing:border-box}body{font:15px sans-serif;background:#c8dbea;color:#202c36;--SmartThemeBorderColor:#7895;--SmartThemeBodyColor:#202c36}.menu_button,.text_pole{font:inherit;color:inherit;border:1px solid #9aabb8;border-radius:8px;background:#eff6facc;padding:6px}.fixture-popup{width:680px;max-width:calc(100vw - 20px);max-height:calc(100vh - 24px);overflow:auto;border:1px solid #bccddd;border-radius:18px;background:#e8f1f9;padding:16px}#confirm-transfer{max-width:calc(100vw - 20px);border-radius:12px}dialog::backdrop{background:#1235}.cla-transfer-list{max-height:35vh}.fa-eye::before{content:"◉"}#extensionsMenu{padding:12px}.list-group-item{cursor:pointer;padding:8px}
</style><div id="extensionsMenu"></div><input id="custom_api_url_text" value="https://example.invalid/v1"><select id="chat_completion_source"><option value="custom">custom</option></select><button id="api_button_openai" class="api_button">连接</button><button class="api_loading">取消连接</button>
<script type="module">
import{TransferTools}from'/modules/transfer-tools.js';import{AutoConnectController}from'/modules/auto-connect.js';import*as secrets from'/secrets.js';import*as worlds from'/world-info.js';
window.events=new Map();window.scriptApi={main_api:'openai',online_status:'no_connection',this_chid:0,characters:[{avatar:'A.png',name:'角色 A',data:{extensions:{regex_scripts:[]}}},{avatar:'B.png',name:'角色 B',data:{extensions:{regex_scripts:[]}}}],getRequestHeaders:()=>({'Content-Type':'application/json','X-CSRF-Token':'fixture'}),saveSettingsDebounced(){},event_types:{SECRET_ROTATED:'rotate',SECRET_WRITTEN:'write',SECRET_DELETED:'delete',GENERATION_ENDED:'end',GENERATION_STOPPED:'stop'},eventSource:{on:(e,f)=>events.set(e,f),removeListener:e=>events.delete(e)}};
window.notices=[];window.confirmations=0;window.connects=0;window.toastr=Object.fromEntries(['success','warning','error'].map(level=>[level,message=>notices.push({level,message})]));
window.tools=new TransferTools({scriptApi,onRegexSaved:()=>window.regexDirty=(window.regexDirty||0)+1});tools.start();
window.auto=new AutoConnectController({scriptApi,delay:40});document.querySelector('#api_button_openai').onclick=()=>{connects++;scriptApi.online_status='online'};
window.rotate=id=>{secrets.rotate(id);scriptApi.online_status='no_connection';events.get('rotate')?.('custom')};
window.resetWorldCache=()=>worlds.worldInfoCache.clear();await auto.start();window.ready=true;
</script>`;
const server=createServer(async(req,res)=>{
 if(req.url==='/fixture/reset'){reset();res.end('{}');return}
 if(req.url==='/fixture/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({worlds,cards,savedPresets,writes}));return}
 if(req.url.startsWith('/fixture/fail/')){fail=decodeURIComponent(req.url.slice('/fixture/fail/'.length));res.end('{}');return}
 if(req.url.startsWith('/api/')){
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||'{}');res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('/edit')||req.url.endsWith('merge-attributes')||req.url.endsWith('/save')){
   writes.push({url:req.url,body,csrf:req.headers['x-csrf-token']});
   if(fail===(body.name||body.avatar)){res.writeHead(503);res.end('{}');return}
  }
  if(req.url==='/api/worldinfo/get')res.end(JSON.stringify(worlds[body.name]));
  else if(req.url==='/api/worldinfo/edit'){worlds[body.name]=body.data;res.end('{"ok":true}')}
  else if(req.url==='/api/characters/get')res.end(JSON.stringify(cards[body.avatar_url]));
  else if(req.url==='/api/characters/merge-attributes'){cards[body.avatar].data.extensions.regex_scripts=body.data.extensions.regex_scripts;res.end('{}')}
  else if(req.url==='/api/presets/save'){savedPresets[body.name]=body.preset;res.end(JSON.stringify({name:body.name}))}
  else{res.writeHead(404);res.end('{}')};return;
 }
 res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(assets.get(req.url)??html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.CLA_BROWSER_EXECUTABLE?{executablePath:process.env.CLA_BROWSER_EXECUTABLE}:{})});
 for(const mobile of [false,true]){
  reset();const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1100,height:900},hasTouch:mobile,isMobile:mobile});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.ready&&connects===1);
  await page.evaluate(()=>rotate('b'));await page.waitForFunction(()=>connects===2);await page.evaluate(()=>{scriptApi.online_status='no_connection';rotate('c');document.querySelector('.api_loading').click()});await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>connects),2,'manual cancel stops queued auto connect');
  const press=async locator=>mobile?locator.tap():locator.click();const action=name=>page.locator('[data-cla-transfer-action="'+name+'"]');const field=name=>page.locator('[data-cla-transfer-field="'+name+'"]');
  const selected=id=>page.locator('[data-cla-transfer-select="'+id+'"]');const state=()=>page.evaluate(async()=>await(await fetch('/fixture/state')).json());
  const cdp=mobile?await page.context().newCDPSession(page):null;
  const drag=async(id,end='drop')=>{
   const handle=page.locator('[data-cla-transfer-drag="'+id+'"]');await handle.scrollIntoViewIfNeeded();
   await page.waitForFunction(()=>!tools.loading&&!tools.targetLoading);
   const from=await handle.boundingBox(),to=await page.locator('.cla-transfer-dropzone').boundingBox();
   const start={x:from.x+from.width/2,y:from.y+from.height/2},finish=end==='outside'?{x:start.x+12,y:start.y+10}:{x:to.x+to.width/2,y:to.y+45};
   if(mobile){await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...start,id:1}]});for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x+(finish.x-start.x)*i/8,y:start.y+(finish.y-start.y)*i/8,id:1}]});
    if(end==='cancel')await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});else await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   }else{await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(finish.x,finish.y,{steps:8});if(end==='cancel')await page.keyboard.press('Escape');await page.mouse.up();}
  };
  const sweep=async(fromId,toId)=>{
    const name=id=>page.locator('.cla-transfer-source-list [data-cla-transfer-id="'+id+'"] .cla-transfer-item-name');
    const a=await name(fromId).boundingBox(),b=await name(toId).boundingBox();const start={x:a.x+a.width/2,y:a.y+a.height/2},end={x:b.x+b.width/2,y:b.y+b.height/2};
    if(mobile){await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...start,id:9}]});await page.waitForTimeout(480);for(let i=1;i<=6;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x+(end.x-start.x)*i/6,y:start.y+(end.y-start.y)*i/6,id:9}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
    else{await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:6});await page.mouse.up();}
  };
  await press(page.locator('#cla-transfer-menu'));await selected('0').waitFor();assert.equal(await page.locator('.cla-transfer-item img').count(),0);
  assert.equal(await field('source').inputValue(),'世界书 A');assert.equal(await field('target').inputValue(),'世界书 B');
  if(mobile){const box=await page.locator('.cla-transfer-source-list').boundingBox();const x=box.x+70;const start=box.y+box.height-15,finish=box.y+15;
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:start,id:2}]});
   for(let i=1;i<=12;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:start+(finish-start)*i/12,id:2}]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(120);
   assert.ok(await page.locator('.cla-transfer-source-list').evaluate(el=>el.scrollTop)>0,'normal touch gesture scrolls list');
   assert.equal(await page.locator('.cla-transfer-drag-ghost').count(),0);await page.locator('.cla-transfer-source-list').evaluate(el=>el.scrollTop=0);
  }

  await press(selected('0'));
  const eye=(side,id)=>page.locator('[data-cla-transfer-side="'+side+'"][data-cla-transfer-view="'+id+'"]');
  const edit=name=>page.locator('[data-cla-transfer-edit="'+name+'"]');
  const saveEditor=()=>press(page.locator('[data-editor-save]'));const cancelEditor=()=>press(page.locator('[data-editor-cancel]'));
  await press(eye('source','0'));await edit('content').waitFor();assert.equal(await edit('content').inputValue(),'世界条目正文');
  await edit('content').fill('取消草稿');await cancelEditor();await page.waitForFunction(()=>!tools.previewLoading);assert.equal((await state()).writes.length,0);assert.equal(await selected('0').isChecked(),true);
  await press(eye('source','0'));await edit('content').fill('修改后的正文');await saveEditor();await page.waitForFunction(()=>!tools.previewLoading);
  assert.equal((await state()).worlds['世界书 A'].entries[0].content,'修改后的正文');assert.equal(await selected('0').isChecked(),true);
  await press(eye('target','0'));await edit('content').fill('目标修改后的正文');await saveEditor();await page.waitForFunction(()=>!tools.previewLoading);
  assert.equal((await state()).worlds['世界书 B'].entries[0].content,'目标修改后的正文');assert.equal(await selected('0').isChecked(),true);
  await page.evaluate(()=>fetch('/fixture/fail/'+encodeURIComponent('世界书 A')));await press(eye('source','0'));await edit('content').fill('保存失败的草稿');await saveEditor();
  await page.waitForFunction(()=>document.querySelector('.cla-transfer-editor [role="status"]').textContent.includes('未确认'));
  assert.equal(await edit('content').inputValue(),'保存失败的草稿');await cancelEditor();await page.waitForFunction(()=>!tools.previewLoading);await page.evaluate(()=>fetch('/fixture/fail/'));
  const writesBeforeCancel=(await state()).writes.length;
  await press(action('execute'));await press(page.locator('#cancel'));assert.equal((await state()).writes.length,writesBeforeCancel);
  assert.equal(await page.locator('.cla-transfer-item .cla-transfer-preview,.cla-transfer-item small').count(),0,'both panes show names only');

  const confirmsBefore=await page.evaluate(()=>confirmations);await drag('0','outside');await drag('0','cancel');assert.equal(await page.evaluate(()=>confirmations),confirmsBefore);assert.equal(await page.locator('.cla-transfer-drag-ghost,.cla-transfer-drop-active').count(),0);
  await drag('0');await page.locator('#confirm-transfer').waitFor();await press(page.locator('#approve'));await page.waitForFunction(()=>!tools.busy&&!tools.targetLoading);let s=await state();assert.equal(s.worlds['世界书 A'].entries[0].content,'修改后的正文');assert.equal(s.worlds['世界书 B'].entries[1].uid,1);assert.equal(s.worlds['世界书 B'].entries[1].unknown,42);assert.equal(s.worlds['世界书 B'].entries[0].content,'目标修改后的正文');
  await page.locator('[data-cla-transfer-source-search]').fill('搜索内容');await press(action('all'));assert.equal(await selected('1').isChecked(),true);await field('operation').selectOption('move');await drag('1');await press(page.locator('#approve'));await page.waitForFunction(()=>!tools.busy);s=await state();assert.equal(s.worlds['世界书 A'].entries[1],undefined);assert.equal(s.worlds['世界书 B'].entries[2].content,'搜索内容');
  await field('kind').selectOption('character');await selected('r1').waitFor();await sweep('r1','r2');assert.equal(await selected('r1').isChecked(),true);assert.equal(await selected('r2').isChecked(),true);await field('operation').selectOption('copy');await drag('r1');await page.locator('#confirm-transfer').waitFor();assert.match(await page.locator('#confirm-transfer').innerText(),/选中的 2 项/);await press(page.locator('#approve'));await page.waitForFunction(()=>!tools.busy);s=await state();assert.equal(s.cards['A.png'].data.extensions.regex_scripts.length,2);assert.equal(s.cards['B.png'].data.extensions.regex_scripts.length,3);const copied=s.cards['B.png'].data.extensions.regex_scripts[1];assert.notEqual(copied.id,'r1');assert.deepEqual(copied.unknown,{keep:true});assert.equal(copied.disabled,true);assert.equal(s.cards['B.png'].data.extensions.other,77);
  assert.deepEqual(await page.evaluate(()=>scriptApi.characters[1].data.extensions.regex_scripts.map(s=>s.id)),s.cards['B.png'].data.extensions.regex_scripts.map(s=>s.id));
  assert.equal(await page.locator('.cla-transfer-source-list [data-cla-transfer-collection="社交动态"]').count(),1);
  await field('target-kind').selectOption('preset');await page.waitForFunction(()=>!tools.targetLoading);
  await press(page.locator('[data-cla-transfer-select-group="社交动态"]'));assert.equal(await selected('r1').isChecked(),true);assert.equal(await selected('r2').isChecked(),true);
  await drag('');await press(page.locator('#approve'));await page.waitForFunction(()=>!tools.busy);
  s=await state();assert.equal(s.savedPresets.P1.extensions.regex_scripts.length,3,'character rules copy into a preset');assert.equal(s.savedPresets.P1.prompts[0].content,'preserve');
  assert.equal(await page.locator('.cla-transfer-target-list [data-cla-transfer-collection="社交动态"]').count(),1);
  await field('target-kind').selectOption('character');await page.waitForFunction(()=>!tools.targetLoading);
  await page.evaluate(()=>fetch('/fixture/fail/A.png'));await field('operation').selectOption('move');await press(selected('r2'));await press(action('execute'));await press(page.locator('#approve'));await page.waitForFunction(()=>!tools.busy);s=await state();assert.equal(s.cards['A.png'].data.extensions.regex_scripts.length,2);assert.equal(s.cards['B.png'].data.extensions.regex_scripts.length,4);assert.match(await page.locator('.cla-transfer-status').innerText(),/目标已经保存/);assert.equal(await action('execute').isDisabled(),true);
  await field('kind').selectOption('preset');await field('target-kind').selectOption('preset');await selected('p1').waitFor();await field('operation').selectOption('copy');await press(selected('p1'));await press(action('execute'));await press(page.locator('#approve'));await page.waitForFunction(()=>!tools.busy);s=await state();assert.equal(s.savedPresets.P2.extensions.regex_scripts.length,1);assert.equal(s.savedPresets.P2.extensions.regex_scripts[0].unknown,42);assert.equal(s.savedPresets.P2.temperature,0.2);assert.equal(s.savedPresets.P2.prompts[0].content,'target');assert.equal(s.savedPresets.P2.extensions.other,'B');
  await page.evaluate(()=>fetch('/fixture/fail/'));await field('target-kind').selectOption('character');await page.waitForFunction(()=>!tools.targetLoading);await field('operation').selectOption('copy');await press(selected('p1'));await press(action('execute'));await press(page.locator('#approve'));await page.waitForFunction(()=>!tools.busy);
  s=await state();assert.ok(s.cards['A.png'].data.extensions.regex_scripts.some(rule=>rule.scriptName==='预设规则'),'preset rules copy into a character');
  const targetId=s.cards['A.png'].data.extensions.regex_scripts.find(rule=>rule.scriptName==='预设规则').id;
  await press(eye('target',targetId));await edit('replaceString').fill('右侧编辑后的替换内容');await saveEditor();await page.waitForFunction(()=>!tools.previewLoading);
  s=await state();assert.equal(s.cards['A.png'].data.extensions.regex_scripts.find(rule=>rule.id===targetId).replaceString,'右侧编辑后的替换内容');
  const panes=await page.locator('.cla-transfer-pane').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top}}));assert.ok(Math.abs(panes[0].top-panes[1].top)<2&&panes[0].right<=panes[1].left,'source and target stay side by side');
  const bounds=await page.locator('.cla-transfer-tool select,.cla-transfer-actions button:visible').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return[b.left,b.right]}));assert.ok(bounds.every(([left,right])=>left>=0&&right<=(mobile?390:1100)),'tool controls fit viewport');
  await page.screenshot({path:'/private/tmp/cla-transfer-'+(mobile?'touch':'desktop')+'.png'});
  await page.evaluate(()=>{tools.stop();auto.stop()});assert.equal(await page.locator('#cla-transfer-menu,.cla-transfer-tool').count(),0);assert.equal(await page.locator('dialog').count(),0);assert.deepEqual(errors,[]);
  console.log((mobile?'Touch':'Desktop')+': wand entry, cross-pane mouse/touch and batch drag, canceled/outside drops, world copy/move, character/preset regex copies, partial failure, IDs/metadata, layout, startup/key connection, manual cancel and cleanup passed');await page.close();
 }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
