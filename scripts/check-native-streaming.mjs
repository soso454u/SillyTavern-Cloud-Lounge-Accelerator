// Runs the actual upstream StreamingProcessor and Stopwatch, with isolated DOM,
// formatter, reasoning and persistence fixtures. No user server or chat access.
// CLA_NATIVE_SCRIPT=/path/to/public/script.js CLA_NATIVE_UTILS=/path/to/public/scripts/utils.js node scripts/check-native-streaming.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { StreamingRenderOptimizer } from '../modules/streaming-render-optimizer.js';

if (!process.env.CLA_NATIVE_SCRIPT || !process.env.CLA_NATIVE_UTILS) {
    throw new Error('Set CLA_NATIVE_SCRIPT and CLA_NATIVE_UTILS to the upstream source files being verified');
}
const [script, utils] = await Promise.all([
    readFile(process.env.CLA_NATIVE_SCRIPT, 'utf8'), readFile(process.env.CLA_NATIVE_UTILS, 'utf8'),
]);
function extractClass(source, name) {
    const start = source.indexOf(`class ${name} {`);
    assert.ok(start >= 0, `Upstream ${name} is present`);
    const end = source.indexOf('\n}', start);
    assert.ok(end > start);
    return source.slice(start, end + 2);
}

for (const type of ['normal', 'continue', 'swipe']) {
    for (const stop of [false, true]) {
        let time = 0, formats = 0, tokenEvents = 0, saved = null, ended = 0;
        const handlers = new Map();
        const eventTypes = { STREAM_TOKEN_RECEIVED:'token', GENERATION_ENDED:'end', GENERATION_STOPPED:'stop',
            MESSAGE_RECEIVED:'received', CHARACTER_MESSAGE_RENDERED:'rendered' };
        const eventSource = {
            on(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]); },
            removeListener(name, fn) { handlers.set(name, (handlers.get(name) || []).filter(item => item !== fn)); },
            async emit(name, ...args) { for (const fn of [...(handlers.get(name) || [])]) await fn(...args); },
        };
        eventSource.on('token', () => tokenEvents++);
        class NativeElement {
            constructor() { this.innerHTML = ''; this.textContent = ''; this.classList = { toggle() {} }; }
            querySelector(selector) { return dom[selector]; }
        }
        const dom = Object.fromEntries(['.mes_text','.mes_timer','.tokenCounterDisplay'].map(key => [key,new NativeElement()]));
        const messageDom = new NativeElement();
        const documentRef = { querySelector: selector => selector.startsWith('#chat') ? messageDom : {}, addEventListener() {}, removeEventListener() {} };
        const chat = [{ mes:'prefix ', name:'test', is_user:false, is_system:false, extra:{}, swipes:['prefix '], swipe_id:0, swipe_info:[{}] }];
        const powerUser = { streaming_fps:30, stream_fade_in:false, message_token_count_enabled:true };
        const preferences = structuredClone(powerUser);
        class FixedDate extends Date {
            constructor(...args) { super(...(args.length ? args : [time])); }
            static now() { return time; }
        }
        class ReasoningHandler {
            constructor() { this.reasoning=''; }
            updateReasoning(_id, value) { this.reasoning=value || ''; }
            updateDom() {}
            getDuration() { return 0; }
            async process() { chat[0].extra.reasoning=this.reasoning; }
            async finish() {}
        }
        const environment = {
            Date:FixedDate, document:documentRef, HTMLElement:NativeElement, AbortController, structuredClone,
            console:{ warn() {}, error(error) { throw error; } },
            ReasoningHandler, chat, power_user:powerUser, eventSource, event_types:eventTypes,
            scrollLock:true, chatElement:{ find:() => messageDom },
            cleanUpMessage:({getMessage}) => getMessage, isOdd:value => value % 2 !== 0,
            countOccurrences:(text, part) => text.split(part).length-1,
            messageFormatting:text => { formats++; return text; },
            getTokenCountAsync:async text => text.length,
            formatGenerationTimer:() => ({ timerValue:'1s', timerTitle:'fixture' }),
            addCopyToCodeBlocks() {}, syncMesToSwipe() {}, saveLogprobsForActiveMessage() {}, updateSwipeCounter() {},
            getStoppingStrings:() => [], main_api:'openai', playMessageSound() {},
            saveChatConditional:async () => { saved=structuredClone(chat[0]); },
            unblockGeneration:() => { ended++; void eventSource.emit('end'); },
        };
        const NativeProcessor = runInNewContext(`${extractClass(utils,'Stopwatch')}\n${extractClass(script,'StreamingProcessor')}\nStreamingProcessor`, environment);
        const processor = new NativeProcessor(type, false, new FixedDate(), 'prefix ', {});
        processor.messageId=0;
        const original = processor.onProgressStreaming;
        const optimizer = new StreamingRenderOptimizer({ eventSource, eventTypes, getStreamingProcessor:() => processor,
            documentRef, navigatorRef:{ userAgent:'iPhone', maxTouchPoints:5 }, matchMedia:() => ({ matches:false }), now:() => time });
        optimizer.start();
        let yielded = 0;
        processor.generator = async function* () {
            for (let i=1;i<=100;i++) {
                time=i*10;
                if (stop && i===61) { processor.onStopStreaming(); await eventSource.emit('stop'); }
                yielded++;
                yield { text:'reply '+i, state:{ reasoning:'reason '+i }, swipes:[] };
            }
        };
        const result = await processor.generate();
        assert.equal(tokenEvents, stop ? yielded-1 : yielded, 'native stop excludes the post-abort snapshot');
        assert.ok(formats>1 && formats<yielded/2, 'full-message formatting is coalesced');
        const expected=type==='continue' ? 'prefix '+result : result;
        if (type==='continue') assert.ok(result.startsWith('reply '));
        // Native caller supplies the full continuation on completion.
        const fullText=type==='continue' ? processor.continueMessage+result : result;
        assert.equal(fullText, expected);
        await processor.onFinishStreaming(0, fullText);
        assert.equal(saved.mes, fullText);
        assert.equal(dom['.mes_text'].innerHTML, fullText);
        assert.ok(saved.extra.token_count>0);
        assert.equal(saved.extra.reasoning,'reason '+tokenEvents);
        assert.equal(processor.onProgressStreaming,original);
        assert.equal(ended,1);
        assert.deepEqual(powerUser,preferences);
        optimizer.stop();
        console.log(`PASS upstream ${type}, ${stop?'stopped':'complete'}: ${tokenEvents} token events, ${formats} formatting passes, final DOM/chat/reasoning/tokens/save/restore`);
    }
}
