// Exercises the committed production bundle with real plugin modules and mocked
// native SillyTavern APIs. No connection to user servers or chat files.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const themeStyles = process.env.CLA_REGEX_THEME_CSS ? await readFile(process.env.CLA_REGEX_THEME_CSS,'utf8') : '';
const pluginRoot = '/scripts/extensions/third-party/cloud-lounge-accelerator/';
const assets = new Map(await Promise.all((await readdir(new URL('../dist/', import.meta.url))).map(async name => [
    `${pluginRoot}dist/${name}`, await readFile(new URL(`../dist/${name}`, import.meta.url), 'utf8'),
])));
assets.set('/style.css',await readFile(new URL('../style.css',import.meta.url),'utf8'));
assets.set('/script.js', `
    export const chat = [];
    export const event_types = {SETTINGS_LOADED:'settings', APP_INITIALIZED:'initialized', APP_READY:'ready', CHAT_CHANGED:'chat',
        STREAM_TOKEN_RECEIVED:'token', GENERATION_STARTED:'start', GENERATION_ENDED:'end', GENERATION_STOPPED:'stop'};
    export let streamingProcessor = null;
    const handlers = new Map();
    export const eventSource = {
        on(name, callback) { handlers.set(name, [...(handlers.get(name) || []), callback]); },
        once(name, callback) { const once = (...args) => { this.removeListener(name, once); return callback(...args); }; this.on(name, once); },
        removeListener(name, callback) { handlers.set(name, (handlers.get(name) || []).filter(item => item !== callback)); },
        async emit(name, ...args) { for (const callback of [...(handlers.get(name) || [])]) await callback(...args); },
    };
    export const getCurrentChatId = () => null;
    export const getRequestHeaders = () => ({'Content-Type':'application/json'});
    export const isGenerating = () => Boolean(streamingProcessor?.running);
    export const refreshSwipeButtons = () => {};
    export const scrollChatToBottom = () => {};
    export const saveSettingsDebounced = () => { window.settingsSaves = (window.settingsSaves || 0) + 1; };
    class FixtureProcessor {
        constructor() { this.type='normal'; this.running=true; this.renders=[]; }
        async onProgressStreaming(id, text, final) {
            this.renders.push({id,text,final});
            chat[id].mes=text;
            document.querySelector('#chat .mes_text').textContent=text;
        }
        async finalizeIntermediaryMessage(id, text) { await this.onProgressStreaming(id,text,true); }
    }
    export function beginStream() {
        chat[0]={mes:''};
        document.querySelector('#chat').innerHTML='<div class="mes" mesid="0"><div class="mes_block"><div class="mes_text"></div></div></div>';
        streamingProcessor=new FixtureProcessor();
        return streamingProcessor;
    }
`);
assets.set('/scripts/extensions.js', `export const extension_settings = {cloud_lounge_accelerator:{
    pageAcceleration:true, chatOptimization:true, interactionOptimization:true, chatPageSize:5, settingsVersion:'2.1.32',
}};`);
assets.set('/scripts/power-user.js', 'export const power_user = {chat_truncation:100,streaming_fps:30,stream_fade_in:true};');
assets.set('/lib.js', 'export const hljs = {highlightElement() {}, highlightBlock() {}, highlightAll() {}};');
assets.set('/scripts/openai.js', 'export const promptManager = null;');
assets.set('/scripts/popup.js', 'export const Popup = {util:{popups:[]}};');
assets.set('/scripts/group-chats.js', 'export const selected_group=null; export const groups=[];');
assets.set('/scripts/utils.js', 'export const regexFromString = input => new RegExp(input);');
assets.set('/scripts/extensions/regex/engine.js', `
    export const SCRIPT_TYPES = {GLOBAL:0, PRESET:1, SCOPED:2};
    export const getScriptsByType = type => type === 0 ? (window.fixtureScripts || []) : [];
`);
let deferredDelay = 0;
const server = createServer((request, response) => {
    if (assets.has(request.url)) {
        response.setHeader('Content-Type', request.url.endsWith('.css')?'text/css':'text/javascript');
        const send = () => response.end(assets.get(request.url));
        if (request.url.includes('/dist/deferred-runtime-') && deferredDelay) setTimeout(send, deferredDelay);
        else send();
    } else if (request.url.startsWith('/api/')) {
        response.writeHead(404, {'Content-Type':'application/json'});
        response.end('{"ok":false}');
    } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"><style>:root{--im-bubble-filter:blur(8px)}#chat .mes_block::before{content:"";backdrop-filter:var(--im-bubble-filter)}</style></head><body><div id="chat"></div><div id="extensions_settings2"></div><div id="regex_container"><div class="regex_settings"><div class="inline-drawer-content"><div class="flex-container"></div><div id="saved_regex_scripts"></div><div id="saved_preset_scripts"></div><div id="saved_scoped_scripts"></div></div></div></div></body></html>');
    } else {
        response.writeHead(404);
        response.end('missing fixture');
    }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await chromium.launch({headless:true, ...(process.env.CLA_BROWSER_EXECUTABLE ? {executablePath:process.env.CLA_BROWSER_EXECUTABLE} : {})});
    for (const options of [
        {viewport:{width:1100,height:900}},
        {viewport:{width:390,height:844}, isMobile:true, hasTouch:true,
            userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'},
    ]) {
        const page = await browser.newPage(options);
        const errors = [];
        const requests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => requests.push(new URL(request.url()).pathname));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.evaluate(async entry => {
            window.accelerator = await import(entry);
            accelerator.onActivate();
        }, `${pluginRoot}dist/index.js`);
        assert.equal(requests.filter(url => url.includes('/dist/')).length, 2);
        assert.equal(requests.some(url => url.includes('deferred-runtime-')), false);
        await page.evaluate(async () => {
            const {eventSource} = await import('/script.js');
            await eventSource.emit('settings');
        });
        await page.waitForFunction(async () => (await import('/scripts/power-user.js')).power_user.chat_truncation === 5);
        assert.equal(requests.some(url => url.includes('deferred-runtime-')), false);
        assert.equal(await page.evaluate(() => window.settingsSaves || 0), 0);
        await page.evaluate(async () => {
            const {eventSource} = await import('/script.js');
            await eventSource.emit('initialized');
            await eventSource.emit('ready');
        });
        await page.locator('#cloud-lounge-accelerator-settings').waitFor({state:'attached'});
        await page.waitForFunction(() => document.querySelector('.cla-regex-organizer-toggle'));
        assert.equal(requests.filter(url => url.includes('/dist/')).length, 3);
        assert.equal(await page.evaluate(() => window.settingsSaves || 0), 0);
        const idleScroll = await page.evaluate(async () => {
            const native = await import('/script.js');
            const chat = document.querySelector('#chat');
            chat.style.cssText = 'height:200px;overflow:auto';
            chat.innerHTML = '<div class="mes"><div class="mes_block"><div class="mes_text" style="height:3000px">Existing unchanged message</div></div></div>';
            const bubble = chat.querySelector('.mes_block');
            const height = bubble.getBoundingClientRect().height;
            chat.scrollTop = 600;
            chat.dispatchEvent(new Event('scroll'));
            const during = getComputedStyle(bubble,'::before').backdropFilter;
            const duringHeight = bubble.getBoundingClientRect().height;
            await new Promise(resolve => setTimeout(resolve, 260));
            return {generating:native.isGenerating(), during, after:getComputedStyle(bubble,'::before').backdropFilter,
                height, duringHeight, afterHeight:bubble.getBoundingClientRect().height,
                top:chat.scrollTop,text:bubble.textContent};
        });
        assert.equal(idleScroll.generating,false,'scroll relief works without a generation');
        assert.equal(idleScroll.during,options.hasTouch?'none':'blur(8px)');
        assert.equal(idleScroll.after,'blur(8px)');
        assert.equal(idleScroll.height,idleScroll.duringHeight);
        assert.equal(idleScroll.height,idleScroll.afterHeight);
        assert.equal(idleScroll.top,600,'relief never moves the reading position');
        assert.equal(idleScroll.text,'Existing unchanged message');
        const streaming = await page.evaluate(async () => {
            const native = await import('/script.js');
            const processor = native.beginStream();
            window.streamingFixture = processor;
            window.originalProgress = processor.onProgressStreaming;
            let tokens = 0;
            native.eventSource.on('token', () => tokens++);
            await native.eventSource.emit('start');
            for (let i = 0; i < 80; i++) {
                processor.result = 'snapshot-' + i;
                await native.eventSource.emit('token', processor.result);
                await processor.onProgressStreaming(0, processor.result);
                if (i === 20) document.querySelector('#chat .mes_text').dispatchEvent(new WheelEvent('wheel', {bubbles:true,deltaY:-100}));
                await new Promise(resolve => setTimeout(resolve, 4));
            }
            await processor.finalizeIntermediaryMessage(0, 'Complete final text');
            const state = {tokens,renders:processor.renders.length,last:processor.renders.at(-1),message:native.chat[0].mes,
                text:document.querySelector('#chat .mes_text').textContent,hooked:processor.onProgressStreaming!==originalProgress,
                glassDuring:getComputedStyle(document.querySelector('#chat .mes_block'),'::before').backdropFilter};
            processor.running = false;
            await native.eventSource.emit('end');
            state.restored = processor.onProgressStreaming === originalProgress;
            state.glassAfter=getComputedStyle(document.querySelector('#chat .mes_block'),'::before').backdropFilter;
            return state;
        });
        assert.equal(streaming.tokens,80,'all token events still reach other subscribers');
        assert.ok(streaming.renders>1 && streaming.renders<30,'native full-message previews are coalesced');
        assert.equal(streaming.hooked,true,'production runtime hooks the live native binding');
        assert.equal(streaming.restored,true);
        assert.equal(streaming.glassDuring,options.hasTouch?'none':'blur(8px)');
        assert.equal(streaming.glassAfter,'blur(8px)','original glass style is restored at generation end');
        assert.deepEqual(streaming.last,{id:0,text:'Complete final text',final:true});
        assert.equal(streaming.message,streaming.text);
        assert.equal(streaming.message,'Complete final text');
        assert.deepEqual(await page.evaluate(async()=>{
            const {power_user}=await import('/scripts/power-user.js');
            return {fps:power_user.streaming_fps,fade:power_user.stream_fade_in,saves:window.settingsSaves||0};
        }),{fps:30,fade:true,saves:0},'render budgets do not mutate or save native preferences');
        if (themeStyles && options.hasTouch) {
            const theme = await page.addStyleTag({content:themeStyles});
            const styledScroll = await page.evaluate(async () => {
                const chat = document.querySelector('#chat'), bubble = chat.querySelector('.mes_block');
                const snapshot = () => {
                    const style = getComputedStyle(bubble,'::before'), bounds = bubble.getBoundingClientRect();
                    return {filter:style.backdropFilter,mask:style.maskImage,background:style.backgroundColor,
                        width:bounds.width,height:bounds.height,top:chat.scrollTop,text:bubble.textContent};
                };
                chat.style.setProperty('height','200px','important');
                chat.style.setProperty('overflow','auto','important');
                bubble.querySelector('.mes_text').style.height='3000px';
                chat.scrollTop=600;
                await new Promise(resolve=>setTimeout(resolve,260));
                const before=snapshot();
                chat.dispatchEvent(new Event('scroll'));
                const during=snapshot();
                await new Promise(resolve=>setTimeout(resolve,260));
                return {before,during,after:snapshot()};
            });
            assert.match(styledScroll.before.filter,/blur\(/,'exercise actual theme glass, including its stronger selectors');
            assert.equal(styledScroll.during.filter,'none');
            assert.deepEqual({...styledScroll.during,filter:styledScroll.before.filter},styledScroll.before,'theme mask, fill, geometry, text and reading position stay unchanged');
            assert.deepEqual(styledScroll.after,styledScroll.before,'restore every sampled theme property');
            await theme.evaluate(element=>element.remove());
        }
        await page.locator('.cla-regex-organizer-toggle').click();
        await page.locator('.cla-regex-group-manager summary').click();
        await page.locator('[data-cla-regex-new-name]').fill('发布包分组');
        await page.locator('[data-cla-regex-action="create-collection"]').click();
        assert.deepEqual(await page.evaluate(async()=>{
            const {extension_settings}=await import('/scripts/extensions.js');
            return {groups:extension_settings.cloud_lounge_accelerator_regex_collections?.['["GLOBAL"]']?.groups,
                saves:window.settingsSaves||0};
        }),{groups:['发布包分组'],saves:1},'custom group catalog uses the live native settings object and save callback');
        await page.evaluate(() => {
            window.fixtureScripts = [{id:'bundle-numbered',scriptName:'00b | iMessage | 会话视角'}];
            const row = document.createElement('div');
            row.id = 'bundle-numbered';
            row.className = 'regex-script-label';
            row.innerHTML = '<input class="regex_bulk_checkbox" type="checkbox"><span class="regex_script_name">00b | iMessage | 会话视角</span>';
            document.querySelector('#saved_regex_scripts').append(row);
        });
        await page.waitForFunction(() => document.getElementById('bundle-numbered').dataset.claRegexCollection === 'iMessage');
        assert.equal(await page.locator('[data-cla-regex-create-scope]').count(), 3);
        await page.locator('[data-cla-regex-create-scope="GLOBAL"]').click();
        assert.equal(await page.locator('#saved_regex_scripts [data-cla-regex-fold="新分组"] .cla-regex-rename-form').isVisible(), true);
        await page.locator('#saved_regex_scripts [data-cla-regex-fold="新分组"] input').press('Escape');
        assert.deepEqual(await page.evaluate(async () => {
            const {extension_settings} = await import('/scripts/extensions.js');
            return {groups:extension_settings.cloud_lounge_accelerator_regex_collections?.['["GLOBAL"]']?.groups,
                saves:window.settingsSaves||0};
        }), {groups:['发布包分组','新分组'],saves:2}, 'quick empty groups persist through the published runtime');
        await page.evaluate(async()=>{
            const native=await import('/script.js');
            window.streamingFixture=native.beginStream();window.originalProgress=streamingFixture.onProgressStreaming;
            await native.eventSource.emit('token','pending');
        });
        await page.evaluate(() => accelerator.onDisable());
        assert.equal(await page.evaluate(()=>streamingFixture.onProgressStreaming===originalProgress),true,'disable during generation restores the native method');
        assert.equal(await page.locator('#cloud-lounge-accelerator-settings').count(), 0);
        assert.equal(await page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.chat_truncation), 100);
        assert.equal(await page.locator('.cla-regex-organizer-toggle').count(), 0);
        assert.equal(await page.locator('[data-cla-regex-scope-actions]').count(), 0);
        assert.deepEqual(errors, []);
        await page.close();
    }
    deferredDelay = 300;
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const requested = page.waitForRequest(request => request.url().includes('/dist/deferred-runtime-'));
    await page.evaluate(async entry => {
        window.accelerator = await import(entry);
        accelerator.onActivate();
        const {eventSource} = await import('/script.js');
        await eventSource.emit('settings');
        await eventSource.emit('ready');
    }, `${pluginRoot}dist/index.js`);
    await requested;
    await page.evaluate(() => accelerator.onDisable());
    await page.waitForTimeout(450);
    assert.equal(await page.locator('#cloud-lounge-accelerator-settings').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS production bundle on desktop/mobile: numbered collection recognition, quick empty group creation/persistence, startup budget, scroll/theme restoration, streaming/finalization, preferences, disable and delayed startup');
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
