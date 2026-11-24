// Focused UI regression. Optional private preset stays local and is never committed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const files = ['preset-entry-actions', 'preset-entry-groups', 'preset-entry-selection', 'preset-folder-model', 'preset-folder-suggestions', 'preset-section-boundaries'];
const assets = new Map(await Promise.all(files.map(async file => [`/modules/${file}.js`, await readFile(new URL(`../modules/${file}.js`, import.meta.url), 'utf8')])));
assets.set('/style.css', await readFile(new URL('../style.css', import.meta.url), 'utf8'));
assets.set('/native.css', process.env.CLA_NATIVE_PROMPT_CSS ? await readFile(process.env.CLA_NATIVE_PROMPT_CSS, 'utf8') : '.drag-handle{position:absolute}');
const fallback = { prompts: [{ identifier: 'a', name: 'Identity', content: 'Maintain the original identity.', system_prompt: false }, { identifier: 'b', name: 'Tone', content: 'Use an overall atmosphere of comedy with a consistent emotional intensity.', system_prompt: false }, { identifier: 'history', name: 'History', content: '', system_prompt: true, marker: true }], prompt_order: [{ character_id: 1, order: [{ identifier: 'a', enabled: false }, { identifier: 'b', enabled: true }, { identifier: 'history', enabled: true }] }] };
assets.set('/fixture.json', process.env.CLA_PRESET_FIXTURE ? await readFile(process.env.CLA_PRESET_FIXTURE, 'utf8') : JSON.stringify(fallback));
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/native.css"><link rel="stylesheet" href="/style.css"><style>
*{box-sizing:border-box}body{margin:12px;background:#f5f5ec;color:#3d5d50;font:15px sans-serif;--SmartThemeBodyColor:#3d5d50;--SmartThemeBorderColor:#bacaba;--SmartThemeQuoteColor:#698875;--SmartThemeBlurTintColor:#f5f5ec}
#completion_prompt_manager{max-width:550px}ul{list-style:none;padding:0}li[data-pm-identifier]{display:grid;grid-template-columns:1fr auto auto;gap:5px;align-items:center;min-height:50px;margin:7px 0;padding:7px;border:1px solid #cdd6c9;border-radius:9px}
#completion_prompt_manager_list li:not([data-pm-identifier]){display:grid;min-height:80px;gap:24px}#completion_prompt_manager_list li button{min-width:120px;width:45%;min-height:48px;margin:10px;padding:12px;white-space:normal}
.completion_prompt_manager_prompt_name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.prompt_manager_prompt_controls{display:flex;gap:7px}.menu_button{border:1px solid #bbc9bb;border-radius:6px;background:#fafbf7;color:inherit;cursor:pointer}.text_pole{padding:6px;background:#fafbf7;color:inherit;border:1px solid #bbc9bb;border-radius:6px}small{line-height:1.5}
.fa-ellipsis::before{content:'⋯'}.fa-folder::before{content:'▱'}.fa-pencil::before{content:'✎'}.fa-toggle-off::before{content:'◉'}.fa-toggle-on::before{content:'●'}
</style><body class="cla-preset-drag-guard"><div id="completion_prompt_manager"><div id="native-heading">提示词 <small style="float:right">总 Token 数量：原生统计</small></div><ul id="completion_prompt_manager_list"></ul></div><script type="module">
import {PresetEntryActions} from '/modules/preset-entry-actions.js';
const fixture=await fetch('/fixture.json').then(r=>r.json());
window.settings=JSON.parse(localStorage.getItem('folders')||'{}');window.presetName='A';window.nativeSaves=0;window.settingsSaves=0;window.nativeClicks=0;window.edits=0;window.confirmChoice=true;window.warnings=[];window.toastr={warning:x=>warnings.push(x),error:x=>warnings.push(x),info:x=>warnings.push(x)};
const holder=fixture.prompt_order.find(h=>h.order?.length);window.orderId=holder.character_id;
window.manager={serviceSettings:fixture,activeCharacter:{id:holder.character_id},configuration:{prefix:'completion_'},containerElement:document.querySelector('#completion_prompt_manager'),listElement:document.querySelector('ul'),
getPromptById(id){return this.serviceSettings.prompts.find(p=>p.identifier===id)},getPromptOrderForCharacter(){return this.serviceSettings.prompt_order.find(h=>h.character_id===window.orderId).order},
async renderPromptManagerListItems(){this.listElement.replaceChildren();for(const item of this.getPromptOrderForCharacter()){const prompt=this.getPromptById(item.identifier);if(!prompt)continue;const row=document.createElement('li');row.className='completion_prompt_manager_prompt completion_prompt_manager_prompt_draggable';row.dataset.pmIdentifier=prompt.identifier;const drag=document.createElement('span');drag.className='drag-handle';drag.textContent='☰';const name=document.createElement('span');name.className='completion_prompt_manager_prompt_name';const link=document.createElement('a');link.className='prompt-manager-inspect-action';link.textContent=prompt.name;link.addEventListener('click',()=>nativeClicks++);name.append(link);const controls=document.createElement('span');controls.className='prompt_manager_prompt_controls';const edit=document.createElement('span');edit.className='prompt-manager-edit-action fa-pencil';edit.addEventListener('click',()=>edits++);const toggle=document.createElement('span');toggle.className='prompt-manager-toggle-action '+(item.enabled?'fa-toggle-on':'fa-toggle-off');toggle.addEventListener('click',()=>{item.enabled=!item.enabled;nativeSaves++;this.render()});controls.append(edit,toggle);const wrap=document.createElement('span');wrap.append(controls);const tokens=document.createElement('span');tokens.className='prompt_manager_prompt_tokens';tokens.textContent='10';row.append(drag,name,wrap,tokens);this.listElement.append(row)}},
loadPromptIntoEditForm(){},updatePromptWithPromptEditForm(){},saveServiceSettings:async()=>{window.nativeSaves++},getUuidv4:()=>crypto.randomUUID(),clearEditForm(){},clearInspectForm(){},showPopup(){},hidePopup(){},render(){return this.renderPromptManagerListItems()},isPromptDeletionAllowed:p=>p.system_prompt===false&&!p.marker,isPromptToggleAllowed:p=>!p.marker,tokenHandler:{getCounts:()=>({})}};
window.sortable={options:{cancel:'input,button'},option(key,value){this.options[key]=value}};window.$=()=>({sortable:()=>window.sortable});$.fn={sortable(){}};
window.handlers=new Map();const eventSource={on:(name,cb)=>handlers.set(name,cb),removeListener:name=>handlers.delete(name)};
window.adapter=new PresetEntryActions({extensionSettings:settings,saveSettings:()=>{settingsSaves++;localStorage.setItem('folders',JSON.stringify(settings))},eventSource,eventTypes:{OAI_PRESET_IMPORT_READY:'import',OAI_PRESET_CHANGED_BEFORE:'switch'},loadApi:async()=>({manager,getPresetName:()=>presetName,confirm:async()=>confirmChoice})});
await manager.renderPromptManagerListItems();await adapter.start();window.snapshot=JSON.stringify(manager.serviceSettings);window.ready=true;
</script>`;
const server = createServer((req, res) => { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.json') ? 'application/json' : 'text/html'); res.end(assets.get(req.url) ?? html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await chromium.launch({ headless: true, ...(process.env.CLA_BROWSER_EXECUTABLE ? { executablePath: process.env.CLA_BROWSER_EXECUTABLE } : {}) });
    for (const mobile of process.env.CLA_MOBILE_ONLY ? [true] : [false, true]) {
        const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1100, height: 950 }, isMobile: mobile, hasTouch: mobile });
        await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.ready);
        const click = locator => mobile ? locator.tap() : locator.click();
        const root = page.locator('.cla-preset-groups'), rows = page.locator('[data-pm-identifier]');
        const ids = await rows.evaluateAll(nodes => nodes.map(node => node.dataset.pmIdentifier));
        // Attribute selectors use only identifiers obtained from this native list.
        const entry = id => page.locator(`[data-pm-identifier=${JSON.stringify(id)}]`);
        assert.equal(await page.locator('input[type=checkbox]').count(), 0);
        await click(entry(ids[0]).locator('.completion_prompt_manager_prompt_name a')); assert.equal(await page.evaluate(()=>nativeClicks), 1);
        await click(entry(ids[0]).locator('.prompt-manager-edit-action')); assert.equal(await page.evaluate(()=>edits), 1);
        await click(root.locator('summary', { hasText: '条目分组与文件夹设置' }));
        await click(root.getByRole('button', {name:'新建文件夹',exact:true}));
        await page.getByRole('textbox',{name:'新文件夹名称',exact:true}).fill('资料'); await click(page.getByRole('button',{name:'保存',exact:true}));
        const folder = name => page.locator('.cla-preset-fold-header').filter({has:page.locator('.cla-preset-fold-name',{hasText:new RegExp('^'+name+'$')})});
        await click(folder('资料').getByRole('button',{name:'更多：资料',exact:true})); await click(page.getByRole('button',{name:'新建子文件夹…',exact:true}));
        await page.getByRole('textbox',{name:'新文件夹名称',exact:true}).fill('子目录'); await click(page.getByRole('button',{name:'保存',exact:true}));
        await click(root.locator('summary', { hasText: '条目分组与文件夹设置' }));
        const name = entry(ids[0]).locator('.completion_prompt_manager_prompt_name'), bounds = await name.boundingBox();
        if (mobile) {
            const session = await page.context().newCDPSession(page), point={x:bounds.x+Math.min(30,bounds.width/2),y:bounds.y+bounds.height/2};
            await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
            await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x,y:point.y+24}]});
            await session.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
            assert.equal(await page.locator('.cla-preset-bulk-toolbar').count(),0,'scroll/cancel does not enter selection');
            await name.scrollIntoViewIfNeeded(); const current = await name.boundingBox(); point.x = current.x + Math.min(30,current.width/2); point.y = current.y + current.height/2;
            await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]}); await new Promise(resolve=>setTimeout(resolve,550));
            await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await session.detach();
        } else { await page.mouse.move(bounds.x+20,bounds.y+bounds.height/2); await page.mouse.down(); await new Promise(resolve=>setTimeout(resolve,550)); await page.mouse.up(); }
        const toolbar=page.getByRole('toolbar',{name:'预设条目批量编辑'}); assert.equal(await toolbar.count(),1);
        assert.equal(await page.locator('.cla-preset-entry-selected').count(),1); assert.equal(await page.evaluate(()=>nativeClicks),1);
        await click(entry(ids[1]).locator('.completion_prompt_manager_prompt_name')); assert.equal(await page.locator('.cla-preset-entry-selected').count(),2);
        await click(toolbar.getByRole('button',{name:'移动到分类',exact:true})); await click(page.getByRole('menuitem',{name:'资料 / 子目录',exact:true}));
        assert.equal(await toolbar.count(),0); assert.equal(await folder('子目录').count(),1);
        assert.equal(await page.evaluate(()=>JSON.stringify(manager.serviceSettings)===snapshot),true); assert.equal(await page.evaluate(()=>nativeSaves),0);
        const geometry=await folder('子目录').evaluate(node=>{const rect=node.getBoundingClientRect();const buttons=[...node.querySelectorAll('button')].map(x=>x.getBoundingClientRect());return {height:rect.height,ys:buttons.map(x=>x.top+x.height/2),width:document.documentElement.scrollWidth,viewport:innerWidth}});
        assert.ok(geometry.height<=48 && Math.max(...geometry.ys)-Math.min(...geometry.ys)<4 && geometry.width<=geometry.viewport,JSON.stringify(geometry));
        await click(folder('子目录').getByRole('button',{name:'折叠文件夹：子目录',exact:true})); assert.equal(await entry(ids[0]).isVisible(),false);
        await click(folder('子目录').getByRole('button',{name:'展开文件夹：子目录',exact:true}));
        await root.getByRole('searchbox',{name:'搜索名称或内容'}).fill(await entry(ids[0]).locator('.completion_prompt_manager_prompt_name').innerText());
        assert.equal(await entry(ids[0]).isVisible(),true); assert.equal(await folder('资料').isVisible(),true,'search preserves folder path');
        await root.getByRole('searchbox',{name:'搜索名称或内容'}).fill('');
        await root.getByRole('combobox',{name:'条目筛选'}).selectOption('ungrouped'); assert.equal(await entry(ids[0]).isVisible(),false);
        await root.getByRole('combobox',{name:'条目筛选'}).selectOption('all');
        await click(root.getByRole('button',{name:'原始顺序',exact:true}));
        assert.equal(await page.locator('.cla-preset-fold-header').count(),0); assert.equal(await page.evaluate(()=>sortable.options.cancel),'input,button');
        assert.deepEqual(await rows.filter({visible:true}).evaluateAll(nodes=>nodes.map(node=>node.dataset.pmIdentifier)),ids);
        await click(root.getByRole('button',{name:'分类浏览',exact:true}));
        await page.reload(); await page.waitForFunction(()=>window.ready); assert.equal(await folder('子目录').count(),1);
        await click(folder('子目录').getByRole('button',{name:'更多：子目录',exact:true})); await click(page.getByRole('button',{name:'删除文件夹…',exact:true}));
        await page.waitForFunction(()=>!document.querySelector('[title="资料 / 子目录"]'));
        assert.equal(await folder('子目录').count(),0); assert.equal(await rows.count(),ids.length);
        assert.equal(await page.evaluate(()=>JSON.stringify(manager.serviceSettings)===snapshot),true);
        // Ctrl/Cmd and bulk switches use the native writer once, skipping protected markers.
        await entry(ids[0]).locator('.completion_prompt_manager_prompt_name').click({modifiers:['Control']});
        await click(entry(ids[1]).locator('.completion_prompt_manager_prompt_name'));
        await click(toolbar.getByRole('button',{name:'启用',exact:true})); await page.waitForFunction(()=>!document.querySelector('.cla-preset-bulk-toolbar'));
        assert.equal(await page.evaluate(()=>nativeSaves),1,'one native save for the explicit bulk state change');
        assert.deepEqual(await page.evaluate(()=>manager.getPromptOrderForCharacter().map(item=>item.identifier)),ids);
        await page.screenshot({path:`/private/tmp/cla-folder-manager-${mobile?'mobile':'desktop'}.png`});
        await page.evaluate(async()=>{presetName='B';await manager.renderPromptManagerListItems()}); assert.equal(await folder('资料').count(),0);
        await page.evaluate(async()=>{presetName='A';await manager.renderPromptManagerListItems()}); assert.equal(await folder('资料').count(),1);
        await page.evaluate(()=>adapter.stop()); assert.equal(await page.locator('.cla-preset-fold-header').count(),0);
        assert.equal(await page.evaluate(()=>sortable.options.cancel),'input,button'); assert.equal(await page.evaluate(()=>handlers.size),0);
        assert.deepEqual(errors,[]); console.log(`Folder manager ${mobile?'mobile':'desktop'}: ${ids.length} native rows, selection, nesting, persistence and order checks passed`); await page.close();
    }
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
