// Optional browser regression against the official PromptManager editor/list.
// CLA_NATIVE_PROMPT_MANAGER and CLA_NATIVE_PROMPT_CSS point to downloaded native
// files; only imports, template rendering, sortable and server writes are mocked.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const native = await readFile(process.env.CLA_NATIVE_PROMPT_MANAGER, 'utf8');
const nativeCss = await readFile(process.env.CLA_NATIVE_PROMPT_CSS, 'utf8');
const source = await readFile(new URL('../modules/preset-entry-actions.js', import.meta.url), 'utf8');
const style = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const theme = process.env.CLA_REGEX_THEME_CSS ? await readFile(process.env.CLA_REGEX_THEME_CSS, 'utf8') : '';
const stub = `
export const DOMPurify={sanitize:x=>x};
export const event_types={}; export const eventSource={on(){}};
export const is_send_press=false, main_api='openai', is_group_generating=false, power_user={};
export const substituteParams=x=>x;
export class Message{} export class MessageCollection{} export class TokenHandler {getCounts(){return {}}}
export const debounce=f=>f; export const waitUntilCondition=async()=>{};
export const escapeHtml=x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
export const uuidv4=()=>crypto.randomUUID(); export const debounce_timeout={relaxed:1};
export const renderTemplateAsync=async name=>name==='promptManagerListHeader'?'<li class="completion_prompt_manager_list_head"><span>名称</span><span></span><span>Token</span></li>':'';
export const Popup={show:{confirm:async()=>window.confirmChoice}};
export const t=(parts,...args)=>parts.reduce((s,p,i)=>s+p+(args[i]??''),'');
export const isMobile=()=>false;
`;
const formFields = {
    name: '<input>', role: '<select><option>system</option><option>user</option><option>assistant</option></select>', prompt: '<textarea></textarea>',
    injection_position: '<select><option value="0">相对</option><option value="1">深度</option></select>', injection_depth: '<input type="number">',
    injection_order: '<input type="number">', injection_trigger: '<select multiple><option value="normal">normal</option></select>', forbid_overrides: '<input type="checkbox">',
};
const fields = Object.entries(formFields).map(([name, html]) => html.replace('>', ` id="completion_prompt_manager_popup_entry_form_${name}">`)).join('');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/native.css"><link rel="stylesheet" href="/style.css"><style>${theme}
*{box-sizing:border-box}body{margin:8px;font:16px sans-serif;background:#b6a19a;color:#252525;--SmartThemeBodyColor:#252525;--SmartThemeBlurTintColor:#ded0c8;--SmartThemeBorderColor:#777;--mainFontSize:16px}
#completion_prompt_manager{width:100%;max-width:550px}ul{padding:0;list-style:none}button{cursor:pointer}#completion_prompt_manager_popup{display:none;padding:12px;background:#ddd}textarea,input,select{max-width:100%}textarea{display:block;width:100%;height:100px}.menu_button{border:1px solid #888;border-radius:5px;padding:5px}
</style><body class="cla-preset-drag-guard"><div id="completion_prompt_manager"></div><div id="completion_prompt_manager_popup"><div id="completion_prompt_manager_popup_edit">${fields}
<div id="completion_prompt_manager_depth_block"></div><div id="completion_prompt_manager_order_block"></div><div id="completion_prompt_manager_forbid_overrides_block"></div>
<div id="completion_prompt_manager_popup_entry_source_block"><span id="completion_prompt_manager_popup_entry_source"></span></div>
<button id="completion_prompt_manager_popup_entry_form_save">保存</button><button id="completion_prompt_manager_popup_entry_form_reset">重置</button><button id="completion_prompt_manager_popup_entry_form_close">取消</button></div>
<div id="completion_prompt_manager_popup_inspect"><div id="completion_prompt_manager_popup_entry_form_inspect_list"></div></div><button id="completion_prompt_manager_popup_close_button">关闭</button></div>
<input id="openai_max_context" hidden><input id="openai_max_tokens" hidden>
<script type="module">
import {PromptManager} from '/native.js'; import {PresetEntryActions} from '/actions.js';
window.$=selector=>{const element=typeof selector==='string'?document.querySelector(selector):selector;const result={first:()=>result,slideDown:()=>{element.style.display='block';return result},slideUp:()=>{element.style.display='none';return result},addClass:c=>{element.classList.add(c);return result},removeClass:c=>{element.classList.remove(c);return result},sortable:()=>result};return result};
window.confirmChoice=true;window.saves=0;window.confirmations=[];
window.manager=new PromptManager();
const custom={identifier:'custom',name:'身份：强破限 · 很长的自定义预设条目名称',role:'assistant',content:'原始正文',system_prompt:false,marker:false,injection_position:1,injection_depth:3,injection_order:42,injection_trigger:['normal']};
manager.init({prefix:'completion_',containerIdentifier:'completion_prompt_manager',promptOrder:{strategy:'character'}},{prompts:[custom,{identifier:'main',name:'主提示词',system_prompt:true,marker:false,content:'主提示词'},{identifier:'chatHistory',name:'聊天记录',system_prompt:true,marker:true}],prompt_order:[{character_id:1,order:[{identifier:'main',enabled:true},{identifier:'custom',enabled:true},{identifier:'chatHistory',enabled:true}]}]});
manager.activeCharacter={id:1};
manager.renderPromptManager=async()=>{manager.containerElement.innerHTML='<button id="native-new-prompt" title="新提示词">＋</button><ul id="completion_prompt_manager_list"></ul>';manager.listElement=document.querySelector('ul');document.getElementById('native-new-prompt').addEventListener('click',manager.handleNewPrompt)};
manager.saveServiceSettings=async()=>{window.saves++;if(window.failSave)throw Error('offline');localStorage.setItem('preset',JSON.stringify(manager.serviceSettings))};
window.adapter=new PresetEntryActions();
await manager.renderPromptManager();await manager.renderPromptManagerListItems();await adapter.start();window.ready=true;
</script>`;
const assets = new Map([['/native.js', native.replace(/from ['"][^'"]+['"]/g, "from '/stub.js'")], ['/stub.js', stub], ['/actions.js', source], ['/style.css', style], ['/native.css', nativeCss]]);
assets.set('/openai.js', 'export const promptManager=window.manager;');
assets.set('/popup.js', `export const Popup={show:{confirm:async(header,text)=>{const content=header?'<h3>'+header+'</h3>'+text:text;window.confirmations.push(content instanceof HTMLElement?content.textContent:content);return window.confirmChoice?1:0}}};`);
const server = createServer((req, res) => {res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(assets.get(req.url)??html)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
    browser=await chromium.launch({headless:true,...(process.env.CLA_BROWSER_EXECUTABLE?{executablePath:process.env.CLA_BROWSER_EXECUTABLE}:{})});
    for(const mobile of [false,true]) {
        const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1100,height:900},hasTouch:mobile,isMobile:mobile});
        const errors=[];page.on('pageerror',error=>errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready);
        const click=async selector=>mobile?await page.locator(selector).tap():await page.locator(selector).click();
        const menu=async id=>click(`[data-pm-identifier="${id}"] [data-cla-preset-action="menu"]`);
        const save='#completion_prompt_manager_popup_entry_form_save';
        const name='#completion_prompt_manager_popup_entry_form_name';
        assert.equal(await page.locator('.cla-preset-entry-toolbar, [data-cla-preset-action="new"]').count(),0);
        await click('#native-new-prompt');await page.fill(name,'原生新建入口');await click('#completion_prompt_manager_popup_entry_form_close');
        assert.equal(await page.evaluate(()=>window.saves),0);
        await menu('chatHistory');await click('[data-cla-preset-action="after"]');await page.fill(name,'我的新条目');
        await page.fill('#completion_prompt_manager_popup_entry_form_prompt','写预设的内容');await click(save);
        await page.waitForFunction(()=>manager.serviceSettings.prompts.some(p=>p.name==='我的新条目'));
        await page.waitForSelector('[data-pm-identifier]:nth-last-child(1) .cla-preset-entry-more');
        assert.equal(await page.evaluate(()=>manager.serviceSettings.prompt_order[0].order.at(-1).enabled),false);
        await menu('custom');await click('[data-cla-preset-action="copy"]');
        assert.equal(await page.inputValue('#completion_prompt_manager_popup_entry_form_prompt'),'原始正文');
        assert.equal(await page.inputValue('#completion_prompt_manager_popup_entry_form_injection_depth'),'3');
        await page.fill(name,'副本');await click(save);await page.waitForFunction(()=>manager.serviceSettings.prompts.some(p=>p.name==='副本'));
        const copyId=await page.evaluate(()=>manager.serviceSettings.prompts.find(p=>p.name==='副本').identifier);
        await page.waitForSelector(`[data-pm-identifier="${copyId}"]`);
        assert.equal(await page.evaluate(()=>manager.serviceSettings.prompt_order[0].order[2].identifier),copyId);
        await menu('custom');await click('[data-cla-preset-action="before"]');await click('#completion_prompt_manager_popup_entry_form_close');
        assert.equal(await page.evaluate(()=>manager.serviceSettings.prompts.filter(p=>p.name==='新条目').length),0);
        await menu('main');assert.equal(await page.locator('[data-cla-preset-action="delete"]').isDisabled(),true);await page.keyboard.press('Escape');
        await page.evaluate(()=>window.confirmChoice=false);await menu(copyId);await click('[data-cla-preset-action="delete"]');
        assert.equal(await page.evaluate(id=>!!manager.getPromptById(id),copyId),true);
        await page.evaluate(()=>window.confirmChoice=true);await menu(copyId);await click('[data-cla-preset-action="remove"]');
        assert.ok(await page.evaluate(()=>confirmations.at(-1).includes('移出当前列表')&&!confirmations.at(-1).includes('[object')));
        await page.waitForFunction(id=>!manager.serviceSettings.prompt_order[0].order.some(p=>p.identifier===id),copyId);
        assert.equal(await page.evaluate(id=>!!manager.getPromptById(id),copyId),true);
        await page.waitForSelector('[data-pm-identifier="custom"] .cla-preset-entry-more');
        await menu('custom');await click('[data-cla-preset-action="delete"]');await page.waitForFunction(()=>!manager.getPromptById('custom'));
        assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('preset')).prompts.some(p=>p.identifier==='custom')),false);
        await page.waitForSelector('[data-pm-identifier="main"] .cla-preset-entry-more');
        await page.evaluate(()=>window.failSave=true);await menu('main');await click('[data-cla-preset-action="after"]');await page.fill(name,'失败保留草稿');await click(save);
        assert.equal(await page.inputValue(name),'失败保留草稿');assert.equal(await page.evaluate(()=>manager.serviceSettings.prompts.some(p=>p.name==='失败保留草稿')),false);
        await page.evaluate(()=>window.failSave=false);await click(save);await page.waitForFunction(()=>manager.serviceSettings.prompts.some(p=>p.name==='失败保留草稿'));
        await page.waitForSelector('[data-pm-identifier="main"] .cla-preset-entry-more');
        // Reproduce a theme that enlarges all buttons and gives them iOS blue text.
        await page.addStyleTag({content:'.menu_button:not(.cla-preset-entry-more){font:28px/40px sans-serif!important;min-height:60px!important;padding:12px!important;border-radius:22px!important;color:royalblue!important;-webkit-text-fill-color:royalblue!important}'});
        for(const width of mobile ? [260,320,374] : [260,320,390,550]) {
            await page.evaluate(width=>manager.containerElement.style.width=width+'px',width);
            await menu('main');
            const bounds=await page.evaluate(()=>{const menu=document.querySelector('.cla-preset-entry-menu').getBoundingClientRect();const row=document.querySelector('[data-pm-identifier="main"]');const controls=row.querySelector('.prompt_manager_prompt_controls').getBoundingClientRect();const token=row.querySelector('.prompt_manager_prompt_tokens').getBoundingClientRect();const name=row.querySelector('.completion_prompt_manager_prompt_name').getBoundingClientRect();return {menuLeft:menu.left,menuRight:menu.right,viewport:innerWidth,overlap:controls.right>token.left+1||name.right>controls.left+1}});
            assert.ok(bounds.menuLeft>=0&&bounds.menuRight<=bounds.viewport);assert.equal(bounds.overlap,false,JSON.stringify({width,...bounds}));
            const compact=await page.evaluate(()=>{const menu=document.querySelector('.cla-preset-entry-menu');const button=menu.querySelector('button');const rect=menu.getBoundingClientRect();const css=getComputedStyle(button);return {width:rect.width,height:rect.height,font:parseFloat(css.fontSize),color:css.color,fill:css.webkitTextFillColor};});
            assert.ok(compact.width<=140&&compact.height<=165&&compact.font<=13,JSON.stringify(compact));
            assert.equal(compact.color,'rgb(0, 0, 0)');assert.equal(compact.fill,'rgb(0, 0, 0)');
            await page.keyboard.press('Escape');
        }
        await page.evaluate(()=>manager.containerElement.style.width='100%');await menu('main');
        await page.screenshot({path:`/private/tmp/cla-preset-entries-${mobile?'390':'1100'}.png`});
        await page.evaluate(()=>adapter.stop());assert.equal(await page.locator('[data-cla-preset-action]').count(),0);
        await page.locator('[data-pm-identifier="main"] .prompt-manager-edit-action').click();
        assert.equal(await page.inputValue(name),'主提示词');
        assert.deepEqual(errors,[]);console.log(`${mobile?'Touch':'Desktop'}: native editor/list create, cancel, copy, insertion, remove/delete, confirmation, persistence, failure retry, protected prompts, layout and cleanup passed`);
        await page.close();
    }
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
