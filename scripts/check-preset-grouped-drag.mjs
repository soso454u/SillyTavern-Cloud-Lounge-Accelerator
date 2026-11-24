// Focused drag check with the real native jQuery UI/Touch Punch and prompt CSS.
// CLA_SILLYTAVERN_PUBLIC=/path/to/public NODE_PATH=/path/to/node_modules node scripts/check-preset-grouped-drag.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const nativeRoot = process.env.CLA_SILLYTAVERN_PUBLIC;
assert.ok(nativeRoot, 'Set CLA_SILLYTAVERN_PUBLIC');
const sources = new Map();
for (const file of ['lib/jquery-3.5.1.min.js', 'lib/jquery-ui.min.js', 'lib/jquery.ui.touch-punch.min.js', 'css/promptmanager.css']) {
    sources.set(`/${file}`, await readFile(path.join(nativeRoot, file), 'utf8'));
}
for (const file of ['style.css', ...['preset-entry-actions', 'preset-entry-groups', 'preset-grouped-drag', 'preset-entry-selection', 'preset-scroll-anchor', 'preset-folder-model', 'preset-section-boundaries'].map(name => `modules/${name}.js`)]) {
    sources.set(`/${file}`, await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
}
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/promptmanager.css"><link rel="stylesheet" href="/style.css">
<style>*{box-sizing:border-box}body{font:16px sans-serif;margin:8px}#scroll{height:1000px;overflow:auto}#completion_prompt_manager{max-width:550px}ul{padding:0;margin:0}li[data-pm-identifier]{min-height:32px;background:#eee}</style>
<body class="cla-preset-drag-guard"><div id="completion_prompt_manager"><div id="scroll"><ul id="completion_prompt_manager_list"></ul></div></div>
<script src="/lib/jquery-3.5.1.min.js"></script><script src="/lib/jquery-ui.min.js"></script><script src="/lib/jquery.ui.touch-punch.min.js"></script>
<script type="module">
import {PresetEntryActions} from '/modules/preset-entry-actions.js';
window.actions = new PresetEntryActions(); actions.started = true;
window.list = document.querySelector('ul');
window.saves = 0; window.renders = 0; window.failSave = false;
const prompts = Array.from({length:240}, (_,i) => ({identifier:'n'+i,name:({1:'↓Outer↓',20:'↓Inner↓',40:'↑Inner↑',120:'↑Outer↑',130:'↓Next↓',200:'↑Next↑'})[i] || String.fromCharCode(0x4e00+i)+' item',content:'content '+i}));
actions.manager = {listElement:list,activeCharacter:{id:1},serviceSettings:{prompts,prompt_order:[{character_id:1,order:prompts.map(p=>({identifier:p.identifier,enabled:!p.identifier.endsWith('2')}))}]},
    async saveServiceSettings(){ window.saves++; if(window.failSave) throw Error('offline'); },
    render(){ window.renders++; draw(); }};
actions.groups.getPresetName = () => 'drag fixture';
window.order = () => actions.context().order.map(p=>p.identifier);
window.draw = () => {
    if($(list).sortable('instance')) $(list).sortable('destroy');
    list.innerHTML = order().map(id => '<li class="completion_prompt_manager_prompt completion_prompt_manager_prompt_draggable" data-pm-identifier="'+id+'"><span class="drag-handle">☰</span><span class="completion_prompt_manager_prompt_name">'+prompts.find(p=>p.identifier===id).name+'</span><span class="prompt_manager_prompt_controls"></span><span class="prompt_manager_prompt_tokens">1</span></li>').join('');
    $(list).sortable({handle:'.drag-handle',delay:150,distance:10,items:'.completion_prompt_manager_prompt_draggable',update(){
        const context=actions.context(), byId=new Map(context.order.map(p=>[p.identifier,p]));
        context.holder.order=$(list).sortable('toArray',{attribute:'data-pm-identifier'}).map(id=>byId.get(id));
        actions.manager.saveServiceSettings();
    }});
    actions.decorate();
};
draw(); window.ready = true;
</script>`;
const server = createServer((request, response) => {
    const body = sources.get(request.url);
    response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : request.url.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(body ?? html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await chromium.launch({ headless: true, ...(process.env.CLA_BROWSER_EXECUTABLE ? { executablePath: process.env.CLA_BROWSER_EXECUTABLE } : {}) });
    for (const mobile of [false, true]) {
        const page = await browser.newPage({ viewport: mobile ? {width:390,height:1400} : {width:1000,height:1400}, isMobile:mobile, hasTouch:mobile });
        page.setDefaultTimeout(5000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.ready);
        const cdp = await page.context().newCDPSession(page);
        const row = id => page.locator(`[data-pm-identifier="${id}"] > .drag-handle`);
        const folder = name => page.locator('.cla-preset-fold-header').filter({has:page.getByText(name,{exact:true})});
        const box = async locator => { await locator.scrollIntoViewIfNeeded(); return locator.boundingBox(); };
        const point = (rect, bottom = false) => ({x:rect.x+rect.width/2,y:rect.y+(bottom ? rect.height-4 : 4)});
        const down = async p => {
            if(mobile) await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});
            else {await page.mouse.move(p.x,p.y);await page.mouse.down();}
        };
        const move = async p => {
            if(mobile) await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[p]});
            else await page.mouse.move(p.x,p.y);
        };
        const up = async () => {
            if(mobile) await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
            else await page.mouse.up();
            await page.waitForTimeout(60);
        };
        const drag = async (from, to, hold = 180, bottom = false) => {
            const a = await box(from), b = await box(to);
            await down(point(a)); await page.waitForTimeout(hold); await move(point(b,bottom)); await page.waitForTimeout(20);
            await up();
        };
        const initial = await page.evaluate(() => order());
        const data = await page.evaluate(() => JSON.stringify(actions.context().prompts));
        assert.equal(await folder('Outer').count(),1);
        // Single item crosses a folded 120-row section, keeping all hidden rows.
        await drag(row('n0'), folder('Outer'), 180, true);
        assert.deepEqual(await page.evaluate(() => order()), [...initial.slice(1,121),'n0',...initial.slice(121)]);
        assert.deepEqual(await page.evaluate(() => [saves,renders]), [1,1]);
        // Multi-selection moves as one transaction, preserving native item objects.
        await page.evaluate(() => { actions.selection.enter(); actions.selection.selected = new Set(['n121','n125']); actions.selection.render(); });
        await drag(row('n121'), folder('Outer'));
        assert.deepEqual((await page.evaluate(() => order())).slice(0,3), ['n121','n125','n1']);
        assert.deepEqual(await page.evaluate(() => [saves,renders,actions.selection.mode]), [2,2,false]);
        // An entire folded section, including its nested group, moves together.
        await drag(folder('Outer'), folder('Next'), 440, true);
        const moved = await page.evaluate(() => order());
        assert.deepEqual(moved.slice(moved.indexOf('n200')+1,moved.indexOf('n200')+121), initial.slice(1,121));
        assert.deepEqual(await page.evaluate(() => [saves,renders]), [3,3]);
        // Burst input must not measure/reorder all 240 rows between frames.
        await page.evaluate(() => { document.querySelector('#scroll').scrollTop=0; });
        const a = await box(row('n121')), b = await box(row('n125'));
        await down(point(a)); await page.waitForTimeout(180); await move(point(b,true)); await page.waitForTimeout(20);
        const perf = await page.evaluate(async () => {
            const controller=actions.groups.groupedDrag, state=controller.state;
            if(!state?.active) throw Error('drag did not activate');
            let reads=0, mutations=0;
            const original=Element.prototype.getBoundingClientRect;
            Element.prototype.getBoundingClientRect=function(){reads++;return original.call(this)};
            const observer=new MutationObserver(records=>mutations+=records.length); observer.observe(list,{childList:true,subtree:true});
            try {
                for(let i=0;i<80;i++) document.dispatchEvent(new PointerEvent('pointermove',{pointerId:state.pointer,clientX:state.x,clientY:state.y,cancelable:true}));
                const immediate=reads;
                await new Promise(resolve=>requestAnimationFrame(resolve));
                return {immediate,reads,mutations,saves};
            } finally { observer.disconnect();Element.prototype.getBoundingClientRect=original; }
        });
        assert.equal(perf.immediate,0); assert.ok(perf.reads<=3,JSON.stringify(perf)); assert.equal(perf.mutations,0); assert.equal(perf.saves,3);
        // Edge scrolling continues while the pointer is stationary.
        const edge = await page.locator('#scroll').boundingBox();
        await move({x:edge.x+80,y:edge.y+edge.height-8}); await page.waitForTimeout(100);
        const scroll = await page.evaluate(() => document.querySelector('#scroll').scrollTop);
        await page.waitForTimeout(100);
        assert.ok(scroll>0 && await page.evaluate(() => document.querySelector('#scroll').scrollTop)>scroll);
        // Cancellation leaves order unchanged and removes the indicator.
        await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointercancel',{pointerId:actions.groups.groupedDrag.state.pointer}))); await up();
        assert.deepEqual(await page.evaluate(() => order()), moved);
        assert.equal(await page.locator('.cla-preset-drop-line').count(),0);
        // Failed save rolls back the exact native order without rebuilding the list.
        await page.evaluate(() => { window.failSave=true; });
        await drag(row('n121'), row('n125'),180,true);
        assert.deepEqual(await page.evaluate(() => order()), moved);
        assert.deepEqual(await page.evaluate(() => [saves,renders]), [4,3]);
        await page.evaluate(() => { window.failSave=false; });
        // Original-order view still uses the native jQuery UI update callback.
        await page.evaluate(() => { actions.groups.rawOrder=true; actions.groups.render();document.querySelector('#scroll').scrollTop=0; });
        await drag(row('n121'),row('n0'),180,true);
        assert.notDeepEqual(await page.evaluate(() => order()),moved);
        assert.equal(await page.evaluate(() => saves),5);
        // Expanded groups use the same path, preserving nested folder boundaries.
        await page.evaluate(() => {
            const g=actions.groups; g.rawOrder=false;g.render();
            g.setFold(g.context(),[...g.folderNodes.keys()],false);
        });
        await drag(row('n2'),row('n4'),180,true);
        const expanded = await page.evaluate(() => order());
        assert.equal(expanded.indexOf('n2'),expanded.indexOf('n4')+1);
        assert.equal(await page.evaluate(() => saves),6);
        assert.equal(await page.evaluate(() => JSON.stringify(actions.context().prompts)),data);
        assert.equal(new Set(await page.evaluate(() => order())).size,240);
        assert.deepEqual(errors,[]);
        console.log(`${mobile?'Touch':'Desktop'}: 240 rows; single/multi/folder moves save once; nested/folded/expanded rows preserved; 80 moves coalesced (${perf.reads} geometry reads, no row mutations); stationary edge scrolling, cancel, failed-save rollback and native raw sorting passed.`);
        await page.close();
    }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
