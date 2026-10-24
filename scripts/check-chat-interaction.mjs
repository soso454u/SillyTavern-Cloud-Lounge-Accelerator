// Isolated DOM regression with real browser selection/pointer/dialog behavior.
// Native APIs and highlight.js are fixtures; this is not a Safari crash test.
// Requires Playwright and optionally CLA_BROWSER_EXECUTABLE.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
const {chromium} = createRequire(import.meta.url)('playwright');
const prefix='/scripts/extensions/third-party/cla/';
const assets=new Map(await Promise.all([
    'modules/chat-optimizer.js','modules/interaction-diagnostics.js','modules/interaction-recovery-guard.js','client-core.js','utils/scheduler.js',
].map(async file=>[prefix+file,await readFile(new URL('../'+file,import.meta.url),'utf8')])));
assets.set('/scripts/power-user.js','export const power_user={chat_truncation:100};');
assets.set('/lib.js',`export const hljs={highlightElement(code){window.highlights++;code.innerHTML='<span class="hljs-keyword">'+code.textContent+'</span>';code.dataset.highlighted='yes';}};`);
assets.set('/script.js',`
    export const callbacks=new Map();
    export const eventSource={on(n,fn){callbacks.set(n,[...(callbacks.get(n)||[]),fn]);},removeListener(n,fn){callbacks.set(n,(callbacks.get(n)||[]).filter(x=>x!==fn));}};
    export const event_types={GENERATION_STARTED:'start',GENERATION_ENDED:'end'};
    export function emit(n){for(const fn of callbacks.get(n)||[])fn();}
    export function addCopyToCodeBlocks(root){window.copyScopes.push(root.localName);for(const code of root.querySelectorAll('pre code'))window.addButton(code);}
`);
const html=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:8px;font:16px sans-serif}#chat{height:500px;overflow:auto}.code-copy{display:inline-block;padding:8px}.code-copy::after{content:'Copy'}pre{margin:3px}dialog{min-width:150px}</style>
<div id="chat"></div><textarea id="send_textarea"></textarea><button id="other">Other</button>
<script type="module">
import {ChatOptimizer} from '${prefix}modules/chat-optimizer.js';
import {InteractionDiagnostics} from '${prefix}modules/interaction-diagnostics.js';
import {InteractionRecoveryGuard} from '${prefix}modules/interaction-recovery-guard.js';
import {FrameScheduler} from '${prefix}utils/scheduler.js';
import {eventSource,event_types,emit} from '/script.js';
window.highlights=0;window.copies=0;window.copyScopes=[];window.generating=false;window.emit=emit;
window.addButton=code=>{const button=document.createElement('i');button.className='code-copy interactable';button.title='Copy';button.addEventListener('pointerup',()=>window.copies++);button.addEventListener('click',event=>event.stopPropagation());code.append(button);return button;};
const chat=document.querySelector('#chat');
for(let m=0;m<3;m++){const row=document.createElement('div');row.className='mes';row.setAttribute('mesid',m);row.innerHTML='<div class="mes_text">'+Array.from({length:6},(_,i)=>'<pre><code>const value'+i+' = '+m+';</code></pre>').join('')+'</div>';chat.append(row);}
window.originalButtons=[...chat.querySelectorAll('code')].map(addButton);
window.scheduler=new FrameScheduler();
window.optimizer=new ChatOptimizer({eventSource,eventTypes:event_types,chat:[{mes:'text'}],isGenerating:()=>generating,getCurrentChatId:()=>null,scheduler});
window.diagnostics=new InteractionDiagnostics();diagnostics.start();
window.guard=new InteractionRecoveryGuard();guard.start();
await optimizer.start();window.ready=true;
</script>`;
const server=createServer((req,res)=>{res.setHeader('Content-Type',assets.has(req.url)?'text/javascript':'text/html');res.end(assets.get(req.url)||html);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
    browser=await chromium.launch({headless:true,...(process.env.CLA_BROWSER_EXECUTABLE?{executablePath:process.env.CLA_BROWSER_EXECUTABLE}:{})});
    for(const mobile of [false,true]){
        const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1100,height:900},isMobile:mobile,hasTouch:mobile});
        const errors=[];page.on('pageerror',error=>errors.push(error.message));
        await page.goto('http://127.0.0.1:'+server.address().port);
        await page.waitForFunction(()=>window.ready&&highlights===18);
        assert.equal(await page.evaluate(()=>originalButtons.every(button=>button.isConnected)),true,'preserve native button identities across all highlights');
        assert.equal(await page.locator('.code-copy').count(),18);
        assert.equal(await page.locator('code').first().textContent(),'const value0 = 0;','highlighting preserves the original code text');
        assert.deepEqual(await page.evaluate(()=>copyScopes),[],'existing buttons do not need rebuilding');
        const reads=await page.evaluate(()=>{
            let reads=0;const style=window.getComputedStyle,hit=document.elementFromPoint,stack=document.elementsFromPoint;
            window.getComputedStyle=(...args)=>{reads++;return style(...args);};
            document.elementFromPoint=(...args)=>{reads++;return hit.apply(document,args);};
            document.elementsFromPoint=(...args)=>{reads++;return stack.apply(document,args);};
            try{for(const type of ['pointerdown','pointerup','click'])document.querySelector('#other').dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,button:0}));}
            finally{window.getComputedStyle=style;document.elementFromPoint=hit;document.elementsFromPoint=stack;}
            return reads;
        });
        assert.equal(reads,0,'ordinary pointer handlers do not request synchronous style/hit snapshots');
        if(mobile)await page.locator('.code-copy').first().tap();else await page.locator('.code-copy').first().click();
        assert.equal(await page.evaluate(()=>copies),1,'native pointerup handler still fires once');
        await page.evaluate(()=>{
            const code=document.querySelector('code');const range=document.createRange();range.selectNodeContents(code.firstChild);getSelection().removeAllRanges();getSelection().addRange(range);
            window.selected=getSelection().toString();window.late=document.createElement('code');late.textContent='const late = 1;';const pre=document.createElement('pre');pre.append(late);document.querySelector('.mes_text').append(pre);addButton(late);optimizer.queueHighlight(late,true);
        });
        await page.waitForTimeout(220);
        assert.equal(await page.evaluate(()=>late.dataset.claHighlighted||null),null);
        assert.equal(await page.evaluate(()=>getSelection().toString()===selected),true,'selection remains intact');
        await page.evaluate(()=>getSelection().removeAllRanges());
        await page.waitForFunction(()=>late.dataset.claHighlighted==='1');
        await page.evaluate(async()=>{
            window.popupScans=0;const old=guard.scheduleScan.bind(guard);guard.scheduleScan=()=>{popupScans++;old();};
            window.codeScans=0;const scan=optimizer.observeCodeBlocks.bind(optimizer);optimizer.observeCodeBlocks=()=>{codeScans++;scan();};
            generating=true;emit('start');
            const tail=document.querySelector('.mes:last-child .mes_text');
            for(let i=0;i<25;i++){tail.innerHTML='<p>'+Array.from({length:120},(_,n)=>'<span class="text_segment">'+n+'</span>').join('')+'</p>';await new Promise(requestAnimationFrame);}
        });
        assert.deepEqual(await page.evaluate(()=>({codeScans,popupScans})),{codeScans:0,popupScans:0},'streaming does not trigger plugin code or popup subtree scans');
        await page.evaluate(()=>{generating=false;emit('end');});
        await page.waitForFunction(()=>codeScans>0);
        await page.evaluate(()=>{window.dialog=document.createElement('dialog');dialog.className='popup';dialog.textContent='Valid editor';document.body.append(dialog);dialog.showModal();});
        await page.waitForTimeout(1050);
        assert.equal(await page.evaluate(()=>dialog.open),true,'a visible editor stays open');
        await page.evaluate(async()=>{dialog.close();dialog.remove();await optimizer.stop();diagnostics.stop();guard.stop();scheduler.destroy();});
        assert.equal(await page.evaluate(()=>diagnostics.delayTimers.size),0);
        assert.deepEqual(errors,[]);
        console.log((mobile?'Touch':'Desktop')+': copy identity/handler, zero capture layout reads, selection, streaming scan suspension, valid dialog and cleanup passed');
        await page.close();
    }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
