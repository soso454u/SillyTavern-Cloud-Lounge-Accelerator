// Exercises the committed production bundle with real plugin modules and mocked
// native SillyTavern APIs. No connection to user servers or chat files.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const pluginRoot = '/scripts/extensions/third-party/cloud-lounge-accelerator/';
const assets = new Map(await Promise.all((await readdir(new URL('../dist/', import.meta.url))).map(async name => [
    `${pluginRoot}dist/${name}`, await readFile(new URL(`../dist/${name}`, import.meta.url), 'utf8'),
])));
assets.set('/script.js', `
    export const chat = [];
    export const event_types = {SETTINGS_LOADED:'settings', APP_INITIALIZED:'initialized', APP_READY:'ready', CHAT_CHANGED:'chat'};
    const handlers = new Map();
    export const eventSource = {
        on(name, callback) { handlers.set(name, [...(handlers.get(name) || []), callback]); },
        once(name, callback) { const once = (...args) => { this.removeListener(name, once); return callback(...args); }; this.on(name, once); },
        removeListener(name, callback) { handlers.set(name, (handlers.get(name) || []).filter(item => item !== callback)); },
        async emit(name, ...args) { for (const callback of [...(handlers.get(name) || [])]) await callback(...args); },
    };
    export const getCurrentChatId = () => null;
    export const getRequestHeaders = () => ({'Content-Type':'application/json'});
    export const isGenerating = () => false;
    export const refreshSwipeButtons = () => {};
    export const scrollChatToBottom = () => {};
    export const saveSettingsDebounced = () => { window.settingsSaves = (window.settingsSaves || 0) + 1; };
`);
assets.set('/scripts/extensions.js', `export const extension_settings = {cloud_lounge_accelerator:{
    pageAcceleration:true, chatOptimization:true, interactionOptimization:true, chatPageSize:5, settingsVersion:'2.1.32',
}};`);
assets.set('/scripts/power-user.js', 'export const power_user = {chat_truncation:100};');
assets.set('/lib.js', 'export const hljs = {highlightElement() {}, highlightBlock() {}, highlightAll() {}};');
assets.set('/scripts/openai.js', 'export const promptManager = null;');
assets.set('/scripts/popup.js', 'export const Popup = {util:{popups:[]}};');
assets.set('/scripts/utils.js', 'export const regexFromString = input => new RegExp(input);');
assets.set('/scripts/extensions/regex/engine.js', `
    export const SCRIPT_TYPES = {GLOBAL:0, PRESET:1, SCOPED:2};
    export const getScriptsByType = () => [];
`);
let deferredDelay = 0;
const server = createServer((request, response) => {
    if (assets.has(request.url)) {
        response.setHeader('Content-Type', 'text/javascript');
        const send = () => response.end(assets.get(request.url));
        if (request.url.includes('/dist/deferred-runtime-') && deferredDelay) setTimeout(send, deferredDelay);
        else send();
    } else if (request.url.startsWith('/api/')) {
        response.writeHead(404, {'Content-Type':'application/json'});
        response.end('{"ok":false}');
    } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><div id="chat"></div><div id="extensions_settings2"></div><div id="regex_container"><div class="regex_settings"><div class="inline-drawer-content"><div class="flex-container"></div><div id="saved_regex_scripts"></div><div id="saved_preset_scripts"></div><div id="saved_scoped_scripts"></div></div></div></div></body></html>');
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
        await page.evaluate(() => accelerator.onDisable());
        assert.equal(await page.locator('#cloud-lounge-accelerator-settings').count(), 0);
        assert.equal(await page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.chat_truncation), 100);
        assert.equal(await page.locator('.cla-regex-organizer-toggle').count(), 0);
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
    console.log('PASS production bundle on desktop/mobile: 2 activation requests, optional chunk after readiness, chat limit/regex UI/panel preserved, disable cancels delayed startup');
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
