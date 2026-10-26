// Isolated Chromium UI regression. Native history APIs and deletion responses are fixtures.
// Requires Playwright; optionally set CLA_BROWSER_EXECUTABLE and CLA_TEST_THEME.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const assets = new Map(await Promise.all(['modules/chat-history-batch.js', 'style.css'].map(async path =>
    ['/' + path, await readFile(new URL('../' + path, import.meta.url), 'utf8')])));
assets.set('/theme.css', process.env.CLA_TEST_THEME ? await readFile(process.env.CLA_TEST_THEME, 'utf8') : '');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/theme.css">
<style>
:root{--SmartThemeBodyColor:#22303e;--SmartThemeQuoteColor:#527ac9;--im-ui-ink:#22303e;--im-history-surface:#f7f8ff;--im-glass-edge:#dce1ed;--im-glass-shadow:0 5px 20px #3452}
*{box-sizing:border-box}body{font:16px sans-serif;margin:0;background:#dfe6f5;color:var(--SmartThemeBodyColor)}
#select_chat_popup{position:fixed;inset:20px;display:flex;flex-direction:column;padding:16px;border-radius:20px;background:#f7f8ff;min-width:0}
[name="selectChatPopupHeader"]{display:flex;align-items:center;gap:8px;flex-wrap:wrap}#selectChatPopupHeaderText{font-weight:700;font-size:24px}
#select_chat_search{flex:1;min-width:80px}#select_chat_cross{cursor:pointer}.menu_button{border:1px solid #bcc7dd;border-radius:8px;background:#e9edf7;color:inherit;padding:5px 8px;cursor:pointer}
#select_chat_div{overflow:auto;min-height:0}.select_chat_block{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:8px;overflow-wrap:anywhere}
.select_chat_block[highlight=true]{background:#c7cef6}.select_chat_actions{display:flex;gap:12px}.select_chat_block_mes{font-size:13px}.select_chat_block_filename{font-size:15px}
dialog{max-width:calc(100vw - 32px);border:1px solid #bac3d4;border-radius:14px;padding:20px}dialog::backdrop{background:#0003}
@media(max-width:600px){#select_chat_popup{inset:8px;padding:10px}}
</style>
<div id="select_chat_popup"><div name="selectChatPopupHeader"><div id="selectChatPopupHeaderText">聊天记录</div><button id="newChatFromManageScreenButton" class="menu_button">新聊天</button><button class="menu_button">导入聊天</button><input id="select_chat_search" placeholder="搜索…"><button id="select_chat_cross">×</button></div><div id="select_chat_div"></div></div>
<script type="module">
import {ChatHistoryBatchActions} from '/modules/chat-history-batch.js';
window.calls=[];window.notices=[];window.nativeOpens=0;window.nativeDeletes=0;window.confirms=0;window.failAt=0;
window.renderRows=(names=['active','one','two','three'])=>{
 const list=document.querySelector('#select_chat_div');list.replaceChildren();
 for(const name of names){const wrap=document.createElement('div');wrap.className='select_chat_block_wrapper flex-container';
 const row=document.createElement('div');row.className='select_chat_block wide100p flex-container';row.setAttribute('file_name',name);row.tabIndex=0;
 if(name==='active')row.setAttribute('highlight','true');
 const title=document.createElement('small');title.className='select_chat_block_filename';title.textContent='测试聊天记录 '+name;
 const actions=document.createElement('div');actions.className='select_chat_actions';actions.innerHTML='<span class="renameChatButton">改名</span><span class="exportRawChatButton">导出</span><span class="PastChat_cross">删除</span>';
 const preview=document.createElement('div');preview.className='select_chat_block_mes';preview.textContent='聊天内容预览，用于批量选择的隔离检查。';row.append(title,actions,preview);wrap.append(row);list.append(wrap);}
};renderRows();
document.addEventListener('click',event=>{if(event.target.closest('.PastChat_cross'))nativeDeletes++;else if(event.target.closest('.select_chat_block'))nativeOpens++;});
document.querySelector('#select_chat_cross').onclick=()=>document.querySelector('#select_chat_popup').style.display='none';
const handlers=new Map();window.deletedEvents=[];
window.api={characters:[{avatar:'fixture.png',chat:'active'}],this_chid:0,getCurrentChatId:()=>api.characters[api.this_chid]?.chat,getRequestHeaders:()=>({'X-CSRF-Token':'fixture'}),isGenerating:()=>false,
event_types:{CHAT_CHANGED:'changed',CHAT_DELETED:'deleted',GROUP_CHAT_DELETED:'group-deleted'},eventSource:{on:(n,f)=>handlers.set(n,f),removeListener:n=>handlers.delete(n),emit:async(n,id)=>{deletedEvents.push([n,id]);handlers.get(n)?.();}}};
window.toastr=Object.fromEntries(['success','warning','error'].map(level=>[level,message=>notices.push({level,message})]));
const popupApi={POPUP_RESULT:{AFFIRMATIVE:1},Popup:{show:{confirm:async(title,text)=>{confirms++;return new Promise(resolve=>{
 const dialog=document.createElement('dialog');dialog.innerHTML='<h3>'+title+'</h3>'+text+'<button id="confirm-delete">删除所选</button><button id="cancel-delete">取消</button>';
 document.body.append(dialog);dialog.showModal();const close=value=>{dialog.close();dialog.remove();resolve(value);};
 dialog.querySelector('#confirm-delete').onclick=()=>close(1);dialog.querySelector('#cancel-delete').onclick=()=>close(0);dialog.oncancel=e=>{e.preventDefault();close(null);};
});}}}};
window.adapter=new ChatHistoryBatchActions({scriptApi:api,loadApis:async()=>[{selected_group:null,groups:[]},popupApi],fetchImpl:async(url,options)=>{
 calls.push({url,body:JSON.parse(options.body)});await window.requestGate;return {ok:calls.length!==failAt,status:503};
}});await adapter.start();window.ready=true;
</script>`;
const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(assets.get(req.url) ?? html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await chromium.launch({ headless: true, ...(process.env.CLA_BROWSER_EXECUTABLE ? { executablePath: process.env.CLA_BROWSER_EXECUTABLE } : {}) });
    for (const mobile of [false, true]) {
        const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1100, height: 900 }, isMobile: mobile, hasTouch: mobile });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        await page.waitForFunction(() => window.ready);
        const press = async locator => mobile ? await locator.tap() : await locator.click();
        const action = name => page.locator('[data-cla-chat-action="' + name + '"]');
        const row = name => page.locator('.select_chat_block[file_name="' + name + '"]');
        await press(row('one').locator('.select_chat_block_filename'));
        assert.equal(await page.evaluate(() => nativeOpens), 1, 'ordinary native open still works');
        await press(action('toggle'));
        assert.equal(await row('active').locator('input').isDisabled(), true);
        await press(row('one').locator('input'));
        assert.deepEqual(await page.evaluate(() => [...adapter.selected]), ['one'], 'checkbox default activation survives capture handling');
        await press(row('two').locator('.select_chat_block_filename'));
        assert.equal(await page.evaluate(() => adapter.selected.size), 2);
        assert.equal(await page.evaluate(() => nativeOpens), 1, 'batch row selection cannot open the native chat');
        await press(action('clear'));
        await press(action('all'));
        assert.deepEqual(await page.evaluate(() => [...adapter.selected]), ['one', 'two', 'three']);
        await press(action('delete'));
        await press(page.locator('#cancel-delete'));
        await page.waitForFunction(() => !adapter.busy);
        assert.equal(await page.evaluate(() => calls.length), 0);
        assert.equal(await page.evaluate(() => adapter.selected.size), 3);
        await page.locator('#select_chat_search').fill('two');
        assert.equal(await page.evaluate(() => adapter.selected.size), 0);
        await page.evaluate(() => renderRows(['active', 'two']));
        await page.waitForFunction(() => document.querySelectorAll('[data-cla-chat-select]').length === 2);
        await press(action('all'));
        assert.deepEqual(await page.evaluate(() => [...adapter.selected]), ['two'], 'select all follows rendered search results');
        await press(action('delete'));
        await press(page.locator('#confirm-delete'));
        await page.waitForFunction(() => !adapter.busy);
        assert.deepEqual(await page.evaluate(() => calls.map(c => c.body)), [{ chatfile: 'two.jsonl', avatar_url: 'fixture.png' }]);
        assert.equal(await row('two').count(), 0);
        assert.equal(await row('active').count(), 1);
        await page.evaluate(() => { renderRows(); failAt=calls.length+2; });
        await page.waitForFunction(() => document.querySelectorAll('[data-cla-chat-select]').length === 4);
        await press(action('all'));
        await press(action('delete'));
        await press(page.locator('#confirm-delete'));
        await page.waitForFunction(() => !adapter.busy);
        assert.deepEqual(await page.evaluate(() => [...adapter.selected]), ['two', 'three']);
        assert.equal(await row('one').count(), 0);
        assert.equal(await row('two').count(), 1);
        assert.equal(await page.evaluate(() => nativeDeletes), 0);
        // Check real geometry including optional user theme, then save a reviewable screenshot.
        const bounds = await page.locator('.cla-chat-batch-toolbar button:visible').evaluateAll(nodes => nodes.map(node => {
            const box=node.getBoundingClientRect();return {left:box.left,right:box.right};
        }));
        const width = mobile ? 390 : 1100;
        assert.ok(bounds.every(box => box.left >= 0 && box.right <= width), 'controls fit the viewport');
        await page.screenshot({ path: '/private/tmp/cla-chat-batch-' + width + '.png' });
        await press(action('toggle'));
        await press(row('two').locator('.PastChat_cross'));
        assert.equal(await page.evaluate(() => nativeDeletes), 1, 'native single delete is restored after leaving batch mode');
        await press(action('toggle'));
        await press(action('all'));
        await press(action('delete'));
        await page.evaluate(() => { api.characters.push({avatar:'other.png',chat:'other'});api.this_chid=1; });
        const before = await page.evaluate(() => calls.length);
        await press(page.locator('#confirm-delete'));
        await page.waitForFunction(() => !adapter.busy);
        assert.equal(await page.evaluate(() => calls.length), before, 'a changed character invalidates the confirmed queue');
        await page.evaluate(() => adapter.stop());
        assert.equal(await page.locator('.cla-chat-batch-toolbar').count(), 0);
        assert.equal(await page.locator('[data-cla-chat-select]').count(), 0);
        assert.deepEqual(errors, []);
        console.log((mobile ? 'Touch' : 'Desktop') + ': selection, native actions, search, cancel, confirmed deletion, partial failure, context switch, layout and cleanup passed');
        await page.close();
    }
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
