// Isolated real-pointer regressions. Native persistence/popups use controllable
// fixtures so pending writes, failures and duplicate clicks can be tested safely.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const adapter = await readFile(new URL('../modules/regex-ui-adapter.js', import.meta.url),'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url),'utf8');
const assets = new Map([
    ['/adapter.js',adapter],
    ['/regex/engine.js',`
        export const SCRIPT_TYPES={GLOBAL:0,SCOPED:1,PRESET:2};
        export const getScriptsByType=type=>window.data[type]||[];
        export const getCurrentPresetAPI=()=>'openai';export const getCurrentPresetName=()=>'preset-A';
        export const saveScriptsByType=async(next,type)=>{
            window.writes.push({next,type});window.data[type]=next;
            if(window.holdWrites)await new Promise(resolve=>window.releaseWrite=resolve);
            if(window.failType===type)throw new Error('fixture write failed');
        };
        export const allowScopedScripts=()=>window.permissions++;
        export const allowPresetScripts=()=>window.permissions++;
        export const RegexProvider={instance:{clear(){}}};
    `],
    ['/script.js',`export const characters=[{avatar:'a.png'}];export const this_chid=0;export const saveSettingsDebounced=()=>window.settingsSaves++;`],
    ['/popup.js',`export const Popup={util:{popups:[]},show:{confirm:async()=>{window.confirms++;return window.confirmNext;}}};`],
]);
const server=createServer((req,res)=>{
    res.setHeader('Content-Type',assets.has(req.url)?'text/javascript':'text/html');
    res.end(assets.get(req.url)||'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body></body>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
    browser=await chromium.launch({headless:true,...(process.env.CLA_BROWSER_EXECUTABLE?{executablePath:process.env.CLA_BROWSER_EXECUTABLE}:{})});
    for(const touch of [false,true]) {
        const page=await browser.newPage({viewport:{width:touch?390:1000,height:900},hasTouch:touch,isMobile:touch});
        const errors=[];page.on('pageerror',error=>errors.push(error.message));
        await page.goto('http://127.0.0.1:'+server.address().port);
        await page.addStyleTag({content:`
            :root{--SmartThemeBodyColor:#222;--SmartThemeBlurTintColor:#eee}
            body{margin:8px;font:16px sans-serif}#viewport{height:700px;overflow:auto}
            .regex-script-label{display:flex;align-items:center;gap:5px;height:36px;box-sizing:border-box}
            .regex_script_name{flex:1}.drag-handle{flex:none}button{cursor:pointer}
            dialog{width:80%;max-width:450px}.regex_editor{display:grid;gap:5px}
            ${styles}`});
        await page.evaluate(async()=>{
            const {RegexUiAdapter}=await import('/adapter.js');const {Popup}=await import('/popup.js');
            Object.assign(window,{data:{},writes:[],permissions:0,settingsSaves:0,confirms:0,confirmNext:true,holdWrites:false,failType:null,nativeDeletes:0,nativeSaves:0,changes:0,refreshes:0,toasts:[]});
            window.toastr={error:text=>toasts.push(text),info:text=>toasts.push(text)};
            document.body.innerHTML='<div id="viewport"><div id="regex_container"><div class="regex_settings"><div class="inline-drawer-content"><div class="flex-container"><input id="regex_bulk_edit" type="checkbox"><button id="bulk_delete_regex">批量删除</button></div><div id="saved_regex_scripts"></div><div id="saved_preset_scripts"></div><div id="saved_scoped_scripts"></div></div></div></div></div>';
            for(const [scope,type,list]of[['GLOBAL',0,'saved_regex_scripts'],['PRESET',2,'saved_preset_scripts'],['SCOPED',1,'saved_scoped_scripts']]) {
                data[type]=Array.from({length:20},(_,i)=>({id:scope+'-'+i,scriptName:'[A] '+scope+' '+i,findRegex:'a',replaceString:'b',trimStrings:[],placement:[2],disabled:false,markdownOnly:true,promptOnly:false,runOnEdit:true,substituteRegex:0,minDepth:null,maxDepth:null}));
                for(const script of data[type]) {
                    const row=document.createElement('div');row.className='regex-script-label';row.id=script.id;
                    row.innerHTML='<input type="checkbox" class="regex_bulk_checkbox"><span class="drag-handle">☰</span><span class="regex_script_name"></span><input class="disable_regex" type="checkbox"><button class="edit_existing_regex">编辑</button><button class="delete_regex">删</button>';
                    row.querySelector('.regex_script_name').textContent=script.scriptName;
                    row.querySelector('.regex_bulk_checkbox').addEventListener('change',()=>changes++);
                    row.querySelector('.delete_regex').addEventListener('click',()=>nativeDeletes++);
                    row.querySelector('.edit_existing_regex').addEventListener('click',()=>openEditor(type,script.id));
                    document.getElementById(list).append(row);
                }
            }
            document.querySelector('#bulk_delete_regex').addEventListener('click',()=>nativeDeletes++);
            window.openEditor=(type,id)=>{
                const script=data[type].find(item=>item.id===id),dlg=document.createElement('dialog');dlg.className='popup';
                dlg.innerHTML='<div class="regex_editor"><input class="regex_script_name"><input class="find_regex"><textarea class="regex_replace_string"></textarea><textarea class="regex_trim_strings"></textarea><input name="replace_position" type="checkbox" value="2" checked><input name="disabled" type="checkbox"><input name="only_format_display" type="checkbox" checked><input name="only_format_prompt" type="checkbox"><input name="run_on_edit" type="checkbox" checked><select name="substitute_regex"><option value="0">0</option></select><input name="min_depth"><input name="max_depth"></div><button class="popup-button-ok">保存</button>';
                for(const [selector,value]of[['.regex_script_name',script.scriptName],['.find_regex',script.findRegex],['.regex_replace_string',script.replaceString]])dlg.querySelector(selector).value=value;
                dlg.querySelector('.popup-button-ok').addEventListener('click',()=>nativeSaves++);
                const popup={dlg,async completeCancelled(){dlg.close();await Promise.resolve();dlg.remove();Popup.util.popups=Popup.util.popups.filter(item=>item!==popup);},
                    async show(){if(!Popup.util.popups.includes(popup))Popup.util.popups.push(popup);document.body.append(dlg);dlg.showModal();}};
                Popup.util.popups.push(popup);document.body.append(dlg);dlg.showModal();
            };
            window.adapter=new RegexUiAdapter({extensionSettings:{},onSaved:()=>refreshes++});await adapter.start();
            adapter.createCollection('GLOBAL','B');adapter.openCollections.add('["GLOBAL","A"]');adapter.applyOrganizerFilters();
            window.originalIds=()=>[...document.querySelector('#saved_regex_scripts').children].map(row=>row.id).filter(Boolean);
        });
        await page.waitForFunction(()=>document.querySelector('.cla-regex-organizer-toggle'));
        await page.locator('.cla-regex-organizer-toggle').click();
        await page.evaluate(()=>{changes=0;adapter.selectVisibleRows(true);});
        assert.equal(await page.evaluate(()=>changes),1,'bulk selection notifies native toolbar only once');
        await page.evaluate(()=>{changes=0;adapter.clearRowSelection();});
        assert.equal(await page.evaluate(()=>changes),1,'clear selection shares the same batched path');
        await page.locator('[data-cla-regex-drag]').check();
        const session=touch?await page.context().newCDPSession(page):null;
        async function pointer(type,x,y) {
            if(touch)await session.send('Input.dispatchTouchEvent',{type:{down:'touchStart',move:'touchMove',up:'touchEnd',cancel:'touchCancel'}[type],touchPoints:type==='up'||type==='cancel'?[]:[{x,y,id:1}]});
            else if(type==='move')await page.mouse.move(x,y);
            else if(type==='down'){await page.mouse.move(x,y);await page.mouse.down();}
            else if(type==='up')await page.mouse.up();
            else {await page.evaluate(()=>document.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true})));await page.mouse.up();}
        }
        const center=async locator=>{const box=await locator.boundingBox();return{x:box.x+box.width/2,y:box.y+box.height/2};};
        await page.locator('#GLOBAL-0 .regex_script_name').evaluate(element=>element.scrollIntoView({block:'start'}));
        const from=await center(page.locator('#GLOBAL-0 .regex_script_name'));
        const to=await center(page.locator('#GLOBAL-7 .regex_script_name'));
        await page.evaluate(()=>changes=0);
        await pointer('down',from.x,from.y);await pointer('move',to.x,to.y);await pointer('up',to.x,to.y);
        assert.equal(await page.evaluate(()=>Array.from({length:8},(_,i)=>document.querySelector('#GLOBAL-'+i+' .regex_bulk_checkbox').checked).every(Boolean)),true,'fast pointer jump fills all crossed rows');
        assert.ok(await page.evaluate(()=>changes)<=3,'native selection toolbar is notified per frame instead of per crossed row');
        const definitions=await page.evaluate(()=>JSON.stringify(data)),ids=await page.evaluate(()=>originalIds());
        async function dragToB(id,{cancel=false}={}) {
            await page.locator('#'+id+' .cla-regex-group-handle').scrollIntoViewIfNeeded();
            const start=await center(page.locator('#'+id+' .cla-regex-group-handle'));
            await pointer('down',start.x,start.y);await pointer('move',start.x+12,start.y);
            await page.locator('.cla-regex-drop-tray').waitFor();
            const target=await center(page.locator('.cla-regex-drop-tray [data-cla-regex-drop-collection="B"]'));
            await pointer('move',target.x,target.y);await pointer(cancel?'cancel':'up',target.x,target.y);
            await page.waitForFunction(()=>!document.querySelector('.cla-regex-drop-tray'));
        }
        await dragToB('GLOBAL-0');
        assert.equal(await page.evaluate(()=>Array.from({length:8},(_,i)=>document.getElementById('GLOBAL-'+i).dataset.claRegexCollection).every(name=>name==='B')),true,'dragging selected row assigns all selected rules');
        assert.equal(await page.evaluate(()=>JSON.stringify(data)),definitions);
        assert.deepEqual(await page.evaluate(()=>originalIds()),ids);
        await page.locator('.cla-regex-reorder-toggle').click();
        await dragToB('GLOBAL-8');
        assert.equal(await page.locator('#GLOBAL-8').getAttribute('data-cla-regex-collection'),'B','group drag remains available in native order mode');
        await dragToB('GLOBAL-9',{cancel:true});
        assert.equal(await page.locator('#GLOBAL-9').getAttribute('data-cla-regex-collection'),'A','cancelled drag never saves');
        assert.equal(await page.evaluate(()=>writes.length),0,'classification does not persist native script order/content');
        await page.evaluate(()=>{adapter.clearRowSelection();for(let i=0;i<10;i++)adapter.setRowSelected(document.getElementById('PRESET-'+i),true);holdWrites=true;});
        await page.locator('#bulk_delete_regex').scrollIntoViewIfNeeded();await page.locator('#bulk_delete_regex').click();
        await page.waitForFunction(()=>typeof releaseWrite==='function');
        assert.equal(await page.locator('#PRESET-0').count(),0,'confirmed deletion leaves the list immediately');
        assert.equal(await page.locator('#bulk_delete_regex').isDisabled(),false);
        assert.equal(await page.locator('.cla-regex-operation-status').count(),0);
        assert.equal(await page.evaluate(()=>writes.length),1);
        await page.evaluate(async()=>{holdWrites=false;releaseWrite();await adapter.saveQueue;});
        assert.equal(await page.evaluate(()=>data[2].length),10);
        assert.equal(await page.locator('#PRESET-0').count(),0);
        assert.equal(await page.evaluate(()=>nativeDeletes),0);
        assert.equal(await page.evaluate(()=>permissions),0,'delete never enables scoped regexes');
        await page.locator('#PRESET-10 .edit_existing_regex').scrollIntoViewIfNeeded();await page.locator('#PRESET-10 .edit_existing_regex').click();
        await page.locator('.regex_replace_string').fill('saved draft');
        await page.evaluate(()=>{holdWrites=true;releaseWrite=null;const button=document.querySelector('.popup-button-ok');button.click();button.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
        await page.waitForFunction(()=>typeof releaseWrite==='function');
        assert.equal(await page.evaluate(()=>writes.length),2,'double-click queues only one editor write');
        assert.equal(await page.locator('dialog.popup').count(),0,'save closes immediately while the network is pending');
        assert.equal(await page.locator('.cla-regex-operation-status').count(),0);
        await page.evaluate(async()=>{holdWrites=false;releaseWrite();await adapter.saveQueue;});
        await page.locator('#PRESET-10 .edit_existing_regex').click();
        await page.locator('.regex_replace_string').fill('newer draft');
        await page.locator('.popup-button-ok').click();await page.evaluate(()=>adapter.saveQueue);
        assert.equal(await page.locator('dialog.popup').count(),0);
        assert.equal(await page.evaluate(()=>data[2][0].replaceString),'newer draft');
        assert.equal(await page.evaluate(()=>nativeSaves),0);
        await page.locator('.cla-regex-reorder-toggle').click();
        await page.evaluate(()=>{adapter.clearRowSelection();adapter.openCollections.add('["GLOBAL","A"]');adapter.applyOrganizerFilters();});
        const originalGlobalDefinitions=await page.evaluate(()=>Object.fromEntries(data[0].map(script=>[script.id,JSON.stringify(script)])));
        async function sortRule(sourceId,targetId,{cancel=false,wait=true}={}) {
            await page.locator('#'+sourceId+' .cla-regex-group-handle').evaluate(node=>node.scrollIntoView({block:'center'}));
            const start=await center(page.locator('#'+sourceId+' .cla-regex-group-handle'));
            await pointer('down',start.x,start.y);await pointer('move',start.x+10,start.y);
            await page.locator('.cla-regex-drop-tray').waitFor();
            const box=await page.locator('#'+targetId).boundingBox();
            const target={x:box.x+box.width/2,y:box.y+box.height/4};
            await pointer('move',target.x,target.y);
            await pointer(cancel?'cancel':'up',target.x,target.y);
            if(wait)await page.evaluate(()=>adapter.saveQueue);
        }
        const beforeSortWrites=await page.evaluate(()=>writes.length);
        await sortRule('GLOBAL-10','GLOBAL-9');
        await page.waitForFunction(count=>writes.length===count,beforeSortWrites+1);
        assert.deepEqual(await page.evaluate(()=>data[0].slice(9,12).map(script=>script.id)),['GLOBAL-10','GLOBAL-9','GLOBAL-11']);
        assert.deepEqual(await page.evaluate(()=>originalIds()),await page.evaluate(()=>data[0].map(script=>script.id)),'native DOM order follows the saved execution order');
        assert.equal(await page.evaluate(()=>adapter.reorderMode),false,'sorting never leaves collection view');
        await page.evaluate(()=>{holdWrites=true;releaseWrite=null;adapter.setRowSelected(document.getElementById('GLOBAL-11'),true);adapter.setRowSelected(document.getElementById('GLOBAL-12'),true);});
        await sortRule('GLOBAL-11','GLOBAL-9',{wait:false});
        await page.waitForFunction(()=>typeof releaseWrite==='function');
        assert.deepEqual(await page.evaluate(()=>originalIds().slice(9,14)),['GLOBAL-10','GLOBAL-11','GLOBAL-12','GLOBAL-9','GLOBAL-13'],'a pending write does not delay moving the visible rows');
        await page.evaluate(()=>adapter.clearRowSelection());
        await sortRule('GLOBAL-13','GLOBAL-9',{wait:false});
        assert.deepEqual(await page.evaluate(()=>originalIds().slice(9,14)),['GLOBAL-10','GLOBAL-11','GLOBAL-12','GLOBAL-13','GLOBAL-9'],'another drop remains available during a slow save');
        assert.equal(await page.locator('.cla-regex-operation-status').count(),0);
        assert.equal(await page.evaluate(()=>writes.length),beforeSortWrites+2,'network writes stay serialized');
        await page.evaluate(async()=>{holdWrites=false;releaseWrite();await adapter.saveQueue;});
        assert.deepEqual(await page.evaluate(()=>data[0].slice(9,14).map(script=>script.id)),['GLOBAL-10','GLOBAL-11','GLOBAL-12','GLOBAL-13','GLOBAL-9']);
        assert.equal(await page.evaluate(()=>writes.length),beforeSortWrites+3);
        assert.deepEqual(await page.evaluate(()=>Object.fromEntries(data[0].map(script=>[script.id,JSON.stringify(script)]))),originalGlobalDefinitions,'sorting preserves rule definitions and switches');
        await page.evaluate(()=>adapter.clearRowSelection());
        const savedOrder=await page.evaluate(()=>data[0].map(script=>script.id));
        await sortRule('GLOBAL-14','GLOBAL-9',{cancel:true});
        assert.deepEqual(await page.evaluate(()=>data[0].map(script=>script.id)),savedOrder);
        assert.equal(await page.evaluate(()=>writes.length),beforeSortWrites+3);
        const headerA=page.locator('#saved_regex_scripts [data-cla-regex-fold="A"]');
        const headerB=page.locator('#saved_regex_scripts [data-cla-regex-fold="B"]');
        await headerA.evaluate(node=>node.scrollIntoView({block:'center'}));
        const groupStart=await center(headerA.locator('.cla-regex-collection-order-handle'));
        await pointer('down',groupStart.x,groupStart.y);await pointer('move',groupStart.x+10,groupStart.y);
        await headerB.evaluate(node=>node.scrollIntoView({block:'center'}));
        const groupBox=await headerB.boundingBox();
        await pointer('move',groupBox.x+groupBox.width/2,groupBox.y+groupBox.height/4);
        await pointer('up',groupBox.x+groupBox.width/2,groupBox.y+groupBox.height/4);
        assert.deepEqual(await page.evaluate(()=>adapter.collectionGroups.filter(group=>group.scope==='GLOBAL').map(group=>group.collection)),['A','B']);
        assert.equal(await page.evaluate(()=>writes.length),beforeSortWrites+3,'moving titles saves only display settings');
        assert.deepEqual(await page.evaluate(()=>data[0].map(script=>script.id)),savedOrder);
        await page.evaluate(async()=>{
            const {RegexUiAdapter}=await import('/adapter.js');
            const settings=JSON.parse(JSON.stringify(adapter.extensionSettings));adapter.stop();
            window.adapter=new RegexUiAdapter({extensionSettings:settings,onSaved:()=>refreshes++});await adapter.start();
        });
        await page.waitForFunction(()=>document.querySelector('.cla-regex-collection-order-handle'));
        assert.deepEqual(await page.evaluate(()=>adapter.collectionGroups.filter(group=>group.scope==='GLOBAL').map(group=>group.collection)),['A','B']);
        assert.deepEqual(await page.evaluate(()=>originalIds()),savedOrder);
        await page.evaluate(()=>{adapter.openCollections.add('["PRESET","A"]');adapter.applyOrganizerFilters();adapter.clearRowSelection();adapter.setRowSelected(document.getElementById('PRESET-12'),true);holdWrites=true;releaseWrite=null;failType=2;});
        await page.locator('#bulk_delete_regex').scrollIntoViewIfNeeded();await page.locator('#bulk_delete_regex').click();
        await page.waitForFunction(()=>typeof releaseWrite==='function');
        assert.equal(await page.locator('#PRESET-12').count(),0);
        await page.evaluate(async()=>{holdWrites=false;releaseWrite();await adapter.saveQueue;});
        assert.equal(await page.locator('#PRESET-12').count(),1,'failed background deletion restores the original row');
        await page.locator('#PRESET-12 .edit_existing_regex').click();
        await page.locator('.regex_replace_string').fill('recover this draft');
        await page.evaluate(()=>{holdWrites=true;releaseWrite=null;});
        await page.locator('.popup-button-ok').click();
        await page.waitForFunction(()=>typeof releaseWrite==='function');
        assert.equal(await page.locator('dialog.popup').count(),0);
        await page.evaluate(async()=>{holdWrites=false;releaseWrite();await adapter.saveQueue;});
        assert.equal(await page.locator('dialog.popup').count(),1,'failed background editor save restores its editable draft');
        assert.equal(await page.locator('.regex_replace_string').inputValue(),'recover this draft');
        await page.evaluate(()=>failType=null);
        await page.locator('.popup-button-ok').click();await page.evaluate(()=>adapter.saveQueue);
        assert.equal(await page.locator('dialog.popup').count(),0);
        assert.equal(await page.evaluate(()=>data[2].find(script=>script.id==='PRESET-12').replaceString),'recover this draft');
        assert.equal(await page.locator('.cla-regex-operation-status').count(),0);
        await page.evaluate(()=>adapter.stop());
        assert.equal(await page.locator('.cla-regex-group-handle,.cla-regex-drop-tray,.cla-regex-operation-status').count(),0);
        assert.deepEqual(errors,[]);
        console.log(`PASS ${touch?'touch':'mouse'}: instant repeated sorting during slow writes, immediate editor close and confirmed deletion, no status labels, failed row/draft recovery, grouping and cleanup`);
        await page.close();
    }
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
