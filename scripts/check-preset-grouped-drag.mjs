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
const theme = process.env.CLA_PRESET_THEME_CSS ? await readFile(process.env.CLA_PRESET_THEME_CSS,'utf8') : null;
const sources = new Map();
for (const file of ['lib/jquery-3.5.1.min.js', 'lib/jquery-ui.min.js', 'lib/jquery.ui.touch-punch.min.js', 'css/promptmanager.css']) {
    sources.set(`/${file}`, await readFile(path.join(nativeRoot, file), 'utf8'));
}
const nativeManager = await readFile(path.join(nativeRoot,'scripts/PromptManager.js'),'utf8');
const methodStart = nativeManager.indexOf('    makeDraggable() {');
assert.ok(methodStart>=0);
const method = nativeManager.slice(methodStart,nativeManager.indexOf('\n    }',methodStart)+6).trim();
sources.set('/native-sortable.js', `const isMobile=()=>matchMedia('(pointer:coarse)').matches;export function ${method}`);
for (const file of ['style.css', ...['preset-drag-guard', 'preset-entry-actions', 'preset-entry-groups', 'preset-grouped-drag', 'preset-entry-selection', 'preset-scroll-anchor', 'preset-folder-model', 'preset-section-boundaries'].map(name => `modules/${name}.js`)]) {
    sources.set(`/${file}`, await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
}
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/promptmanager.css"><link rel="stylesheet" href="/style.css">
<style>*{box-sizing:border-box}body{font:16px sans-serif;margin:8px}#scroll{height:1000px;overflow:auto}#completion_prompt_manager{max-width:550px}ul{padding:0;margin:0}li[data-pm-identifier]{min-height:32px;background:#eee}</style>
<body class="cla-preset-drag-guard"><div id="completion_prompt_manager"><div id="scroll"><ul id="completion_prompt_manager_list"></ul></div></div>
<script src="/lib/jquery-3.5.1.min.js"></script><script src="/lib/jquery-ui.min.js"></script><script src="/lib/jquery.ui.touch-punch.min.js"></script>
<script type="module">
import {PresetEntryActions} from '/modules/preset-entry-actions.js';
import {PresetDragGuard} from '/modules/preset-drag-guard.js';
import {makeDraggable} from '/native-sortable.js';
window.actions = new PresetEntryActions(); actions.started = true;
window.list = document.querySelector('ul');
window.saves = 0; window.renders = 0; window.failSave = false; window.delaySave = false; window.pendingSaves = [];
const prompts = Array.from({length:240}, (_,i) => ({identifier:'n'+i,name:({1:'↓Outer↓',20:'↓Inner↓',40:'↑Inner↑',120:'↑Outer↑',130:'↓Next↓',200:'↑Next↑'})[i] || String.fromCharCode(0x4e00+i)+' item',content:'content '+i}));
actions.manager = {listElement:list,activeCharacter:{id:1},serviceSettings:{prompts,prompt_order:[{character_id:1,order:prompts.map(p=>({identifier:p.identifier,enabled:!p.identifier.endsWith('2')}))}]},
    configuration:{prefix:'completion_',sortableDelay:30},
    getPromptOrderForCharacter(){return actions.context().order},
    removePromptOrderForCharacter(character){this.serviceSettings.prompt_order=this.serviceSettings.prompt_order.filter(p=>p.character_id!==character.id)},
    addPromptOrderForCharacter(character,order){this.serviceSettings.prompt_order.push({character_id:character.id,order})}, log(){},
    async saveServiceSettings(){ window.saves++; if(window.failSave) throw Error('offline'); if(window.delaySave) await new Promise((resolve,reject)=>pendingSaves.push({resolve,reject})); },
    render(){ window.renders++; draw(); }};
actions.groups.getPresetName = () => 'drag fixture';
window.order = () => actions.context().order.map(p=>p.identifier);
window.draw = () => {
    if($(list).sortable('instance')) $(list).sortable('destroy');
    list.innerHTML = order().map(id => '<li class="completion_prompt_manager_prompt completion_prompt_manager_prompt_draggable" data-pm-identifier="'+id+'"><span class="drag-handle">☰</span><span class="completion_prompt_manager_prompt_name">'+prompts.find(p=>p.identifier===id).name+'</span><span class="prompt_manager_prompt_controls"></span><span class="prompt_manager_prompt_tokens">1</span></li>').join('');
    makeDraggable.call(actions.manager);
    actions.decorate();
};
draw();window.guard=new PresetDragGuard();guard.start();actions.selection.start();window.ready = true;
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
        await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.ready);
        if(theme) await page.addStyleTag({content:theme});
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
        const drag = async (from, to, hold = 0, bottom = false) => {
            const a = await box(from), b = await box(to);
            await down(point(a)); await page.waitForTimeout(hold);
            const start=point(a),end=point(b,bottom);
            for(let i=1;i<=8;i++) { await move({x:start.x+(end.x-start.x)*i/8,y:start.y+(end.y-start.y)*i/8}); await page.waitForTimeout(16); }
            await page.waitForTimeout(20);
            await up();
        };
        const initial = await page.evaluate(() => order());
        const data = await page.evaluate(() => JSON.stringify(actions.context().prompts));
        assert.equal(await folder('Outer').count(),1);
        // Single item crosses a folded 120-row section, keeping all hidden rows.
        await drag(row('n0'), folder('Outer'), 0, true);
        const firstMove = await page.evaluate(() => order());
        assert.ok(firstMove.indexOf('n0')>firstMove.indexOf('n120'));
        assert.deepEqual(firstMove.filter(id=>id!=='n0'),initial.slice(1));
        assert.deepEqual(await page.evaluate(() => [saves,renders]), [1,0]);
        // Multi-selection moves as one transaction, preserving native item objects.
        await page.evaluate(() => { actions.selection.enter(); actions.selection.selected = new Set(['n121','n125']); actions.selection.render(); });
        await drag(row('n121'), folder('Outer'));
        assert.deepEqual((await page.evaluate(() => order())).slice(0,3), ['n121','n125','n1']);
        assert.deepEqual(await page.evaluate(() => [saves,renders,actions.selection.mode]), [2,0,false]);
        // An entire folded section, including its nested group, moves together.
        await drag(folder('Outer'), folder('Next'), 440, true);
        const moved = await page.evaluate(() => order());
        assert.ok(moved.indexOf('n1')>moved.indexOf('n200'));
        assert.deepEqual(moved.slice(moved.indexOf('n1'),moved.indexOf('n1')+120), initial.slice(1,121));
        assert.deepEqual(await page.evaluate(() => [saves,renders]), [3,0]);
        // A fast handle move uses the native helper and visible placeholder.
        await page.evaluate(() => { document.querySelector('#scroll').scrollTop=0;window.delaySave=true; });
        const a = await box(row('n121')), b = await box(row('n125'));
        await down(point(a)); await move(point(b,true)); await page.waitForTimeout(30);
        assert.equal(await page.locator('.ui-sortable-helper').count(),1);
        assert.equal(await page.locator('.cla-preset-native-placeholder').isVisible(),true);
        const helper = await page.locator('.ui-sortable-helper').boundingBox();
        await move({x:point(b,true).x,y:point(b,true).y+20}); await page.waitForTimeout(20);
        assert.ok(Math.abs((await page.locator('.ui-sortable-helper').boundingBox()).y-helper.y)>=10);
        await page.screenshot({path:`/tmp/cla-preset-2.1.89-native-${mobile?'touch':'desktop'}.png`,clip:{x:0,y:0,width:mobile?390:650,height:600}});
        // Cancellation restores the native position without saving.
        await page.keyboard.press('Escape'); await up();
        assert.deepEqual(await page.evaluate(() => order()),moved);
        assert.equal(await page.locator('.ui-sortable-helper,.cla-preset-native-placeholder').count(),0);
        assert.equal(await page.evaluate(() => saves),3);
        // Saving remains pending: DOM and model move immediately, then another
        // drag is allowed without waiting for SETTINGS_UPDATED or a full render.
        await drag(row('n121'),row('n125'),0,true);
        const optimistic = await page.evaluate(() => order());
        assert.notDeepEqual(optimistic,moved);
        assert.deepEqual(await page.evaluate(() => [saves,renders,pendingSaves.length]),[4,0,1]);
        assert.deepEqual(await page.locator('[data-pm-identifier]').evaluateAll(rows=>rows.map(r=>r.dataset.pmIdentifier)),optimistic);
        await drag(row('n121'),row('n125'));
        assert.deepEqual(await page.evaluate(() => order()),moved);
        assert.deepEqual(await page.evaluate(() => [saves,renders,pendingSaves.length]),[5,0,2]);
        await page.evaluate(() => { pendingSaves[0].reject(Error('late save failure'));pendingSaves[1].resolve();pendingSaves=[];window.delaySave=false; });
        assert.deepEqual(await page.evaluate(() => order()),moved,'an older failed save cannot undo a newer drop');
        // Failed save rolls back the exact native order without rebuilding the list.
        await page.evaluate(() => { window.failSave=true; });
        await drag(row('n121'), row('n125'),0,true);
        assert.deepEqual(await page.evaluate(() => order()), moved);
        assert.deepEqual(await page.evaluate(() => [saves,renders]), [6,0]);
        await page.evaluate(() => { window.failSave=false; });
        // Original-order view still uses the native jQuery UI update callback.
        await page.evaluate(() => { actions.groups.rawOrder=true; actions.groups.render();document.querySelector('#scroll').scrollTop=0; });
        await drag(row('n121'),row('n0'),180,true);
        assert.notDeepEqual(await page.evaluate(() => order()),moved);
        assert.equal(await page.evaluate(() => saves),7);
        // Expanded groups use the same path, preserving nested folder boundaries.
        await page.evaluate(() => {
            const g=actions.groups; g.rawOrder=false;g.render();
            g.setFold(g.context(),[...g.folderNodes.keys()],false);
        });
        const beforeExpanded = await page.evaluate(() => order());
        await drag(row('n2'),row('n4'),0,true);
        const expanded = await page.evaluate(() => order());
        assert.ok(expanded.indexOf('n2')>expanded.indexOf('n4'));
        assert.deepEqual(expanded.filter(id=>id!=='n2'),beforeExpanded.filter(id=>id!=='n2'));
        assert.equal(await page.evaluate(() => saves),8);
        assert.equal(await page.evaluate(() => JSON.stringify(actions.context().prompts)),data);
        assert.equal(new Set(await page.evaluate(() => order())).size,240);
        assert.deepEqual(errors,[]);
        console.log(`${mobile?'Touch':'Desktop'}: native helper follows pointer; visible placeholder; immediate/rapid drops with pending saves; single/multi/folder moves preserve 240 rows; cancel, rollback and raw view passed (${await page.evaluate(() => renders)} full rerenders).`);
        await page.close();
    }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
