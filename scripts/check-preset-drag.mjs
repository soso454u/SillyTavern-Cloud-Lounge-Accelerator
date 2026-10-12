// Optional integration check with Playwright and SillyTavern's actual native
// libraries/styles. Set CLA_SILLYTAVERN_PUBLIC and optionally CLA_BROWSER_EXECUTABLE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const nativeRoot = process.env.CLA_SILLYTAVERN_PUBLIC;
assert.ok(nativeRoot, 'Set CLA_SILLYTAVERN_PUBLIC to the native public/ directory');
const sources = new Map();
for (const file of ['lib/jquery-3.5.1.min.js', 'lib/jquery-ui.min.js', 'lib/jquery.ui.touch-punch.min.js', 'css/promptmanager.css']) {
    sources.set(`/${file}`, await readFile(path.join(nativeRoot, file), 'utf8'));
}
for (const file of ['modules/preset-drag-guard.js', 'adapters/prompt-toggle.js', 'style.css']) {
    sources.set(`/${file}`, await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
}
sources.set('/openai.js', 'export const promptManager = window.manager;');
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/promptmanager.css"><link rel="stylesheet" href="/style.css">
<style>
    * {box-sizing:border-box} body {font:16px sans-serif;margin:8px}
    #completion_prompt_manager {max-width:550px}
    #scroll {height:300px;overflow:auto}
    #completion_prompt_manager_list {padding:0; margin:0}
    #completion_prompt_manager_list li {height:60px; background:#eee}
</style>
<div id="completion_prompt_manager"><div id="scroll"><ul id="completion_prompt_manager_list"></ul></div></div>
<script src="/lib/jquery-3.5.1.min.js"></script><script src="/lib/jquery-ui.min.js"></script>
<script src="/lib/jquery.ui.touch-punch.min.js"></script>
<script type="module">
    import { PresetDragGuard } from '/modules/preset-drag-guard.js';
    import { PromptToggleAdapter } from '/adapters/prompt-toggle.js';
    window.saved = 0; window.reorders = 0; window.edits = 0; window.inspections = 0;
    window.entries = Object.fromEntries('abcdefgh'.split('').map(id => [id, {enabled:true}]));
    window.list = document.querySelector('#completion_prompt_manager_list');
    window.nativeUpdate = () => { window.reorders++; window.saved++; window.order = [...list.children].map(row => row.dataset.pmIdentifier); };
    window.reset = () => {
        if ($(list).sortable('instance')) $(list).sortable('destroy');
        list.innerHTML = 'abcdefgh'.split('').map(id => \`<li class="completion_prompt_manager_prompt completion_prompt_manager_prompt_draggable" data-pm-identifier="\${id}"><span class="drag-handle">☰</span><span class="completion_prompt_manager_prompt_name"><a class="prompt-manager-inspect-action">Prompt \${id}</a></span><span><span class="prompt_manager_prompt_controls"><span class="mes_edit">✎</span><span class="prompt-manager-toggle-action fa-toggle-on">●</span></span></span><span class="prompt_manager_prompt_tokens" data-pm-tokens="1">1</span></li>\`).join('');
        $(list).sortable({handle:null,delay:30,distance:1,items:'.completion_prompt_manager_prompt_draggable',update:window.nativeUpdate});
        document.querySelector('#scroll').scrollTop = 0;
        window.saved = 0; window.reorders = 0;
    };
    window.reset();
    window.manager = { configuration:{prefix:'completion_'}, activeCharacter:{}, listElement:list,
        tokenHandler:{getCounts:()=>({})}, getPromptOrderEntry:(_,id)=>entries[id], saveServiceSettings:()=>{window.saved++; return Promise.resolve();} };
    document.addEventListener('click', event => {
        if(event.target.closest('.mes_edit')) window.edits++;
        if(event.target.closest('.prompt-manager-inspect-action')) window.inspections++;
    });
    window.guard = new PresetDragGuard(); guard.start();
    window.toggleAdapter = new PromptToggleAdapter({}); await toggleAdapter.start();
    window.ready = true;
</script>`;
const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : request.url.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(sources.get(request.url) ?? html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await chromium.launch({ headless: true, ...(process.env.CLA_BROWSER_EXECUTABLE ? { executablePath: process.env.CLA_BROWSER_EXECUTABLE } : {}) });
    for (const mobile of [false, true]) {
        const page = await browser.newPage({ viewport: mobile ? {width:390,height:844} : {width:1100,height:900}, isMobile:mobile, hasTouch:mobile });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForFunction(() => window.ready);
        const session = await page.context().newCDPSession(page);
        const center = async selector => {
            const box = await page.locator(selector).first().boundingBox();
            return {x:box.x+box.width/2,y:box.y+box.height/2};
        };
        const gesture = async (selector, dx, dy, hold = 190) => {
            const start = await center(selector);
            if (mobile) await session.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[start]});
            else { await page.mouse.move(start.x,start.y); await page.mouse.down(); }
            await page.waitForTimeout(hold);
            for (let step=1;step<=12;step++) {
                const point = {x:start.x+dx*step/12,y:start.y+dy*step/12};
                if (mobile) await session.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[point]});
                else await page.mouse.move(point.x,point.y);
                await page.waitForTimeout(16);
            }
            if (mobile) await session.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
            else await page.mouse.up();
            await page.waitForTimeout(80);
        };
        const order = () => page.evaluate(() => [...list.children].map(row=>row.dataset.pmIdentifier).join(''));
        const original = await order();
        const name = '[data-pm-identifier="a"] .prompt-manager-inspect-action';
        const edit = '[data-pm-identifier="a"] .mes_edit';
        const toggle = '[data-pm-identifier="a"] .prompt-manager-toggle-action';
        // reset() creates a fresh native instance after guard.start(): capture
        // must protect it on the very first press, with no MutationObserver.
        await page.evaluate(() => reset());
        await gesture(name, mobile ? 0 : 12, mobile ? -120 : 140);
        assert.equal(await order(), original, 'name gestures must not reorder');
        assert.equal(await page.evaluate(() => reorders), 0);
        if (mobile) assert.ok(await page.evaluate(() => document.querySelector('#scroll').scrollTop) > 0, 'name swipe must still scroll');
        await page.evaluate(() => reset());
        await gesture(toggle, mobile ? 0 : 12, mobile ? -120 : 140);
        assert.equal(await order(), original, 'toggle swipe must not reorder');
        assert.equal(await page.evaluate(() => saved), 0, 'toggle swipe must not change enabled state');
        await page.evaluate(() => reset());
        await gesture(edit, mobile ? 0 : 12, mobile ? -120 : 140);
        assert.equal(await order(), original, 'edit swipe must not reorder');
        await page.evaluate(() => reset());
        await page.locator(name).click();
        await page.locator(edit).click();
        assert.ok(await page.evaluate(() => inspections > 0 && edits > 0), 'normal inspect/edit clicks still work');
        if (mobile) {
            const point = await center(toggle);
            await page.touchscreen.tap(point.x, point.y);
            await page.touchscreen.tap(point.x, point.y);
            assert.equal(await page.evaluate(() => saved), 2, 'each deliberate touch toggles exactly once');
        } else {
            await page.locator(toggle).click();
            assert.equal(await page.evaluate(() => saved), 1);
        }
        await page.evaluate(() => reset());
        const handle = '[data-pm-identifier="a"] > .drag-handle';
        const bounds = await page.evaluate(() => {
            const row = list.firstElementChild;
            const handle = row.querySelector('.drag-handle').getBoundingClientRect();
            const name = row.querySelector('.completion_prompt_manager_prompt_name').getBoundingClientRect();
            return {display:getComputedStyle(row.querySelector('.drag-handle')).display,right:handle.right,left:name.left};
        });
        assert.notEqual(bounds.display, 'none', 'desktop handle must be visible even before native reconfiguration');
        assert.ok(bounds.right <= bounds.left, 'handle must not overlap the name');
        await gesture(handle, 2, 2);
        assert.equal(await page.evaluate(() => reorders), 0, 'minor handle jitter must not reorder');
        await gesture(handle, 0, 150);
        assert.notEqual(await order(), original, 'intentional handle drag must reorder');
        assert.equal(await page.evaluate(() => reorders), 1);
        assert.equal(await page.evaluate(() => saved), 1, 'native update saves exactly once');
        await page.evaluate(() => { guard.stop(); toggleAdapter.stop(); });
        const restored = await page.evaluate(() => { const i=$(list).sortable('instance'); return {handle:i.options.handle,distance:i.options.distance,delay:i.options.delay,callback:i.options.update===nativeUpdate,classes:document.body.classList.contains('cla-preset-drag-guard')}; });
        assert.deepEqual(restored, {handle:null,distance:1,delay:30,callback:true,classes:false});
        assert.deepEqual(errors, []);
        console.log(`${mobile ? 'Touch' : 'Desktop'}: scroll, inspect/edit, toggle, jitter, native reorder/save, rerender and cleanup passed`);
        await page.close();
    }
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
