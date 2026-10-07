// Isolated activation check with mocked SillyTavern modules, real panel,
// fetch coordinator, and performance controller. Requires Playwright.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const sources = new Map(await Promise.all([
    'index.js', 'client-core.js', 'settings.js', 'ui/panel.js', 'ui/advanced-panel.js',
    'ui/performance-panel.js', 'modules/performance-config.js', 'modules/startup-optimizer.js',
    'utils/device-profile.js',
].map(async path => [`/${path}`, await readFile(new URL(`../${path}`, import.meta.url), 'utf8')])));
sources.set('/script.js', `
    export const chat = [];
    export const event_types = { APP_READY: 'ready', SETTINGS_LOADED: 'settings' };
    const handlers = new Map();
    export const eventSource = {
        on(name, callback) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(callback); },
        once(name, callback) { this.on(name, callback); },
        removeListener() {},
        emit(name) { for (const callback of handlers.get(name) || []) callback(); },
    };
    export const getCurrentChatId = () => 'current-chat';
    export const getRequestHeaders = () => ({});
    export const isGenerating = () => false;
    export const refreshSwipeButtons = () => {};
    export const reloadCurrentChat = async () => {};
    export const saveSettingsDebounced = () => {};
    export const scrollChatToBottom = () => {};
`);
sources.set('/extensions.js', 'export const extension_settings = {};');
sources.set('/modules/cache-controller.js', `
    export class CacheController {
        constructor({ onStatus }) { this.onStatus = onStatus; this.state = 'unknown'; }
        async startAfterLogin() { this.state = 'available'; this.onStatus('cache', '正常'); }
        async refreshStats() {}
        getStatus() { return { cache: this.state === 'available' ? '正常' : '检测中' }; }
        async stop() {}
    }
`);
for (const [path, name] of [
    ['chat-optimizer', 'ChatOptimizer'], ['interaction-optimizer', 'InteractionOptimizer'],
    ['regex-refresh', 'RegexRefreshController'], ['regex-ui-adapter', 'RegexUiAdapter'],
]) {
    sources.set(`/modules/${path}.js`, `
        export class ${name} {
            constructor({ onStatus } = {}) { this.onStatus = onStatus; }
            async start() { for (let i = 0; i < 4; i++) this.onStatus?.('chat', '自动'); return true; }
            stop() {}
        }
    `);
}
sources.set('/modules/repair.js', 'export const repairAccelerator = async () => ({});');
sources.set('/utils/scheduler.js', 'export class FrameScheduler { cancelAll() {} destroy() {} }');
let performanceReads = 0;
const server = createServer((request, response) => {
    if (sources.has(request.url)) {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(sources.get(request.url));
    } else if (request.url === '/api/plugins/cloud-lounge-accelerator/performance') {
        performanceReads += 1;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ok: true, settings: { lazyCharacters: true, keepAlive: false, chatCompression: true } }));
    } else {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><div id="extensions_settings2"></div></body></html>');
    }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await chromium.launch({
        headless: true,
        ...(process.env.CLA_BROWSER_EXECUTABLE ? { executablePath: process.env.CLA_BROWSER_EXECUTABLE } : {}),
    });
    const page = await browser.newPage({
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
        window.accelerator = await import('/index.js');
        accelerator.onActivate();
        window.initialPanel = document.querySelector('#cloud-lounge-accelerator-settings');
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(performanceReads, 0, 'activation must not request cloud settings before APP_READY');
    assert.match(await page.locator('[data-cla-performance-state]').textContent(), /启动完成后/);
    await page.evaluate(async () => {
        const { eventSource } = await import('/script.js');
        eventSource.emit('ready');
    });
    await page.waitForFunction(() => !document.querySelector('[data-cla-performance="lazyCharacters"]').disabled);
    assert.equal(performanceReads, 1, 'startup status bursts must share one cloud-settings read');
    assert.equal(await page.evaluate(() => initialPanel === document.querySelector('#cloud-lounge-accelerator-settings')), true,
        'APP_READY must reuse the mounted panel');
    assert.equal(await page.locator('[data-cla-performance="lazyCharacters"]').isChecked(), true);
    console.log('PASS mobile activation: no pre-ready cloud reads; one read after readiness; panel reused; status rendered');
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
