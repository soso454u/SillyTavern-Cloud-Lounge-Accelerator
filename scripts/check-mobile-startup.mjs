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
    'utils/device-profile.js', 'modules/deferred-runtime.js', 'modules/startup-diagnostics.js', 'modules/interaction-diagnostics.js', 'modules/ui-render-optimizer.js',
    'modules/native-input.js', 'modules/interaction-recovery-guard.js',
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
    export const saveSettingsDebounced = () => { window.settingsSaves = (window.settingsSaves || 0) + 1; };
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
            getDiagnosticSummary() { return "自动"; }
            getDiagnosticReport() { return {}; }
            stop() {}
        }
    `);
}
sources.set('/modules/repair.js', 'export const repairAccelerator = async () => ({});');
sources.set('/utils/scheduler.js', 'export class FrameScheduler { cancelAll() {} destroy() {} }');
let performanceReads = 0;
const moduleRequests = [];
let deferredDelay = 0;
const server = createServer((request, response) => {
    if (sources.has(request.url)) {
        response.setHeader('Content-Type', 'text/javascript');
        moduleRequests.push(request.url);
        const send = () => response.end(sources.get(request.url));
        if (request.url === '/modules/deferred-runtime.js' && deferredDelay) setTimeout(send, deferredDelay);
        else send();
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
    const pageErrors = [];
    const page = await browser.newPage({
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
        window.accelerator = await import('/index.js');
        accelerator.onActivate();
        window.initialPanel = document.querySelector('#cloud-lounge-accelerator-settings');
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(performanceReads, 0, 'activation must not request cloud settings before APP_READY');
    assert.equal(moduleRequests.includes('/modules/deferred-runtime.js'), false, 'optional dependency graph must not load before readiness');
    assert.equal(await page.evaluate(() => window.settingsSaves || 0), 0, 'activation must not save settings before readiness');
    assert.equal(await page.locator('#cloud-lounge-accelerator-settings').count(), 0);
    await page.evaluate(async () => {
        const { eventSource } = await import('/script.js');
        eventSource.emit('ready');
    });
    await page.waitForFunction(() => document.querySelector('[data-cla-performance="lazyCharacters"]')?.disabled === false);
    assert.equal(performanceReads, 1, 'startup status bursts must share one cloud-settings read');
    assert.equal(await page.evaluate(() => window.settingsSaves), 1, 'flush one pending migration after readiness');
    assert.equal(moduleRequests.filter(path => path === '/modules/deferred-runtime.js').length, 1);
    assert.equal(await page.locator('[data-cla-performance="lazyCharacters"]').isChecked(), true);
    const panel = await page.locator('#cloud-lounge-accelerator-settings').elementHandle();
    await page.evaluate(() => accelerator.onActivate());
    await page.waitForTimeout(50);
    assert.equal(await panel.evaluate(el => el.isConnected), true, 'reactivation must reuse the mounted panel');
    assert.equal(performanceReads, 1);
    await page.evaluate(() => accelerator.onDisable());
    assert.equal(await page.locator('#cloud-lounge-accelerator-settings').count(), 0);

    // A delayed optional script must neither delay the native event nor revive
    // optimization after the user disables the extension during that download.
    deferredDelay = 250;
    const cancelledPage = await browser.newPage();
    cancelledPage.on('pageerror', error => pageErrors.push(error.message));
    await cancelledPage.goto(`http://127.0.0.1:${server.address().port}`);
    const optionalRequest = cancelledPage.waitForRequest(request => request.url().endsWith('/modules/deferred-runtime.js'));
    await cancelledPage.evaluate(async () => {
        window.accelerator = await import('/index.js');
        accelerator.onActivate();
        const { eventSource } = await import('/script.js');
        eventSource.emit('settings');
        eventSource.emit('ready');
    });
    await optionalRequest;
    await cancelledPage.evaluate(() => accelerator.onDisable());
    await cancelledPage.waitForTimeout(400);
    assert.equal(await cancelledPage.locator('#cloud-lounge-accelerator-settings').count(), 0);
    assert.equal(performanceReads, 1, 'disabled extension must not start deferred cloud reads');
    assert.deepEqual(pageErrors, []);
    await page.evaluate(async () => {
        const classes = [
            ['interaction-diagnostics', 'InteractionDiagnostics'],
            ['native-input', 'InputRevealGuard'],
            ['ui-render-optimizer', 'UiRenderOptimizer'],
            ['interaction-recovery-guard', 'InteractionRecoveryGuard'],
        ];
        for (const [path, name] of classes) {
            const module = await import(`/modules/${path}.js`);
            const instance = new module[name]();
            const timer = instance.setTimer(() => {}, 1000);
            instance.clearTimer(timer);
        }
    });
    console.log('PASS mobile/desktop startup: no optional downloads or saves before ready; panel restored; delayed imports cannot revive disabled extension');
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
