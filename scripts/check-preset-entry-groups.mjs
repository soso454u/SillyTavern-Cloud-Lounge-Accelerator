// Targeted optional UI smoke check; use the existing Playwright installation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const assets = new Map(await Promise.all(['modules/preset-entry-actions.js', 'modules/preset-entry-groups.js', 'style.css']
    .map(async file => [`/${file}`, await readFile(new URL(`../${file}`, import.meta.url), 'utf8')])));
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/style.css"><style>
*{box-sizing:border-box}body{margin:12px;background:#f4f5ed;color:#3d5d50;font:15px sans-serif;--SmartThemeBodyColor:#3d5d50;--SmartThemeBorderColor:#bbc9bb;--SmartThemeQuoteColor:#dce6d7}
#completion_prompt_manager{max-width:550px}ul{padding:0;list-style:none}li{display:grid;grid-template-columns:minmax(0,1fr) auto auto;padding:8px 0;gap:8px}
.fa-ellipsis::before{content:'⋯'}.fa-plus::before{content:'+'}.fa-pencil::before{content:'✎'}.fa-trash-can::before{content:'⌫'}
.completion_prompt_manager_prompt_name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.menu_button{border:1px solid #bbc9bb;border-radius:6px;background:#fafbf7;color:inherit;cursor:pointer}.text_pole{padding:6px;background:#fafbf7;color:inherit;border:1px solid #bbc9bb;border-radius:6px}small{line-height:1.5}
</style><div id="completion_prompt_manager"><div id="native-heading">提示词 <small style="float:right">总 Token 数量：50</small></div><ul id="completion_prompt_manager_list"></ul></div>
<script type="module">
import {PresetEntryActions} from '/modules/preset-entry-actions.js';
window.settings={};window.presetName='A';window.saves=0;window.nativeClicks=0;
const prompts=[{identifier:'head',name:'====↓[文风]',system_prompt:false},{identifier:'a',name:'很长的描写条目名称',content:'内容',system_prompt:false},{identifier:'tail',name:'====↑[文风]',system_prompt:false},{identifier:'b',name:'普通规则',content:'规则',system_prompt:false},{identifier:'c',name:'身份：角色',system_prompt:true}];
window.manager={serviceSettings:{prompts,prompt_order:[{character_id:1,order:prompts.map(p=>({identifier:p.identifier,enabled:true}))}]},activeCharacter:{id:1},configuration:{prefix:'completion_'},containerElement:document.querySelector('#completion_prompt_manager'),listElement:document.querySelector('ul'),
async renderPromptManagerListItems(){this.listElement.replaceChildren();for(const prompt of this.serviceSettings.prompts){const row=document.createElement('li');row.className='completion_prompt_manager_prompt completion_prompt_manager_prompt_draggable';row.dataset.pmIdentifier=prompt.identifier;for(const cls of ['completion_prompt_manager_prompt_name','prompt_manager_prompt_controls','prompt_manager_prompt_tokens']){const span=document.createElement('span');span.className=cls;span.textContent=cls.endsWith('_name')?prompt.name:cls.endsWith('_tokens')?'10':'⋯';row.append(span);}row.querySelector('.completion_prompt_manager_prompt_name').addEventListener('click',()=>window.nativeClicks++);this.listElement.append(row);}},
getPromptById:id=>manager.serviceSettings.prompts.find(p=>p.identifier===id),getPromptOrderForCharacter(){return this.serviceSettings.prompt_order[0].order},loadPromptIntoEditForm(){},updatePromptWithPromptEditForm(){},saveServiceSettings(){throw Error('native preset must not be written')},getUuidv4(){},clearEditForm(){},clearInspectForm(){},showPopup(){},hidePopup(){},render(){return this.renderPromptManagerListItems()}};
window.sortable={options:{cancel:'input,button'},option(key,value){this.options[key]=value}};window.$=()=>({sortable:()=>window.sortable});$.fn={sortable(){}};
window.adapter=new PresetEntryActions({extensionSettings:window.settings,saveSettings:()=>window.saves++,loadApi:async()=>({manager,getPresetName:()=>window.presetName,confirm:async()=>true})});
await manager.renderPromptManagerListItems();await adapter.start();window.snapshot=JSON.stringify(manager.serviceSettings);window.ready=true;
</script>`;
const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(assets.get(req.url) ?? html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await chromium.launch({ headless: true, ...(process.env.CLA_BROWSER_EXECUTABLE ? { executablePath: process.env.CLA_BROWSER_EXECUTABLE } : {}) });
    for (const mobile of [false, true]) {
        const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1100, height: 950 }, hasTouch: mobile, isMobile: mobile });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.ready);
        const click = async locator => mobile ? locator.tap() : locator.click();
        const root = page.locator('.cla-preset-groups');
        const group = name => page.locator('.cla-preset-fold-header').filter({ has: page.locator('.cla-preset-fold-name', { hasText: new RegExp('^' + name + '$') }) });
        const rows = page.locator('[data-pm-identifier]');
        const originalDomOrder = await rows.evaluateAll(nodes => nodes.map(node => node.dataset.pmIdentifier));
        assert.equal(await page.locator('input[type="checkbox"]').count(), 0);
        assert.equal(await root.getAttribute('open'), null);
        assert.equal(await root.evaluate(node => node.nextElementSibling.id), 'native-heading');
        assert.equal(await page.evaluate(() => sortable.options.cancel), '*');
        assert.equal(await group('文风').getByRole('button', { name: '文风，3 条', exact: true }).getAttribute('aria-expanded'), 'false');
        assert.equal(await rows.filter({ visible: true }).count(), 1);
        await click(group('文风').getByRole('button', { name: '文风，3 条', exact: true }));
        assert.equal(await rows.filter({ visible: true }).count(), 4);
        await click(group('未分类').getByRole('button', { name: '新建分组', exact: true }));
        await group('未分类').getByRole('textbox', { name: '新分组名称', exact: true }).fill('我的分类');
        await click(group('未分类').getByRole('button', { name: '保存', exact: true }));
        assert.equal(await group('我的分类').count(), 1);
        await click(page.locator('[data-pm-identifier="b"] .cla-preset-entry-more'));
        await click(page.getByRole('menuitem', { name: '归入分组…', exact: true }));
        await click(page.getByRole('menuitem', { name: '我的分类', exact: true }));
        assert.equal(await group('我的分类').getByRole('button', { name: '我的分类，1 条', exact: true }).count(), 1);
        await click(group('我的分类').getByRole('button', { name: '重命名分组', exact: true }));
        await group('我的分类').getByRole('textbox', { name: '分组新名称', exact: true }).fill('自定义');
        await click(group('我的分类').getByRole('button', { name: '保存', exact: true }));
        const source = await group('自定义').locator('.cla-preset-fold-drag').boundingBox();
        const target = await group('文风').boundingBox();
        const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
        const end = { x: target.x + 60, y: target.y + 4 };
        if (mobile) {
            const session = await page.context().newCDPSession(page);
            await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
            await new Promise(resolve => setTimeout(resolve, 180));
            await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
            await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await session.detach();
        } else {
            await page.mouse.move(start.x, start.y); await page.mouse.down();
            await new Promise(resolve => setTimeout(resolve, 180));
            await page.mouse.move(end.x, end.y, { steps: 5 }); await page.mouse.up();
        }
        const visualOrder = await page.locator('.cla-preset-fold-header').evaluateAll(nodes => nodes.sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top).map(node=>node.dataset.claPresetGroup));
        assert.equal(visualOrder[0], '自定义');
        assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.dataset.pmIdentifier)), originalDomOrder);
        await page.screenshot({ path: `/private/tmp/cla-preset-folds-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
        await click(root.locator(':scope > summary'));
        await click(root.getByRole('button', { name: '全部收起', exact: true }));
        assert.equal(await rows.filter({ visible: true }).count(), 0);
        await click(root.getByRole('button', { name: '全部展开', exact: true }));
        assert.equal(await rows.filter({ visible: true }).count(), 5);
        const layout = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
        assert.ok(layout.page <= layout.viewport, JSON.stringify(layout));
        assert.ok(await root.evaluate(node => node.offsetHeight <= 260), 'settings stay compact');
        await click(root.getByRole('button', { name: '原始顺序', exact: true }));
        assert.equal(await page.locator('.cla-preset-fold-header').count(), 0);
        assert.equal(await page.evaluate(() => sortable.options.cancel), 'input,button');
        await click(root.getByRole('button', { name: '返回分组', exact: true }));
        await page.evaluate(async () => { window.presetName = 'B'; await manager.renderPromptManagerListItems(); });
        assert.equal(await group('自定义').count(), 0);
        await page.evaluate(async () => { window.presetName = 'A'; await manager.renderPromptManagerListItems(); });
        assert.equal(await group('自定义').count(), 1);
        await page.evaluate(() => adapter.stop());
        assert.equal(await rows.filter({ visible: true }).count(), 5);
        assert.equal(await root.count(), 0); assert.equal(await page.locator('.cla-preset-fold-header').count(), 0);
        assert.equal(await page.evaluate(() => sortable.options.cancel), 'input,button');
        assert.equal(await page.evaluate(() => JSON.stringify(manager.serviceSettings) === snapshot), true);
        assert.deepEqual(errors, []);
        console.log(`Preset grouping ${mobile ? 'mobile' : 'desktop'} smoke passed`);
        await page.close();
    }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
