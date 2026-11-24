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
        await folder('NSFW').waitFor();
        assert.ok(resources.has(manifest.js.split('/').pop()));
        assert.ok(resources.has(manifest.css.split('/').pop()));
        assert.equal(await page.getByText(/分类建议|待审核|应用审核|按原头尾结构预览/).count(), 0);
        const original = await snapshot(page);
        const [loadedOrder] = JSON.parse(original);
        for (const expected of fixtureOrder) {
            assert.deepEqual(loadedOrder.find(group => String(group.character_id) === String(expected.character_id)), expected);
        }
        const ids = await page.locator(rows).evaluateAll(items => items.map(row => row.dataset.pmIdentifier));
        assert.ok(ids.length >= 100);
        const folders = await metadata(page);
        assert.ok(Object.values(folders.assignments).some(item => item.source === 'auto'));
        const parent = folders.folders.find(item => item.name === 'NSFW' && !item.parentId);
        const children = folders.folders.filter(item => item.parentId === parent.id);
        assert.ok(children.length >= 2, 'fixture should produce more than one NSFW subfolder');
        const child = children.find(item => Object.values(folders.assignments).some(assignment => assignment.folderId === item.id));
        const members = Object.entries(folders.assignments).filter(([, item]) => item.folderId === child.id).map(([id]) => id);
        const descendantCount = Object.values(folders.assignments).filter(item => children.some(child => child.id === item.folderId)).length;
        const parentRow = folder(parent.name), childRow = folder(child.name);
        assert.equal(Number(await parentRow.locator('.cla-preset-fold-count').textContent()), descendantCount);
        assert.equal(await page.locator(headers).locator('[aria-expanded="true"]').count(), 0);
        assert.equal(await childRow.count(), 0);
        await assertHidden(page, ids);

        await act(parentRow.locator('.cla-preset-fold-name'));
        await childRow.waitFor();
        await assertHidden(page, ids);
        await act(childRow.locator('.cla-preset-folder-arrow'));
        assert.deepEqual(await rendered(page), ids.filter(id => members.includes(id)));

        if (mobile) {
            const line = await childRow.evaluate(row => ({
                flow: getComputedStyle(row).flexWrap,
                height: row.getBoundingClientRect().height,
                overflows: row.scrollWidth > row.clientWidth + 1,
            }));
            assert.equal(line.flow, 'nowrap');
            assert.ok(line.height >= 44 && line.height < 60);
            assert.equal(line.overflows, false);
        }
        await act(parentRow.locator('.cla-preset-fold-action'));
        await button('新建子文件夹…').waitFor();
        assert.equal(await parentRow.locator('.cla-preset-fold-toggle').getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('Escape');
        await act(parentRow.locator('.cla-preset-fold-toggle'));
        assert.equal(await childRow.count(), 0);
        await assertHidden(page, ids);

        // Force a true native list rebuild. Never substitute test rows or a fake manager.
        await page.evaluate(async () => (await import('/scripts/openai.js')).promptManager.renderPromptManagerListItems());
        await assertHidden(page, ids);
        await filter.selectOption('enabled');
        await assertHidden(page, ids);
        await filter.selectOption('all');
        await search.fill('NSFW');
        assert.equal(await parentRow.locator('.cla-preset-fold-toggle').getAttribute('aria-expanded'), 'true');
        const searchResults = new Set(await rendered(page));
        assert.ok(members.every(id => searchResults.has(id)));
        await act(childRow.locator('.cla-preset-fold-toggle'));
        await assertHidden(page, members);
        await search.fill('');
        await assertHidden(page, ids);
        assert.equal(await childRow.count(), 0);
        await act(parentRow.locator('.cla-preset-fold-toggle'));
        assert.equal(await childRow.locator('.cla-preset-fold-toggle').getAttribute('aria-expanded'), 'true');
        await act(childRow.locator('.cla-preset-fold-toggle'));
        await assertHidden(page, ids);

        await act(button('全部展开'));
        assert.deepEqual(await rendered(page), ids);
        await act(button('全部折叠'));
        await assertHidden(page, ids);
        await act(button('原始顺序'));
        assert.equal(await page.locator(headers).count(), 0);
        assert.deepEqual(await rendered(page), ids);
        assert.deepEqual(await page.locator(rows).evaluateAll(items => items.map(row => row.dataset.pmIdentifier)), ids);
        await act(button('分类浏览'));
        await assertHidden(page, ids);

        const persisted = page.waitForResponse(response => response.url().endsWith('/api/settings/save') && response.ok());
        await act(parentRow.locator('.cla-preset-fold-toggle'));
        await act(childRow.locator('.cla-preset-fold-toggle'));
        await persisted;
        await page.reload();
        await page.locator('.cla-preset-groups').waitFor({ state: 'attached', timeout: 30_000 });
        await openDrawer();
        await childRow.waitFor();
        assert.equal(await childRow.locator('.cla-preset-fold-toggle').getAttribute('aria-expanded'), 'true');
        assert.deepEqual(await rendered(page), ids.filter(id => members.includes(id)));

        const visible = page.locator(`${rows}:visible`);
        const target = visible.first().locator('.completion_prompt_manager_prompt_name');
        if (mobile) {
            await target.evaluate(async name => {
                name.scrollIntoView({ block: 'center', behavior: 'instant' });
                // Wait for the drawer and the browser's touch hit testing to settle.
                await Promise.all(name.closest('.drawer-content').getAnimations().map(animation => animation.finished.catch(() => {})));
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            });
            const point = await target.boundingBox();
            const cdp = await context.newCDPSession(page);
            const touchPoint = { x: point.x + point.width / 2, y: point.y + point.height / 2 };
            assert.ok(await target.evaluate((name, { x, y }) => name.contains(document.elementFromPoint(x, y)), touchPoint));
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint] });
            await button('批量移动').waitFor();
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await cdp.detach();
        } else {
            await target.click({ modifiers: ['Control'] });
        }
        assert.equal(await page.locator(`${rows}.cla-preset-entry-selected`).count(), 1);
        assert.equal(await page.locator('.cla-preset-bulk-toolbar input[type=checkbox]').count(), 0);
        await act(button('批量移动'));
        const destination = children.find(item => item.id !== child.id);
        await act(button(`NSFW / ${destination.name}`));
        const first = ids.find(id => members.includes(id));
        assert.deepEqual((await metadata(page)).assignments[first], { folderId: destination.id, source: 'manual' });

        await act(button('新建文件夹'));
        await page.getByPlaceholder('新文件夹名称').fill('检查目录');
        await act(button('保存'));
        await act(folder('检查目录').locator('.cla-preset-fold-action'));
        await act(button('重命名…'));
        await page.getByPlaceholder('文件夹新名称').fill('已重命名');
        await act(button('保存'));
        await act(folder('已重命名').locator('.cla-preset-fold-action'));
        await act(button('移动文件夹…'));
        await page.getByLabel('上级文件夹').selectOption(parent.id);
        await act(button('保存'));
        await act(folder('已重命名').locator('.cla-preset-fold-action'));
        await act(button('删除文件夹…'));
        await act(page.locator('dialog[open] .popup-button-ok'));
        await folder('已重命名').waitFor({ state: 'detached' });
        assert.equal(await snapshot(page), original);
        console.log(`${mobile ? 'Touch / Cappuccino' : 'Desktop / Dark Lite'}: ${ids.length} native prompt rows, folders, search/filter, native rebuild, reload and unchanged prompts/prompt_order passed`);
        await context.close();
    }
} finally {
    await browser.close();
}
