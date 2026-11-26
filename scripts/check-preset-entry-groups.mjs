// Disposable real SillyTavern only. No simplified DOM or external requests.
// Set CLA_PRESET_THEME_CSS to load a local theme with its original selectors.
// CLA_TAVERN_URL=http://127.0.0.1:18781 CLA_PRESET_FIXTURE=/path/to/preset.json node scripts/check-preset-entry-groups.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { CLA_TAVERN_URL, CLA_PRESET_FIXTURE, CLA_BROWSER_EXECUTABLE, CLA_PRESET_THEME_CSS } = process.env;
assert.ok(CLA_TAVERN_URL && CLA_PRESET_FIXTURE, 'Set CLA_TAVERN_URL and CLA_PRESET_FIXTURE');
const base = new URL(CLA_TAVERN_URL);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use a local disposable SillyTavern');
const preset = JSON.parse(await readFile(CLA_PRESET_FIXTURE, 'utf8'));
// Keep every prompt and prompt_order item, without importing unrelated extension data.
delete preset.extensions;
const fixture = Buffer.from(JSON.stringify(preset));
const themeCss = CLA_PRESET_THEME_CSS ? await readFile(CLA_PRESET_THEME_CSS, 'utf8') : null;
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(CLA_BROWSER_EXECUTABLE ? { executablePath: CLA_BROWSER_EXECUTABLE } : {}) });
const list = '#completion_prompt_manager_list', rows = `${list} [data-pm-identifier]`;
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
        const name = `CLA ${manifest.version} ${mobile ? 'touch' : 'desktop'} ${Date.now()}`;
        await page.locator('#openai_preset_import_file').setInputFiles({ name: `${name}.json`, mimeType: 'application/json', buffer: fixture });
        const ready = page.waitForFunction(name => window.SillyTavern.getContext().chatCompletionSettings.preset_settings_openai === name
            && [...document.querySelectorAll('.cla-preset-fold-name')].some(node => node.textContent === '写作规则'), name);
        const proxy = page.locator('dialog[open]').getByRole('button', { name: 'Remove them', exact: true });
        if (await Promise.race([proxy.waitFor({ state: 'visible' }).then(() => true), ready.then(() => false)])) await act(proxy);
        await ready;
        await page.evaluate(async () => { await (await import('/scripts/openai.js')).getPresetApplicationPromise(); });
        await rerender(page);
        await page.locator('dialog[open]').waitFor({ state: 'hidden' });
        const original = await nativeSnapshot(page), ids = await page.locator(rows).evaluateAll(items => items.map(item => item.dataset.pmIdentifier));
        assert.ok(ids.length >= 100); assert.equal(new Set(ids).size, ids.length);
        assert.ok(resources.has(manifest.js.split('/').pop())); assert.ok(resources.has(manifest.css.split('/').pop()));
        assert.equal(await settings.evaluate(node => node.open), false);
        assert.equal(await button('全部展开').isVisible(), false);
        const nativeOrder = await page.evaluate(async () => {
            const m = (await import('/scripts/openai.js')).promptManager;
            return m.getPromptOrderForCharacter(m.activeCharacter).map(item => item.identifier);
        });
        const rowOrder = () => page.locator(rows).evaluateAll(items => items.map(item => item.dataset.pmIdentifier));
        assert.deepEqual(await rowOrder(), nativeOrder);
        assert.deepEqual(await page.locator('.cla-preset-fold-name').allTextContents(),
            ['写作规则', '不要动', '规则', '小剧场', 'NSFW', '文风', '视角模式', '选一', '思维链', '不一定管用的破限']);
        const identities = page.locator(`${list} > [data-pm-identifier]`).filter({ has: page.locator('[data-pm-name]').filter({ hasText: /身份[1-5]/u }) });
        assert.equal(await identities.count(), 5);
        if (themeCss) await page.addStyleTag({ content: themeCss });
        const writing = await header('写作规则').evaluate(node => node.getBoundingClientRect().top);
        assert.ok(await identities.evaluateAll((items, top) => items.every(item => item.getBoundingClientRect().bottom <= top), writing));
        if (!themeCss) await page.addStyleTag({ content: `#completion_prompt_manager {
            --SmartThemeBodyColor: rgb(49, 69, 58);
            --SmartThemeBorderColor: rgb(195, 207, 195);
            background: rgb(246, 245, 237);
            color: var(--SmartThemeBodyColor);
        }` });
        const checkDisabled = async () => {
            const disabled = identities.first().locator('[data-pm-name]');
            const [color, opacity, decoration] = await disabled.evaluate(node => {
                const style = getComputedStyle(node);
                return [style.color, style.opacity, style.textDecorationLine];
            });
            assert.equal(opacity, '1');
            assert.equal(decoration, 'line-through');
            if (!themeCss) assert.equal(color, 'rgb(49, 69, 58)');
        };
        const checkLayout = async () => {
            const geometry = await identities.last().evaluate(node => {
                const list = node.parentElement;
                const head = list.querySelector('.completion_prompt_manager_list_head');
                const left = head.firstElementChild.getBoundingClientRect().left;
                const right = head.querySelector('.prompt_manager_prompt_tokens').getBoundingClientRect().right;
                const name = node.querySelector('[data-pm-name]');
                const text = name.querySelector('a, span[title]:not(.fa-solid)');
                const controls = [...node.querySelectorAll('.cla-preset-entry-more, .prompt-manager-detach-action, .prompt-manager-edit-action, .prompt-manager-toggle-action')];
                const target = controls.at(-1);
                const nameRect = name.getBoundingClientRect();
                const textRect = text.getBoundingClientRect();
                const toggleRect = target.getBoundingClientRect();
                const tokenRect = node.querySelector('.prompt_manager_prompt_tokens').getBoundingClientRect();
                return { nameOffset: nameRect.left - left, textInset: textRect.left - nameRect.left,
                    width: toggleRect.width, height: toggleRect.height, tokenOffset: tokenRect.right - right,
                    overlap: toggleRect.right - tokenRect.left, transition: getComputedStyle(target).transitionDuration,
                    controls: controls.map(control => ({
                        slot: Number(getComputedStyle(control).gridColumnStart),
                        visible: control.getBoundingClientRect().width > 0,
                    })) };
            });
            assert.ok(Math.abs(geometry.nameOffset) < 4 && geometry.textInset <= 32, JSON.stringify(geometry));
            assert.ok(Math.abs(geometry.tokenOffset) < 4 && geometry.overlap <= 0, JSON.stringify(geometry));
            assert.equal(geometry.width, mobile ? 44 : 32);
            assert.equal(geometry.height, mobile ? 44 : 32);
            assert.equal(geometry.transition, '0s');
            assert.deepEqual(geometry.controls, [1, 2, 3, 4].map(slot => ({ slot, visible: true })));
        };
        await checkLayout();
        await checkDisabled();
        await act(settings.locator('summary'));
        const automaticSubgroups = settings.getByRole('checkbox', { name: '自动识别子分类' });
        assert.equal(await automaticSubgroups.isChecked(), false);
        await act(automaticSubgroups);
        await act(settings.getByRole('button', { name: '全部展开', exact: true }));
        assert.equal(await page.locator('.cla-preset-folder.collapsed').count(), 0);
        assert.deepEqual(await rowOrder(), nativeOrder);
        await act(settings.getByRole('button', { name: '全部折叠', exact: true }));
        assert.equal(await page.locator('.cla-preset-folder.collapsed').count(), 10);
        const foldedRows = page.locator(`${rows}.cla-preset-fold-hidden`);
        assert.ok(await foldedRows.count() > 100);
        assert.equal(await foldedRows.filter({ visible: true }).count(), 0, 'theme must honor folded rows');
        assert.equal(await identities.filter({ visible: true }).count(), 5);
        await act(settings.locator('summary'));

        await act(toggle('规则'));
        assert.equal(await toggle('文风').getAttribute('aria-expanded'), 'false');
        await act(toggle('文风'));
        await header('文风').scrollIntoViewIfNeeded();
        const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        for (let i = 0; i < 6; i++) {
            const before = await header('文风').evaluate(node => node.getBoundingClientRect().top);
            await act(toggle('文风'));
            await frame();
            const after = await header('文风').evaluate(node => node.getBoundingClientRect().top);
            assert.ok(Math.abs(before - after) < 3, `fold drift: ${before} -> ${after}`);
        }
        await act(toggle('规则'));
        assert.equal(await header('文风').isVisible(), false);
        await act(toggle('规则'));
        assert.equal(await toggle('文风').getAttribute('aria-expanded'), 'true');
        await rerender(page);
        assert.deepEqual(await rowOrder(), nativeOrder);
        assert.equal(await toggle('文风').getAttribute('aria-expanded'), 'true');
        await act(button('原始顺序'));
        assert.equal(await page.locator('.cla-preset-folder').count(), 0);
        assert.deepEqual(await page.locator(`${list} > [data-pm-identifier]`).evaluateAll(items => items.map(item => item.dataset.pmIdentifier)), nativeOrder);
        await checkDisabled();
        await checkLayout();
        await act(button('分类浏览'));
        assert.deepEqual(await rowOrder(), nativeOrder);
        assert.deepEqual(await nativeSnapshot(page), original);
        assert.equal(await page.locator(`${list} > [data-pm-identifier]`).count(), nativeOrder.length);
        await page.waitForFunction(() => {
            const row = document.querySelector('#completion_prompt_manager_list > [data-pm-identifier]');
            if (window.claSettledRow !== row) {
                window.claSettledRow = row;
                window.claSettledAt = performance.now();
            }
            return row && performance.now() - window.claSettledAt > 500;
        });
        const row = identities.last();
        await row.scrollIntoViewIfNeeded();
        const nativeToggle = row.locator('.prompt-manager-toggle-action');
        const promptId = await row.getAttribute('data-pm-identifier');
        await page.evaluate(async () => {
            const m = (await import('/scripts/openai.js')).promptManager;
            window.claRow = document.querySelector('[data-pm-identifier]');
            window.claToggleSaves = 0;
            window.claToggleRenders = 0;
            const save = m.saveServiceSettings;
            m.saveServiceSettings = function (...args) {
                window.claToggleSaves++;
                return Promise.all([save.apply(this, args), new Promise(resolve => setTimeout(resolve, 300))]);
            };
            const render = m.renderPromptManagerListItems;
            m.renderPromptManagerListItems = function (...args) {
                window.claToggleRenders++;
                return render.apply(this, args);
            };
        });
        const enabled = () => page.evaluate(async id => {
            const m = (await import('/scripts/openai.js')).promptManager;
            return m.getPromptOrderEntry(m.activeCharacter, id).enabled;
        }, promptId);
        const initial = await enabled();
        for (let i = 0; i < 6; i++) {
            // Use the edge outside the old 18px icon, with real pointer/touch input.
            if (mobile) await nativeToggle.tap({ position: { x: 3, y: 20 } });
            else await nativeToggle.click({ position: { x: 3, y: 15 } });
            assert.equal(await enabled(), i % 2 ? initial : !initial, 'each tap changes state immediately while saving is pending');
        }
        assert.deepEqual(await page.evaluate(() => [window.claToggleSaves, window.claToggleRenders, window.claRow.isConnected]), [6, 0, true]);
        assert.deepEqual(await nativeSnapshot(page), original);
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `/tmp/cla-preset-${manifest.version}-${themeCss ? 'theme' : 'stock'}-${mobile ? 'touch' : 'desktop'}.png` });
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log(`${mobile ? 'Touch' : 'Desktop'}: ${ids.length} original rows, 10 paired sections, readable light-theme disabled text, flat native rows, left-aligned names, six immediate edge taps with pending saves, stable folds with hidden rows, and unchanged native data. Loaded ${manifest.version}.`);
        await context.close();
    }
} finally { await browser.close(); }
