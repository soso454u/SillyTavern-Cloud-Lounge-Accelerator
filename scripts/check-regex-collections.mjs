// Optional browser regression check. Install Playwright and set
// CLA_BROWSER_EXECUTABLE when using an existing Chrome installation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const adapterSource = await readFile(new URL('../modules/regex-ui-adapter.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const server = createServer((request, response) => {
    if (request.url === '/adapter.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(adapterSource);
    } else if (request.url === '/regex/engine.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(`
            export const SCRIPT_TYPES = { GLOBAL: 0, PRESET: 1, SCOPED: 2 };
            export const getScriptsByType = type => window.scripts[type] || [];
            export const saveScriptsByType = async (next, type) => {
                window.scripts[type] = next;
                window.saved.push({ next, type });
            };
        `);
    } else if (request.url === '/popup.js' || request.url === '/script.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end('export {};');
    } else {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>');
    }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await chromium.launch({
        headless: true,
        ...(process.env.CLA_BROWSER_EXECUTABLE ? { executablePath: process.env.CLA_BROWSER_EXECUTABLE } : {}),
    });
    for (const viewport of [{ width: 1100, height: 1000 }, { width: 390, height: 844 }]) {
        const page = await browser.newPage({ viewport });
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.addStyleTag({ content: `
            :root { --SmartThemeBodyColor: #333; }
            body { margin: 8px; font: 16px sans-serif; }
            .flex-container { display: flex; gap: 5px; }
            .flexFlowColumn { flex-direction: column; }
            .regex-script-label { display: flex; padding: 8px; gap: 8px; }
            .regex_script_name { flex: 1; }
            .menu_button { padding: 6px; }
            ${styles}
        ` });
        await page.evaluate(async () => {
            const { RegexUiAdapter } = await import('/adapter.js');
            const data = [
                ['a1', '[月下美化]蓝色'],
                ['b1', '【MEET】弹幕'],
                ['plain', '普通正则'],
                ['a2', '[月下美化]白色'],
                ['player', '「播放器」文字'],
            ];
            document.body.innerHTML = `<div id="regex_container"><div class="regex_settings"><div class="inline-drawer-content">
                <div class="flex-container"><label><input id="regex_bulk_edit" type="checkbox">批量编辑</label></div>
                <h3>全局正则</h3><div id="saved_regex_scripts" class="flex-container flexFlowColumn"></div>
                <h3>预设正则</h3><div id="saved_preset_scripts" class="flex-container flexFlowColumn"></div>
                <h3>角色正则</h3><div id="saved_scoped_scripts" class="flex-container flexFlowColumn"></div>
            </div></div></div>`;
            function row(id, name) {
                const element = document.createElement('div');
                element.className = 'regex-script-label';
                element.id = id;
                element.innerHTML = `<input class="regex_bulk_checkbox" type="checkbox"><span class="drag-handle">☰</span>
                    <span class="regex_script_name"></span><input class="disable_regex" type="checkbox">
                    <button class="regex-toggle-on">开关</button><button class="edit_existing_regex">编辑</button>`;
                element.querySelector('.regex_script_name').textContent = name;
                return element;
            }
            const globalList = document.querySelector('#saved_regex_scripts');
            data.forEach(([id, name]) => globalList.append(row(id, name)));
            document.querySelector('#saved_preset_scripts').append(row('preset-a', '[月下美化]预设'), row('preset-plain', '预设普通正则'));
            document.querySelector('#saved_scoped_scripts').append(row('scoped-a', '[月下美化]角色'), row('scoped-plain', '角色普通正则'));
            window.saved = [];
            window.scripts = { 0: data.map(([id, scriptName]) => ({ id, scriptName, disabled: false })) };
            window.adapter = new RegexUiAdapter();
            window.refreshes = 0;
            const enhance = adapter.enhanceRegexUi.bind(adapter);
            adapter.enhanceRegexUi = () => {
                window.refreshes += 1;
                enhance();
            };
            if (!await adapter.start()) throw new Error('adapter startup failed');
            window.originalRows = data.map(([id]) => document.getElementById(id));
            window.nativeIds = () => [...globalList.children].map(node => node.id).filter(Boolean);
        });
        await page.waitForFunction(() => adapter.organizerButton?.isConnected);
        const initialIds = ['a1', 'b1', 'plain', 'a2', 'player'];
        assert.deepEqual(await page.evaluate(() => nativeIds()), initialIds);
        assert.equal(await page.locator('.cla-regex-organizer [data-cla-regex-fold]').count(), 0);
        assert.equal(await page.locator('#a1').isVisible(), false);
        assert.equal(await page.locator('#plain').isVisible(), true);
        assert.equal(await page.locator('#player').isVisible(), false);

        const ungrouped = [
            ['saved_regex_scripts', 'plain'],
            ['saved_preset_scripts', 'preset-plain'],
            ['saved_scoped_scripts', 'scoped-plain'],
        ];
        for (let index = 0; index < ungrouped.length; index += 1) {
            const [listId] = ungrouped[index];
            await page.locator(`#${listId} [data-cla-regex-fold="未分类"] .cla-regex-collection-toggle`).click();
            for (let other = 0; other < ungrouped.length; other += 1) {
                assert.equal(await page.locator(`#${ungrouped[other][1]}`).isVisible(), other > index,
                    'collapsing unclassified in one scope must leave the other scopes unchanged');
            }
        }
        await page.evaluate(() => adapter.refreshOrganizerRows());
        for (const [listId, rowId] of ungrouped) {
            assert.equal(await page.locator(`#${rowId}`).isVisible(), false, 'refresh must preserve each collapsed scope');
            await page.locator(`#${listId} [data-cla-regex-fold="未分类"] .cla-regex-collection-toggle`).click();
            assert.equal(await page.locator(`#${rowId}`).isVisible(), true);
        }

        const header = page.locator('#saved_regex_scripts [data-cla-regex-fold="月下美化"]');
        await header.locator('.cla-regex-collection-select').click();
        assert.equal(await page.locator('#a1 .regex_bulk_checkbox').isChecked(), true);
        assert.equal(await page.locator('#a2 .regex_bulk_checkbox').isChecked(), true);
        assert.equal(await page.locator('#preset-a .regex_bulk_checkbox').isChecked(), false);
        assert.equal(await page.locator('#a1').isVisible(), false);
        await header.locator('.cla-regex-collection-toggle').click();
        assert.equal(await page.locator('#a1').isVisible(), true);
        assert.equal(await page.locator('#a2').isVisible(), true);
        assert.equal(await page.locator('#preset-a').isVisible(), false, 'same named collection in preset stays collapsed');
        assert.equal(await page.locator('#scoped-a').isVisible(), false, 'same named collection in character stays collapsed');
        const [headingBox, firstBox, secondBox, nextHeadingBox] = await Promise.all([
            header.boundingBox(), page.locator('#a1').boundingBox(), page.locator('#a2').boundingBox(),
            page.locator('#saved_regex_scripts [data-cla-regex-fold="MEET"]').boundingBox(),
        ]);
        assert.ok(headingBox.y < firstBox.y && firstBox.y < secondBox.y && secondBox.y < nextHeadingBox.y,
            'non-adjacent native rows must appear together immediately below their collection');
        assert.deepEqual(await page.evaluate(() => adapter.getVisibleRows().map(row => row.id)), ['a1', 'a2', 'plain', 'preset-plain', 'scoped-plain']);
        const presetToggle = page.locator('#saved_preset_scripts [data-cla-regex-fold="月下美化"] .cla-regex-collection-toggle');
        await presetToggle.click();
        assert.equal(await page.locator('#preset-a').isVisible(), true);
        assert.equal(await page.locator('#a1').isVisible(), true);
        assert.equal(await page.locator('#scoped-a').isVisible(), false);
        await presetToggle.click();
        assert.equal(await page.locator('#a1').isVisible(), true, 'collapsing preset collection must not collapse global');
        assert.deepEqual(await page.evaluate(() => nativeIds()), initialIds);
        assert.equal(await page.evaluate(() => originalRows.every(row => row.parentElement.id === 'saved_regex_scripts')), true);
        if (process.env.CLA_REGEX_SCREENSHOT_PREFIX) {
            await page.screenshot({ path: `${process.env.CLA_REGEX_SCREENSHOT_PREFIX}-${viewport.width}.png`, fullPage: true });
        }
        await page.locator('#a1 .regex-toggle-on').click();
        await page.evaluate(() => adapter.saveQueue);
        assert.equal(await page.evaluate(() => saved[0].next.find(script => script.id === 'a1').disabled), true);

        await page.locator('.cla-regex-organizer-toggle').click();
        await page.locator('[data-cla-regex-search]').fill('白色');
        assert.equal(await page.locator('#a1').isVisible(), false);
        assert.equal(await page.locator('#a2').isVisible(), true);
        assert.equal(await header.locator('small').textContent(), '1 条');
        await page.locator('[data-cla-regex-search]').fill('');
        await header.locator('.cla-regex-collection-toggle').click();
        assert.equal(await page.locator('#a2').isVisible(), false);
        // Closing the organizer must leave inline folding active.
        await page.locator('.cla-regex-organizer-toggle').click();
        assert.equal(await page.locator('#a1').isVisible(), false);

        await page.evaluate(() => {
            document.querySelector('#b1 .regex_script_name').textContent = '[月下美化]第三条';
        });
        await page.waitForFunction(() => document.querySelector('#b1').dataset.claRegexCollection === '月下美化');
        assert.equal(await page.locator('#saved_regex_scripts [data-cla-regex-fold="MEET"]').count(), 0);
        assert.equal(await header.locator('small').textContent(), '3 条');
        assert.equal(await page.locator('#b1').isVisible(), false);
        const settledRefreshes = await page.evaluate(() => refreshes);
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 120)));
        assert.equal(await page.evaluate(() => refreshes), settledRefreshes, 'own collection headers must not cause a refresh loop');

        await page.locator('.cla-regex-reorder-toggle').click();
        assert.equal(await page.locator('[data-cla-regex-fold]').count(), 0);
        assert.equal(await page.locator('#a1 .drag-handle').isVisible(), true);
        assert.deepEqual(await page.evaluate(() => nativeIds()), initialIds);
        await page.evaluate(() => {
            // Match native sortable's direct-child order and persistence contract.
            const list = document.querySelector('#saved_regex_scripts');
            list.insertBefore(document.querySelector('#a2'), document.querySelector('#a1'));
        });
        const reorderedIds = ['a2', 'a1', 'b1', 'plain', 'player'];
        await page.locator('.cla-regex-reorder-toggle').click();
        assert.deepEqual(await page.evaluate(() => nativeIds()), reorderedIds);
        await page.locator('.cla-regex-organizer-toggle').click();
        await page.locator('[data-cla-regex-auto-collapse]').uncheck();
        assert.equal(await page.locator('[data-cla-regex-fold]').count(), 0);
        assert.equal(await page.locator('#a1').isVisible(), true);
        assert.equal(await page.locator('#a1 .drag-handle').isVisible(), true);
        await page.locator('[data-cla-regex-auto-collapse]').check();
        await page.evaluate(() => adapter.stop());
        assert.equal(await page.locator('[data-cla-regex-fold]').count(), 0);
        assert.deepEqual(await page.evaluate(() => nativeIds()), reorderedIds);
        assert.equal(await page.locator('#a1').isVisible(), true);
        assert.equal(await page.evaluate(() => originalRows.every(row => !row.style.getPropertyValue('--cla-regex-order'))), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        console.log(`PASS ${viewport.width}px: independent scope folds, inline layout, native rows/actions/order, search, selection, mutation refresh and cleanup`);
        await page.close();
    }
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
