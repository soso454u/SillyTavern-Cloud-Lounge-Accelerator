// Optional browser regression check. Install Playwright and set
// CLA_BROWSER_EXECUTABLE when using an existing Chrome installation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const adapterSource = await readFile(new URL('../modules/regex-ui-adapter.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const themeStyles = process.env.CLA_REGEX_THEME_CSS ? await readFile(process.env.CLA_REGEX_THEME_CSS,'utf8') : '';
const server = createServer((request, response) => {
    if (request.url === '/adapter.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(adapterSource);
    } else if (request.url === '/regex/engine.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(`
            export const SCRIPT_TYPES = { GLOBAL: 0, PRESET: 1, SCOPED: 2 };
            export const getScriptsByType = type => window.scripts[type] || [];
            export const getCurrentPresetAPI = () => 'openai';
            export const getCurrentPresetName = () => 'test-preset';
            export const saveScriptsByType = async (next, type) => {
                window.scripts[type] = next;
                window.saved.push({ next, type });
            };
        `);
    } else if (request.url === '/script.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end('export const characters=[{avatar:"test.png"}];export const this_chid=0;export const saveSettingsDebounced=()=>window.groupSaves=(window.groupSaves||0)+1;');
    } else if (request.url === '/popup.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end('export {};');
    } else {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>');
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
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
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
            ${themeStyles}
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
            window.scripts = { 0: data.map(([id, scriptName]) => ({ id, scriptName, disabled: false })),
                1:[{id:'preset-a',scriptName:'[月下美化]预设'},{id:'preset-plain',scriptName:'预设普通正则'}],
                2:[{id:'scoped-a',scriptName:'[月下美化]角色'},{id:'scoped-plain',scriptName:'角色普通正则'}] };
            window.collectionSettings = {};
            window.adapter = new RegexUiAdapter({extensionSettings:collectionSettings});
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
            scripts[0].find(script=>script.id==='b1').scriptName='[月下美化]第三条';
        });
        await page.waitForFunction(() => document.querySelector('#b1').dataset.claRegexCollection === '月下美化');
        assert.equal(await page.locator('#saved_regex_scripts [data-cla-regex-fold="MEET"]').count(), 0);
        assert.equal(await header.locator('small').textContent(), '3 条');
        assert.equal(await page.locator('#b1').isVisible(), false);
        const settledRefreshes = await page.evaluate(() => refreshes);
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 120)));
        assert.equal(await page.evaluate(() => refreshes), settledRefreshes, 'own collection headers must not cause a refresh loop');

        const originalScripts = await page.evaluate(()=>JSON.stringify(scripts));
        await page.locator('.cla-regex-organizer-toggle').click();
        await page.locator('.cla-regex-group-manager summary').click();
        await page.locator('[data-cla-regex-new-name]').fill('自建空组');
        await page.locator('[data-cla-regex-action="create-collection"]').click();
        assert.equal(await page.locator('#saved_regex_scripts [data-cla-regex-fold="自建空组"]').isVisible(),true);
        assert.equal(await page.locator('#saved_regex_scripts [data-cla-regex-fold="自建空组"] small').textContent(),'0 条');
        await page.locator('[data-cla-regex-action="clear"]').click();
        await header.locator('.cla-regex-collection-toggle').click();
        await page.locator('#a1 .regex_script_name').click();
        await page.locator('#a2 .regex_script_name').click();
        await page.locator('[data-cla-regex-move-target]').selectOption('自建空组');
        await page.locator('[data-cla-regex-action="move-selected"]').click();
        assert.deepEqual(await page.evaluate(()=>['a1','a2'].map(id=>document.getElementById(id).dataset.claRegexCollection)),['自建空组','自建空组']);
        const customName='自定义分组名字很长也应该自动换行不撑出边框';
        await page.locator('#saved_regex_scripts [data-cla-regex-fold="自建空组"] .cla-regex-collection-rename').click();
        await page.locator('.cla-regex-rename-form:not([hidden]) input').fill(customName);
        await page.locator('.cla-regex-rename-form:not([hidden]) input').press('Enter');
        assert.equal(await page.locator('#saved_regex_scripts [data-cla-regex-fold="自建空组"]').count(),0);
        assert.equal(await page.locator(`#saved_regex_scripts [data-cla-regex-fold="${customName}"]`).isVisible(),true);
        assert.equal(await page.evaluate(()=>JSON.stringify(scripts)),originalScripts,'grouping never rewrites native rule definitions');
        assert.deepEqual(await page.evaluate(()=>nativeIds()),initialIds);
        const savesBeforeDuplicate=await page.evaluate(()=>groupSaves);
        await page.locator('[data-cla-regex-new-name]').fill(customName);
        await page.locator('[data-cla-regex-action="create-collection"]').click();
        assert.match(await page.locator('[data-cla-regex-feedback]').textContent(),/同名/);
        assert.equal(await page.evaluate(()=>groupSaves),savesBeforeDuplicate);
        await page.evaluate(async()=>{
            const {RegexUiAdapter}=await import('/adapter.js');
            adapter.stop();
            window.collectionSettings=JSON.parse(JSON.stringify(collectionSettings));
            window.adapter=new RegexUiAdapter({extensionSettings:collectionSettings});
            await adapter.start();
        });
        await page.waitForFunction(()=>document.querySelector('.cla-regex-organizer-toggle'));
        assert.equal(await page.evaluate(()=>document.getElementById('a1').dataset.claRegexCollection),customName,'groups survive serialized settings and adapter restart');
        await page.locator('.cla-regex-organizer-toggle').click();
        await page.locator('.cla-regex-group-manager summary').click();
        await page.locator(`#saved_regex_scripts [data-cla-regex-fold="${customName}"] .cla-regex-collection-toggle`).click();
        await page.evaluate(()=>{
            window.originalRuleTitle=document.querySelector('#a1 .regex_script_name').textContent;
            document.querySelector('#a1 .regex_script_name').textContent='01 | 社交动态 | 正文 | 超长规则名称'.repeat(8);
        });
        // Desktop sidebar columns can be narrower than the mobile breakpoint.
        for(const fontSize of [16,22])for(const width of [260,320,480,Math.min(760,viewport.width-16)]) {
            await page.evaluate(({width,fontSize})=>{
                document.querySelector('#regex_container').style.width=width+'px';
                document.querySelector('#regex_container').style.maxWidth='100%';
                document.querySelector('#regex_container').style.fontSize=fontSize+'px';
            },{width,fontSize});
            const overflow=await page.evaluate(()=>{
                const root=document.querySelector('#regex_container');
                const elements=[...root.querySelectorAll('.cla-regex-organizer, .cla-regex-organizer input, .cla-regex-organizer select, .cla-regex-organizer button, .cla-regex-collection-header, .cla-regex-collection-header button, .regex-script-label, .regex-script-label > *')];
                const rect=root.getBoundingClientRect();
                return elements.filter(node=>node.getClientRects().length).filter(node=>{
                    const box=node.getBoundingClientRect();return box.right>rect.right+1||box.left<rect.left-1;
                }).map(node=>({node:node.className,width:node.getBoundingClientRect().width}));
            });
            assert.deepEqual(overflow,[],`controls fit a ${width}px sidebar / ${fontSize}px font at viewport ${viewport.width}px`);
            const customHeader=page.locator(`#saved_regex_scripts [data-cla-regex-fold="${customName}"]`);
            await customHeader.locator('.cla-regex-collection-rename').click();
            const formOverflow=await customHeader.locator('.cla-regex-rename-form').evaluate(form=>{
                const box=form.closest('.cla-regex-collection-header').getBoundingClientRect();
                return [...form.children].some(node=>{const rect=node.getBoundingClientRect();return rect.right>box.right+1||rect.left<box.left-1;});
            });
            assert.equal(formOverflow,false,`inline rename form fits ${width}px sidebar / ${fontSize}px font`);
            await customHeader.locator('.cla-regex-rename-form input').press('Escape');
        }
        if(process.env.CLA_REGEX_SCREENSHOT_PREFIX)await page.screenshot({path:`${process.env.CLA_REGEX_SCREENSHOT_PREFIX}-groups-${viewport.width}.png`,fullPage:true});
        await page.evaluate(()=>{
            document.querySelector('#regex_container').style.width='';
            document.querySelector('#regex_container').style.fontSize='';
            document.querySelector('#a1 .regex_script_name').textContent=originalRuleTitle;
        });

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
        assert.equal(await page.locator('[data-cla-regex-scope-actions]').count(), 0);

        // Reproduce the reported numbered packs, then use each local create button.
        await page.evaluate(async () => {
            const {RegexUiAdapter} = await import('/adapter.js');
            const names = {a1:'01 | 社交动态 | 正文', a2:'19 | 社交动态 | 微博 · 动态外观',
                plain:'00b | iMessage | 会话视角', 'preset-plain':'01 | iMessage | 连续消息',
                'scoped-plain':'16 | iMessage | 文字气泡'};
            for (const [id, name] of Object.entries(names)) {
                document.querySelector('#'+id+' .regex_script_name').textContent = name;
                Object.values(scripts).flat().find(script => script.id === id).scriptName = name;
            }
            window.quickOriginalScripts = JSON.stringify(scripts);
            window.quickNativeWrites = saved.length;
            window.collectionSettings = {};
            window.adapter = new RegexUiAdapter({extensionSettings:collectionSettings});
            await adapter.start();
        });
        await page.waitForFunction(() => document.querySelector('#plain').dataset.claRegexCollection === 'iMessage');
        assert.deepEqual(await page.evaluate(() => ['a1','a2'].map(id=>document.getElementById(id).dataset.claRegexCollection)), ['社交动态','社交动态']);
        assert.deepEqual(await page.evaluate(() => ['plain','preset-plain','scoped-plain'].map(id=>document.getElementById(id).dataset.claRegexCollection)), ['iMessage','iMessage','iMessage']);
        assert.equal(await page.locator('#saved_regex_scripts [data-cla-regex-fold="社交动态"] small').textContent(), '2 条');
        assert.equal(await page.locator('[data-cla-regex-create-scope]').count(), 3);
        assert.equal(await page.locator('#saved_regex_scripts [data-cla-regex-create-scope]').count(), 0, 'create controls stay outside native sortable lists');
        for (const [scope, list] of [['GLOBAL','saved_regex_scripts'], ['PRESET','saved_preset_scripts'], ['SCOPED','saved_scoped_scripts']]) {
            await page.locator(`[data-cla-regex-create-scope="${scope}"]`).click();
            const group = page.locator(`#${list} [data-cla-regex-fold="新分组"]`);
            assert.equal(await group.isVisible(), true);
            assert.equal(await group.locator('small').textContent(), '0 条');
            assert.equal(await group.locator('.cla-regex-rename-form').isVisible(), true);
            assert.equal(await group.locator('input').evaluate(input => input === document.activeElement), true);
            if (scope === 'SCOPED') {
                await group.locator('input').fill('手机工具');
                await group.locator('input').press('Enter');
            } else await group.locator('input').press('Escape');
        }
        await page.locator('[data-cla-regex-create-scope="GLOBAL"]').click();
        await page.locator('#saved_regex_scripts [data-cla-regex-fold="新分组2"] input').press('Escape');
        await page.evaluate(() => adapter.moveRowsToCollection([document.getElementById('scoped-plain')], '手机工具'));
        assert.equal(await page.locator('#saved_scoped_scripts [data-cla-regex-fold="手机工具"] small').textContent(), '1 条');
        assert.equal(await page.evaluate(() => JSON.stringify(scripts) === quickOriginalScripts && saved.length === quickNativeWrites), true, 'recognition and empty groups preserve every native definition and order');
        assert.deepEqual(await page.evaluate(() => nativeIds()), reorderedIds);
        const scopesSettled = await page.evaluate(() => refreshes);
        await page.waitForTimeout(120);
        assert.equal(await page.evaluate(() => refreshes), scopesSettled, 'local create toolbars cannot cause mutation loops');
        if (process.env.CLA_REGEX_SCREENSHOT_PREFIX) await page.screenshot({path:`${process.env.CLA_REGEX_SCREENSHOT_PREFIX}-numbered-${viewport.width}.png`,fullPage:true});
        await page.evaluate(async () => {
            const {RegexUiAdapter} = await import('/adapter.js');
            adapter.stop();
            window.collectionSettings = JSON.parse(JSON.stringify(collectionSettings));
            window.adapter = new RegexUiAdapter({extensionSettings:collectionSettings});
            await adapter.start();
        });
        await page.waitForFunction(() => document.querySelector('#scoped-plain').dataset.claRegexCollection === '手机工具');
        assert.equal(await page.locator('#saved_regex_scripts [data-cla-regex-fold="新分组2"]').count(), 1);
        await page.locator('#saved_regex_scripts [data-cla-regex-fold="社交动态"] .cla-regex-collection-select').click();
        assert.equal(await page.locator('#a1 .regex_bulk_checkbox').isChecked(), true);
        assert.equal(await page.locator('#a2 .regex_bulk_checkbox').isChecked(), true);
        await page.evaluate(() => {
            document.querySelectorAll('#saved_scoped_scripts .regex-script-label').forEach(row => row.remove());
            scripts[2] = [];
            adapter.saveCollectionState('SCOPED', {groups:[], assignments:{}});
            adapter.refreshOrganizerRows();
        });
        assert.equal(await page.locator('#saved_scoped_scripts [data-cla-regex-fold]').count(), 0);
        await page.locator('[data-cla-regex-create-scope="SCOPED"]').click();
        assert.equal(await page.locator('#saved_scoped_scripts [data-cla-regex-fold="新分组"] small').textContent(), '0 条', 'a scope with no rules still supports its first empty group');
        await page.locator('#saved_scoped_scripts [data-cla-regex-fold="新分组"] input').press('Escape');
        await page.evaluate(() => adapter.stop());
        assert.equal(await page.locator('[data-cla-regex-scope-actions]').count(), 0);
        assert.deepEqual(await page.evaluate(() => nativeIds()), reorderedIds);
        assert.deepEqual(errors, []);
        console.log(`PASS ${viewport.width}px: numbered pack recognition, per-scope quick empty groups, rename/move/persistence, 260–760px sidebar layout, native rows/actions/order, search, selection and cleanup`);
        await page.close();
    }
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
