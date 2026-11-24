// Disposable real SillyTavern only. No simplified DOM or external requests.
// CLA_TAVERN_URL=http://127.0.0.1:18781 CLA_PRESET_FIXTURE=/path/to/preset.json node scripts/check-preset-entry-groups.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { CLA_TAVERN_URL, CLA_PRESET_FIXTURE, CLA_BROWSER_EXECUTABLE } = process.env;
assert.ok(CLA_TAVERN_URL && CLA_PRESET_FIXTURE, 'Set CLA_TAVERN_URL and CLA_PRESET_FIXTURE');
const base = new URL(CLA_TAVERN_URL);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use a local disposable SillyTavern');
const fixture = await readFile(CLA_PRESET_FIXTURE), manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(CLA_BROWSER_EXECUTABLE ? { executablePath: CLA_BROWSER_EXECUTABLE } : {}) });
const list = '#completion_prompt_manager_list', rows = `${list} [data-pm-identifier]`;
const metadata = page => page.evaluate(async () => {
    const { promptManager: m, oai_settings: s } = await import('/scripts/openai.js');
    return window.SillyTavern.getContext().extensionSettings.cloud_lounge_accelerator_preset_groups[JSON.stringify(['openai', s.preset_settings_openai, String(m.activeCharacter.id)])];
});
const nativeSnapshot = page => page.evaluate(async () => { const m = (await import('/scripts/openai.js')).promptManager; return JSON.stringify([m.serviceSettings.prompts, m.serviceSettings.prompt_order]); });
const rerender = page => page.evaluate(async () => (await import('/scripts/openai.js')).promptManager.renderPromptManagerListItems());
try {
    for (const mobile of process.env.CLA_MOBILE_ONLY ? [true] : [false, true]) {
        const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
        await context.route('**/*', route => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort());
        const page = await context.newPage(), resources = new Set(), errors = [];
        page.setDefaultTimeout(10_000); page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => { if (response.ok() && response.url().includes('/cloud-lounge-accelerator/dist/')) resources.add(response.url().split('/dist/')[1]); });
        const act = locator => mobile ? locator.tap() : locator.click();
        const button = name => page.getByRole('button', { name, exact: true });
        const folder = name => page.locator('.cla-preset-folder').filter({ has: page.locator(':scope > .cla-preset-fold-header .cla-preset-fold-name').getByText(name, { exact: true }) });
        const header = name => folder(name).locator(':scope > .cla-preset-fold-header');
        const toggle = name => header(name).locator('.cla-preset-fold-toggle');
        const settings = page.locator('.cla-preset-settings');
        const openDrawer = async () => { if (await page.locator('#leftNavDrawerIcon').evaluate(icon => icon.classList.contains('closedIcon'))) await act(page.locator('#leftNavDrawerIcon')); };
        await page.goto(base.href);
        await page.waitForFunction(() => !!window.SillyTavern?.getContext?.().extensionSettings);
        if (await page.locator('#main_api').inputValue() !== 'openai') { await act(page.locator('#API-status-top')); await page.locator('#main_api').selectOption('openai'); }
        await page.locator('#themes').selectOption(mobile ? 'Cappuccino' : 'Dark Lite', { force: true });
        await openDrawer();
        await page.locator('dialog[open]').waitFor({ state: 'hidden' });
        const name = `CLA 2.1.80 ${mobile ? 'touch' : 'desktop'} ${Date.now()}`;
        await page.locator('#openai_preset_import_file').setInputFiles({ name: `${name}.json`, mimeType: 'application/json', buffer: fixture });
        const ready = page.waitForFunction(name => window.SillyTavern.getContext().chatCompletionSettings.preset_settings_openai === name && Object.keys(window.SillyTavern.getContext().extensionSettings.cloud_lounge_accelerator_preset_groups || {}).some(key => JSON.parse(key)[1] === name), name);
        const proxy = page.locator('dialog[open]').getByRole('button', { name: 'Remove them', exact: true });
        if (await Promise.race([proxy.waitFor({ state: 'visible' }).then(() => true), ready.then(() => false)])) await act(proxy);
        await ready;
        const embedded = page.locator('dialog[open]').filter({ hasText: /内置正则|内建正则|embedded regex|preset contains.*regex/i });
        if (await embedded.count()) await act(embedded.locator('.popup-button-cancel'));
        await page.locator('dialog[open]').waitFor({ state: 'hidden' });
        const original = await nativeSnapshot(page), ids = await page.locator(rows).evaluateAll(items => items.map(item => item.dataset.pmIdentifier));
        assert.ok(ids.length >= 100); assert.equal(new Set(ids).size, ids.length);
        assert.ok(resources.has(manifest.js.split('/').pop())); assert.ok(resources.has(manifest.css.split('/').pop()));
        assert.equal(await settings.evaluate(node => node.open), false);
        assert.equal(await button('全部展开').isVisible(), false);
        assert.ok((await metadata(page)).folders.some(item => item.name === 'NSFW'));
        await act(button('原始顺序'));
        const expected = await page.evaluate(async () => { const m = (await import('/scripts/openai.js')).promptManager; return m.getPromptOrderForCharacter(m.activeCharacter).map(item => item.identifier); });
        assert.deepEqual(await page.locator(`${list} > [data-pm-identifier]`).evaluateAll(items => items.map(item => item.dataset.pmIdentifier)), expected);
        await act(button('分类浏览')); await rerender(page);
        assert.equal(await page.locator(rows).count(), expected.length, 'native rerender must not retain stale duplicate rows');
        await act(settings.locator('summary')); await act(button('全部展开'));
        const enabled = page.getByLabel('箭头方括号 · 内置'); await enabled.uncheck();
        assert.equal(await folder('NSFW').count(), 0, 'disabling rule restores ordinary entries');
        await act(button('+ 添加自定义规则'));
        await page.getByRole('textbox', { name: '规则名称', exact: true }).fill('自定义箭头');
        await page.getByLabel('高级正则表达式', { exact: true }).check();
        await page.getByRole('textbox', { name: '开始标记模板', exact: true }).fill('[');
        await page.getByRole('textbox', { name: '结束标记模板', exact: true }).fill('x');
        await act(button('保存规则')); assert.match(await page.locator('.cla-preset-rule-editor [role=alert]').textContent(), /正则表达式无效/);
        await page.getByLabel('高级正则表达式', { exact: true }).uncheck();
        await page.getByRole('textbox', { name: '开始标记模板', exact: true }).fill('====↓[{name}]↓====');
        await page.getByRole('textbox', { name: '结束标记模板', exact: true }).fill('====↑[{name}]↑====');
        await act(button('保存规则')); assert.equal(await folder('NSFW').count(), 1);
        await page.screenshot({ path: `/tmp/cla-2180-settings-${mobile ? 'touch' : 'desktop'}.png` });
        await page.getByLabel('单标题等号 · 内置').check(); await page.getByLabel('头尾识别模式', { exact: true }).selectOption('mixed');
        assert.ok((await metadata(page)).folders.some(item => item.name === '基调等'), 'explicit heading mode recognizes real single title');
        await act(settings.locator('summary'));
        // Seed only display metadata; the real prompts and order remain untouched.
        const seeded = await page.evaluate(async () => {
            const { promptManager: m, oai_settings: s } = await import('/scripts/openai.js');
            const key = JSON.stringify(['openai', s.preset_settings_openai, String(m.activeCharacter.id)]), store = window.SillyTavern.getContext().extensionSettings.cloud_lounge_accelerator_preset_groups;
            const entries = m.getPromptOrderForCharacter(m.activeCharacter).map(item => item.identifier);
            const state = store[key]; state.recognition.mode = 'off'; state.folders = [{ id: 'parent', name: '测试父目录', parentId: null }, { id: 'child', name: '测试子目录', parentId: 'parent' }, { id: 'middle', name: '测试中段', parentId: null }, { id: 'bottom', name: '测试长尾', parentId: null }];
            state.assignments = Object.fromEntries(entries.map((id, index) => [id, { folderId: index % 11 === 0 ? 'child' : index < 60 ? 'parent' : index < 130 ? 'middle' : 'bottom', source: 'manual' }]));
            state.collapsed = []; await m.renderPromptManagerListItems();
            return { entries, child: entries.filter(id => state.assignments[id].folderId === 'child') };
        });
        assert.equal(await page.locator(rows).count(), expected.length);
        assert.equal(await folder('测试父目录').count(), 1); assert.equal(await folder('测试子目录').count(), 1);
        await toggle('测试子目录').evaluate(node => { window.claStableHeader = node; });
        await act(toggle('测试子目录'));
        assert.equal(await folder('测试子目录').locator('[data-pm-identifier]').evaluateAll(items => items.every(item => item.getClientRects().length === 0)), true);
        await act(toggle('测试父目录'));
        assert.equal(await folder('测试父目录').locator('[data-pm-identifier]').evaluateAll(items => items.every(item => item.getClientRects().length === 0)), true);
        await act(toggle('测试父目录'));
        assert.equal(await toggle('测试子目录').getAttribute('aria-expanded'), 'false');
        assert.equal(await toggle('测试子目录').evaluate(node => node === window.claStableHeader), true);
        // Real nested drawer scroll frame, middle and long bottom collapse, 10 repeats.
        for (const target of ['测试中段', '测试长尾']) {
            const positions = [];
            await header(target).evaluate(node => {
                const frames = []; for (let p = node.parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY)) frames.push(p);
                const frame = frames.find(p => p.scrollHeight > p.clientHeight) || document.scrollingElement;
                frame.scrollTop += node.getBoundingClientRect().top - frame.getBoundingClientRect().top - Math.min(180, frame.clientHeight / 3);
            });
            for (let index = 0; index < 10; index++) {
                const before = await header(target).evaluate(node => node.getBoundingClientRect().top);
                await act(toggle(target)); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                const after = await header(target).evaluate(node => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom, clamped: (() => { for (let p=node.parentElement; p; p=p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight && p.scrollTop >= p.scrollHeight-p.clientHeight-2) return true; return false; })() }));
                assert.ok(after.bottom > 0 && after.top < (mobile ? 844 : 900), 'clicked heading stays visible after height clamp');
                assert.ok(Math.abs(after.top - before) < 3 || (after.clamped && await toggle(target).getAttribute('aria-expanded') === 'false'), `anchor drift without height clamp ${target}: ${before} -> ${after.top}`); positions.push(after.top);
            }
            assert.ok(Math.max(...positions) - Math.min(...positions) < 3, 'ten toggles do not accumulate drift');
        }
        await page.getByRole('searchbox', { name: '搜索名称或内容' }).fill('测试子目录');
        assert.equal(await toggle('测试子目录').getAttribute('aria-expanded'), 'true');
        await page.getByRole('searchbox', { name: '搜索名称或内容' }).fill('');
        assert.equal(await toggle('测试子目录').getAttribute('aria-expanded'), 'false');
        await page.getByLabel('条目筛选').selectOption('enabled'); await page.getByLabel('条目筛选').selectOption('all');
        assert.equal(await toggle('测试子目录').getAttribute('aria-expanded'), 'false');
        await rerender(page); assert.equal(await page.locator(rows).count(), expected.length);
        assert.equal(await toggle('测试子目录').getAttribute('aria-expanded'), 'false');
        // Long hold uses actual touch/mouse events; edit/toggle remain native.
        await act(toggle('测试子目录'));
        const first = folder('测试子目录').locator('[data-pm-identifier]').first(), nameCell = first.locator('.completion_prompt_manager_prompt_name');
        await nameCell.scrollIntoViewIfNeeded(); const box = await nameCell.boundingBox();
        if (mobile) {
            const cdp = await context.newCDPSession(page);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 15, y: box.y + box.height / 2 }] });
            await new Promise(resolve => setTimeout(resolve, 560));
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else { await page.mouse.move(box.x + 15, box.y + box.height / 2); await page.mouse.down(); await new Promise(resolve => setTimeout(resolve, 560)); await page.mouse.up(); }
        assert.equal(await first.getAttribute('aria-selected'), 'true'); assert.notEqual(await first.evaluate(node => getComputedStyle(node).outlineStyle), 'none'); assert.equal(await first.locator('input[type=checkbox]').count(), 0);
        // Editing controls must work during multi-select, without saving a draft.
        const editable = page.locator(`${rows}:has(.prompt-manager-edit-action)`).filter({ visible: true }).first();
        const editId = await editable.getAttribute('data-pm-identifier');
        await act(editable.locator('.prompt-manager-edit-action'));
        assert.equal(await page.locator('#completion_prompt_manager_popup_entry_form_save').getAttribute('data-pm-prompt'), editId);
        await act(page.locator('#completion_prompt_manager_popup_entry_form_close'));
        await act(button('取消'));
        assert.equal(await nativeSnapshot(page), original, 'all classification/fold/rule operations must leave every native byte unchanged');
        await act(button('原始顺序'));
        assert.deepEqual(await page.locator(`${list} > [data-pm-identifier]`).evaluateAll(items => items.map(item => item.dataset.pmIdentifier)), expected);
        await act(button('分类浏览')); await act(toggle('测试子目录'));
        await header('测试父目录').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `/tmp/cla-2180-${mobile ? 'touch' : 'desktop'}.png` });
        // The native toggle still works on the reparented native row.
        const toggleRow = page.locator(`${rows}:has(.prompt-manager-toggle-action)`).filter({ visible: true }).first();
        const toggleId = await toggleRow.getAttribute('data-pm-identifier');
        await act(toggleRow.locator('.prompt-manager-toggle-action'));
        await act(page.locator(`${rows}[data-pm-identifier="${toggleId}"] .prompt-manager-toggle-action`));
        assert.equal(await nativeSnapshot(page), original, 'two native toggles restore the original enabled state');
        // Save/reload and switch away/back, including custom templates.
        const saved = await metadata(page), selectedPreset = await page.locator('#settings_preset_openai').inputValue();
        const persisted = page.waitForResponse(response => response.url().endsWith('/api/settings/save') && response.ok());
        await page.evaluate(async () => (await import('/script.js')).saveSettingsDebounced()); await persisted;
        const other = await page.locator('#settings_preset_openai option').evaluateAll((options, current) => options.find(option => option.value !== current)?.value, selectedPreset);
        await page.locator('#settings_preset_openai').selectOption(other);
        await page.waitForFunction(() => !document.querySelector('[data-cla-preset-group="parent"]'));
        await page.locator('#settings_preset_openai').selectOption(selectedPreset);
        await header('测试父目录').waitFor();
        assert.deepEqual((await metadata(page)).collapsed, saved.collapsed);
        assert.deepEqual((await metadata(page)).recognition, saved.recognition);
        await page.reload(); await page.locator('.cla-preset-groups').waitFor({ state: 'attached' }); await openDrawer();
        await header('测试父目录').waitFor();
        assert.deepEqual((await metadata(page)).collapsed, saved.collapsed);
        assert.deepEqual((await metadata(page)).recognition, saved.recognition);
        // Exercise malformed markers through the real renderer, retaining the
        // real preset's size/content and changing names only in this fixture.
        const boundary = await page.evaluate(async () => {
            const { promptManager: m, oai_settings: s } = await import('/scripts/openai.js');
            const key = JSON.stringify(['openai', s.preset_settings_openai, String(m.activeCharacter.id)]), store = window.SillyTavern.getContext().extensionSettings.cloud_lounge_accelerator_preset_groups;
            const entries = m.getPromptOrderForCharacter(m.activeCharacter), names = ['====↓[重复]↓====', '普通甲', '====↑[重复]↑====', '====↓[重复]↓====', '普通乙', '====↑[重复]↑====', '====↓[交叉甲]↓====', '====↓[交叉乙]↓====', '正文', '====↑[交叉甲]↑====', '====↑[交叉乙]↑====', '『 错误开始', '错误结束 』', '====↓[缺失]↓====', '普通丙', '普通丁'];
            const changes = new Map(entries.slice(0, names.length).map((item, index) => [item.identifier, names[index]]));
            m.serviceSettings.prompts = m.serviceSettings.prompts.map(prompt => changes.has(prompt.identifier) ? { ...prompt, name: changes.get(prompt.identifier) } : prompt);
            store[key] = { ...store[key], folders: [], assignments: {}, collapsed: [], fingerprints: {}, hiddenSections: [], recognition: { ...store[key].recognition, mode: 'mixed' } };
            const before = JSON.stringify([m.serviceSettings.prompts, m.serviceSettings.prompt_order]);
            await m.renderPromptManagerListItems();
            return { ids: entries.map(item => item.identifier), before, unchanged: before === JSON.stringify([m.serviceSettings.prompts, m.serviceSettings.prompt_order]) };
        });
        assert.equal(boundary.unchanged, true);
        const boundaryState = await metadata(page), repeats = boundaryState.folders.filter(item => item.name === '重复');
        assert.equal(repeats.length, 2); assert.notEqual(repeats[0].id, repeats[1].id);
        for (const id of boundary.ids.slice(6, 16)) assert.equal(boundaryState.assignments[id], undefined, 'malformed or missing pairs must not swallow following entries');
        assert.match(await page.locator('.cla-preset-diagnostics summary').textContent(), /[1-9]\d* 个异常/);
        assert.equal(await page.locator(rows).count(), expected.length);
        assert.equal(await nativeSnapshot(page), boundary.before);
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log(`${mobile ? 'Touch / Cappuccino' : 'Desktop / Dark Lite'}: ${expected.length} real rows; unique tree, custom rules, headings, nested folding, 20 scroll toggles, search/filter, native rerender, long hold, native edit/toggle, preset switching/reload and malformed markers passed; native bytes unchanged; ${manifest.version} dist loaded`);
        await context.close();
    }
} finally { await browser.close(); }
