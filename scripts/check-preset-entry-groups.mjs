// Run against a disposable SillyTavern instance with this build installed.
// CLA_TAVERN_URL=http://127.0.0.1:8000 CLA_PRESET_FIXTURE=/path/to/preset.json node scripts/check-preset-entry-groups.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { CLA_TAVERN_URL, CLA_PRESET_FIXTURE, CLA_BROWSER_EXECUTABLE } = process.env;
assert.ok(CLA_TAVERN_URL && CLA_PRESET_FIXTURE, 'Set CLA_TAVERN_URL and CLA_PRESET_FIXTURE');
const base = new URL(CLA_TAVERN_URL);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use a local disposable SillyTavern');
const fixture = await readFile(CLA_PRESET_FIXTURE);
const fixtureOrder = JSON.parse(fixture).prompt_order;
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(CLA_BROWSER_EXECUTABLE ? { executablePath: CLA_BROWSER_EXECUTABLE } : {}) });

const rows = '#completion_prompt_manager_list > [data-pm-identifier]';
const headers = '#completion_prompt_manager_list > .cla-preset-fold-header';
const rendered = page => page.evaluate(rows => [...document.querySelectorAll(rows)]
    .filter(row => getComputedStyle(row).display !== 'none' && row.getClientRects().length)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    .map(row => row.dataset.pmIdentifier), rows);
const assertHidden = async (page, ids) => {
    const hidden = await page.evaluate(({ rows, ids }) => [...document.querySelectorAll(rows)]
        .filter(row => ids.includes(row.dataset.pmIdentifier) && getComputedStyle(row).display === 'none'
            && row.getClientRects().length === 0).length, { rows, ids });
    assert.equal(hidden, ids.length, 'hidden native rows must have display:none and no layout box');
};
const snapshot = page => page.evaluate(async () => {
    const { promptManager: manager } = await import('/scripts/openai.js');
    return JSON.stringify([manager.serviceSettings.prompt_order, manager.serviceSettings.prompts]);
});
const metadata = page => page.evaluate(async () => {
    const { promptManager: manager, oai_settings: settings } = await import('/scripts/openai.js');
    return window.SillyTavern.getContext().extensionSettings.cloud_lounge_accelerator_preset_groups[
        JSON.stringify(['openai', settings.preset_settings_openai, String(manager.activeCharacter.id)])];
});

try {
    for (const mobile of process.env.CLA_MOBILE_ONLY ? [true] : [false, true]) {
        const context = await browser.newContext(mobile
            ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
            : { viewport: { width: 1280, height: 900 } });
        await context.route('**/*', route => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort());
        const page = await context.newPage(), resources = new Set();
        page.setDefaultTimeout(10_000);
        page.on('response', response => {
            if (response.ok()) {
                const url = new URL(response.url());
                if (url.pathname.includes('/extensions/') && url.pathname.includes('/dist/')) resources.add(url.pathname.split('/dist/').pop() + url.search);
            }
        });
        const act = locator => mobile ? locator.tap() : locator.click();
        const folder = name => page.locator(headers).filter({ has: page.locator('.cla-preset-fold-name').getByText(name, { exact: true }) });
        const button = name => page.getByRole('button', { name, exact: true });
        const search = page.getByRole('searchbox', { name: '搜索名称或内容' });
        const filter = page.getByLabel('条目筛选');
        const openDrawer = async () => {
            if (await page.locator('#leftNavDrawerIcon').evaluate(icon => icon.classList.contains('closedIcon'))) await act(page.locator('#leftNavDrawerIcon'));
        };

        await page.goto(base.href);
        await page.locator('.cla-preset-groups').waitFor({ state: 'attached', timeout: 30_000 });
        await page.locator('dialog[open]').waitFor({ state: 'hidden' });
        if (await page.locator('#main_api').inputValue() !== 'openai') {
            await act(page.locator('#API-status-top'));
            await page.locator('#main_api').selectOption('openai');
        }
        await page.locator('#themes').selectOption(mobile ? 'Cappuccino' : 'Dark Lite', { force: true });
        await openDrawer();
        const presetName = `CLA folders ${mobile ? 'touch' : 'desktop'} ${Date.now()}`;
        await page.locator('#openai_preset_import_file').setInputFiles({ name: `${presetName}.json`, mimeType: 'application/json', buffer: fixture });
        // Some real presets trigger native proxy and embedded-regex prompts.
        const proxy = page.locator('dialog[open]').getByRole('button', { name: 'Remove them', exact: true });
        const nativeImportReady = page.waitForFunction(name => {
            const { chatCompletionSettings, extensionSettings } = window.SillyTavern.getContext();
            return chatCompletionSettings.preset_settings_openai === name
                && Object.keys(extensionSettings.cloud_lounge_accelerator_preset_groups || {}).some(key => JSON.parse(key)[1] === name);
        }, presetName);
        if (await Promise.race([proxy.waitFor({ state: 'visible' }).then(() => true), nativeImportReady.then(() => false)])) await act(proxy);
        await nativeImportReady;
        const regexDialog = page.locator('dialog[open]').filter({ hasText: /内置正则|内建正则|embedded regex|preset contains.*regex/i });
        if (await regexDialog.count()) await act(regexDialog.locator('.popup-button-cancel'));
        await page.locator('dialog[open]').waitFor({ state: 'hidden' });
        assert.ok(resources.has(manifest.js.split('/').pop()));
        assert.ok(resources.has(manifest.css.split('/').pop()));
        const original = await snapshot(page);
        const [loadedOrder] = JSON.parse(original);
        for (const expected of fixtureOrder) {
            assert.deepEqual(loadedOrder.find(group => String(group.character_id) === String(expected.character_id)), expected);
        }
        const ids = await page.locator(rows).evaluateAll(items => items.map(row => row.dataset.pmIdentifier));
        const characterId = await page.evaluate(async () => String((await import('/scripts/openai.js')).promptManager.activeCharacter.id));
        const expectedOrder = fixtureOrder.find(group => String(group.character_id) === characterId)
            .order.map(item => item.identifier).filter(id => ids.includes(id));
        assert.ok(ids.length >= 100);
        assert.deepEqual(ids, expectedOrder);
        const state = await metadata(page);
        assert.ok(Object.values(state.assignments).some(item => item.source === 'section'));
        assert.equal(Object.values(state.assignments).some(item => item.source === 'auto'), false);
        const parent = state.folders.find(item => item.name === '规则' && !item.parentId);
        const child = state.folders.find(item => item.name === '文风' && item.parentId === parent?.id);
        assert.ok(child, 'Use the large fixture with the nested 规则 / 文风 region');
        const parentRow = folder(parent.name), childRow = folder(child.name);
        const assigned = ids.filter(id => state.assignments[id]?.folderId);
        const outside = ids.filter(id => !state.assignments[id]?.folderId);
        const byId = new Map(state.folders.map(item => [item.id, item]));
        const inFolder = (id, target) => {
            for (let current = state.assignments[id]?.folderId; current; current = byId.get(current)?.parentId) {
                if (current === target) return true;
            }
            return false;
        };
        const parentMembers = ids.filter(id => inFolder(id, parent.id));
        const childMembers = ids.filter(id => inFolder(id, child.id));
        const parentDirect = ids.filter(id => state.assignments[id]?.folderId === parent.id);
        const childDirect = ids.filter(id => state.assignments[id]?.folderId === child.id);
        await parentRow.waitFor();
        assert.equal(await childRow.count(), 0);
        assert.equal(Number(await parentRow.locator('.cla-preset-fold-count').textContent()), parentMembers.length);
        assert.deepEqual(await rendered(page), outside);
        await assertHidden(page, assigned);

        await act(parentRow.locator('.cla-preset-fold-toggle'));
        await childRow.waitFor();
        assert.deepEqual(await rendered(page), ids.filter(id => outside.includes(id) || parentDirect.includes(id)));
        await assertHidden(page, childMembers);
        await act(childRow.locator('.cla-preset-folder-arrow'));
        assert.deepEqual(await rendered(page), ids.filter(id => [outside, parentDirect, childDirect].some(items => items.includes(id))));
        if (mobile) {
            const line = await childRow.evaluate(row => ({
                flow: getComputedStyle(row).flexWrap, height: row.getBoundingClientRect().height,
                overflows: row.scrollWidth > row.clientWidth + 1,
            }));
            assert.equal(line.flow, 'nowrap');
            assert.ok(line.height >= 44 && line.height < 60);
            assert.equal(line.overflows, false);
        }
        await act(parentRow.locator('.cla-preset-fold-toggle'));
        await assertHidden(page, parentMembers);
        await page.evaluate(async () => (await import('/scripts/openai.js')).promptManager.renderPromptManagerListItems());
        await assertHidden(page, parentMembers);

        await filter.selectOption('enabled');
        await assertHidden(page, parentMembers);
        await filter.selectOption('all');
        await search.fill(child.name);
        assert.equal(await childRow.locator('.cla-preset-fold-toggle').getAttribute('aria-expanded'), 'true');
        await search.fill('');
        await assertHidden(page, parentMembers);
        await act(parentRow.locator('.cla-preset-fold-toggle'));
        assert.equal(await childRow.locator('.cla-preset-fold-toggle').getAttribute('aria-expanded'), 'true');

        await act(button('全部展开'));
        assert.deepEqual(await rendered(page), expectedOrder, 'visual position in the grouped view must match prompt_order');
        const positions = await page.evaluate(({ rows, headers }) => [...document.querySelectorAll(`${rows}, ${headers}`)]
            .filter(row => row.getClientRects().length)
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
            .map(row => row.dataset.pmIdentifier || `folder:${row.dataset.claPresetGroup}`), { rows, headers });
        for (const section of [parent, child]) {
            assert.equal(positions[positions.indexOf(`folder:${section.id}`) + 1], section.sectionKey,
                'folder header should immediately precede its opening divider in the original list');
        }
        await act(button('原始顺序'));
        assert.equal(await page.locator(headers).count(), 0);
        assert.deepEqual(await rendered(page), expectedOrder);
        await act(button('分类浏览'));
        assert.deepEqual(await rendered(page), expectedOrder);

        const persisted = page.waitForResponse(response => response.url().endsWith('/api/settings/save') && response.ok());
        await act(button('全部折叠'));
        await persisted;
        await page.reload();
        await page.locator('.cla-preset-groups').waitFor({ state: 'attached', timeout: 30_000 });
        await openDrawer();
        await parentRow.waitFor();
        assert.deepEqual(await rendered(page), outside);
        await assertHidden(page, assigned);
        assert.equal(await snapshot(page), original);
        console.log(`${mobile ? 'Touch / Cappuccino' : 'Desktop / Dark Lite'}: ${ids.length} rows in original visual order, nested dividers in place, native data unchanged`);
        await context.close();
    }
} finally {
    await browser.close();
}
