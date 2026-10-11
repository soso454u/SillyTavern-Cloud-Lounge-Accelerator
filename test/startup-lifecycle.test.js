import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let sequence = 0;
const dataUrl = source => `data:text/javascript,${encodeURIComponent(source)}`;
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, previous) {
    const state = { saves: 0, chatStarts: 0, deferredLoads: 0, interactionStarts: 0, cacheStarts: 0, panels: 0 };
    const handlers = new Map();
    const events = {
        once(name, callback) { this.on(name, callback); },
        on(name, callback) { handlers.set(name, [...(handlers.get(name) || []), callback]); },
        emit(name) { for (const callback of handlers.get(name) || []) callback(); },
    };
    globalThis.__claStartup = { state, events, previous };
    const nonce = ++sequence;
    const stub = text => dataUrl(`${text}\n// fixture ${nonce}`);
    const replacements = {
        '../../../../script.js': stub(`
            const {state, events} = globalThis.__claStartup;
            export const chat = [];
            export const eventSource = events;
            export const event_types = {SETTINGS_LOADED: 'settings', APP_READY: 'ready'};
            export const getCurrentChatId = () => null;
            export const getRequestHeaders = () => ({});
            export const isGenerating = () => false;
            export const refreshSwipeButtons = () => {};
            export const saveSettingsDebounced = () => state.saves++;
            export const scrollChatToBottom = () => {};
        `),
        '../../../extensions.js': stub(`export const extension_settings = {cloud_lounge_accelerator: globalThis.__claStartup.previous};`),
        './settings.js': new URL('../settings.js', import.meta.url).href,
        './modules/chat-optimizer.js': stub(`
            const {state} = globalThis.__claStartup;
            export class ChatOptimizer {
                async start() { state.chatStarts++; await state.chatGate; }
                stop() {}
            }
        `),
        './modules/startup-optimizer.js': stub(`export class StartupOptimizer { start() {} stop() {} }`),
        './utils/scheduler.js': stub(`export class FrameScheduler {cancelAll() {} destroy() {}}`),
        './modules/deferred-runtime.js': stub(`
            const {state} = globalThis.__claStartup;
            state.deferredLoads++;
            export function createDeferredRuntime() {
                return {
                    interactionOptimizer: {async start() { state.interactionStarts++; await state.interactionGate; }, stop() {}},
                    regexRefresh: {async start() { return true; }, stop() {}},
                    regexUiAdapter: {async start() {}, stop() {}},
                    cacheController: {async startAfterLogin() {state.cacheStarts++;}, stop() {}},
                };
            }
            export class SettingsPanel {
                mount() {state.panels++; return true;}
                refresh() {}
                remove() {state.panels--;}
            }
            export const copyDiagnosticText = () => {};
            export const repairAccelerator = () => {};
        `),
    };
    let source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    for (const [path, url] of Object.entries(replacements)) source = source.replaceAll(`'${path}'`, JSON.stringify(url));
    const plugin = await import(dataUrl(`${source}\n// fixture ${nonce}`));
    t.after(async () => { await plugin.onDisable(); delete globalThis.__claStartup; });
    return { plugin, state, events };
}

const oldSettings = {
    pageAcceleration: true, chatOptimization: true, interactionOptimization: true,
    chatPageSize: 5, settingsVersion: '2.1.30',
};

test('activation and SETTINGS_LOADED leave optional downloads and settings uploads until APP_READY', async t => {
    const {plugin, state, events} = await fixture(t);
    plugin.onActivate();
    assert.equal(state.saves, 0);
    assert.equal(state.chatStarts, 0);
    assert.equal(state.deferredLoads, 0);
    events.emit('settings');
    await tick();
    assert.equal(state.chatStarts, 1, 'chat limit must be prepared before native initial chat loading');
    assert.equal(state.deferredLoads, 0);
    assert.equal(state.interactionStarts, 0);
    assert.equal(state.saves, 0);
    events.emit('ready');
    await tick();
    assert.equal(state.deferredLoads, 1);
    assert.equal(state.cacheStarts, 1);
    assert.equal(state.panels, 1);
    assert.equal(state.saves, 1);
});

test('version-only upgrades do not request a full settings upload', async t => {
    const {plugin, state, events} = await fixture(t, oldSettings);
    plugin.onActivate();
    events.emit('settings');
    events.emit('ready');
    await tick();
    assert.equal(state.saves, 0);
});

test('overlapping settings and ready events share a pending chat start and optional initialization', async t => {
    const {plugin, state, events} = await fixture(t, oldSettings);
    let releaseChat;
    let releaseInteraction;
    state.chatGate = new Promise(resolve => { releaseChat = resolve; });
    state.interactionGate = new Promise(resolve => { releaseInteraction = resolve; });
    plugin.onActivate();
    events.emit('settings');
    events.emit('ready');
    assert.equal(state.chatStarts, 1);
    releaseChat();
    await tick();
    assert.equal(state.deferredLoads, 1);
    assert.equal(state.interactionStarts, 1);
    releaseInteraction();
    await tick();
    assert.equal(state.cacheStarts, 1);
});

test('disable during early chat initialization prevents deferred downloads and UI revival', async t => {
    const {plugin, state, events} = await fixture(t, oldSettings);
    let releaseChat;
    state.chatGate = new Promise(resolve => { releaseChat = resolve; });
    plugin.onActivate();
    events.emit('settings');
    events.emit('ready');
    await plugin.onDisable();
    releaseChat();
    await tick();
    assert.equal(state.deferredLoads, 0);
    assert.equal(state.cacheStarts, 0);
    assert.equal(state.panels, 0);
});

test('disable while optional initialization waits prevents cache and panel startup', async t => {
    const {plugin, state, events} = await fixture(t, oldSettings);
    let releaseInteraction;
    state.interactionGate = new Promise(resolve => { releaseInteraction = resolve; });
    plugin.onActivate();
    events.emit('ready');
    await tick();
    await plugin.onDisable();
    releaseInteraction();
    await tick();
    assert.equal(state.cacheStarts, 0);
    assert.equal(state.panels, 0);
});

test('entry dependency graph keeps optional UI and interaction modules off the activation path', async () => {
    const root = new URL('../', import.meta.url);
    const visited = new Set();
    let bytes = 0;
    async function visit(url) {
        if (!url.href.startsWith(root.href) || visited.has(url.href)) return;
        visited.add(url.href);
        const source = await readFile(url, 'utf8');
        bytes += Buffer.byteLength(source);
        for (const match of source.matchAll(/(?:import|export)\s+(?!\()[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g)) {
            if (match[1].startsWith('.')) await visit(new URL(match[1], url));
        }
    }
    await visit(new URL('../index.js', import.meta.url));
    assert.ok(visited.size <= 10, `activation graph grew to ${visited.size} modules`);
    assert.ok(bytes < 100000, `activation graph grew to ${bytes} bytes`);
    for (const url of visited) {
        assert.doesNotMatch(url, /deferred-runtime|interaction-|regex-|cache-controller|ui\/panel/);
    }
});
