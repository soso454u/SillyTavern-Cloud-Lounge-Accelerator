const NODE_LIMIT = 10000;
const FRAME_LIMIT = 8;
const DATA_LIMIT = 10000;
const MESSAGE_LIMIT = 100;

function positiveNumber(value) {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function readHeap(performanceRef) {
    try {
        const memory = performanceRef?.memory;
        if (memory && Number.isFinite(memory.usedJSHeapSize)) return {
            support: 'chromium-estimate',
            scope: 'javascript-heap-not-total-tab-memory',
            usedBytes: positiveNumber(memory.usedJSHeapSize),
            allocatedBytes: positiveNumber(memory.totalJSHeapSize),
            limitBytes: positiveNumber(memory.jsHeapSizeLimit),
        };
    } catch { /* Not available on every browser. */ }
    return { support: 'unavailable', usedBytes: null };
}

function readAnimations(documentRef) {
    try {
        if (typeof documentRef?.getAnimations !== 'function') return null;
        const animations = documentRef.getAnimations();
        let running = 0;
        for (const animation of animations) if (animation.playState === 'running') running++;
        return { total: animations.length, running };
    } catch { return null; }
}

function readDocument(documentRef, limit = NODE_LIMIT, frames = []) {
    const result = { elements: 0, iframes: 0, images: 0, gifImages: 0, decodedImagePixels: 0, playingMedia: 0, capped: false };
    try {
        if (!documentRef?.documentElement || typeof documentRef.createTreeWalker !== 'function') return null;
        const walker = documentRef.createTreeWalker(documentRef.documentElement, 1);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            result.elements++;
            if (node.nodeName === 'IFRAME') {
                result.iframes++;
                if (frames.length < FRAME_LIMIT) frames.push(node);
            } else if (node.nodeName === 'IMG') {
                result.images++;
                if (/\.gif(?:[?#]|$)/i.test(node.currentSrc || node.src || '')) result.gifImages++;
                result.decodedImagePixels += (positiveNumber(node.naturalWidth) || 0) * (positiveNumber(node.naturalHeight) || 0);
            } else if (['VIDEO', 'AUDIO'].includes(node.nodeName) && node.paused === false && !node.ended) {
                result.playingMedia++;
            }
            if (result.elements >= limit) { result.capped = true; break; }
        }
        result.animations = readAnimations(documentRef);
        return result;
    } catch { return null; }
}

function readDataShape(value) {
    const seen = new WeakSet();
    const pending = [value];
    let properties = 0, objects = 0, stringChars = 0, capped = false;
    while (pending.length) {
        const item = pending.pop();
        if (typeof item === 'string') { stringChars += item.length; continue; }
        if (!item || typeof item !== 'object' || seen.has(item)) continue;
        seen.add(item); objects++;
        for (const key in item) {
            if (!Object.hasOwn(item, key)) continue;
            if (properties >= DATA_LIMIT) { capped = true; break; }
            properties++;
            // Do not execute getters, macros or toJSON while diagnosing data.
            const descriptor = Object.getOwnPropertyDescriptor(item, key);
            if (descriptor && 'value' in descriptor) pending.push(descriptor.value);
        }
        if (capped) break;
    }
    return { objects, properties, stringChars, capped };
}

// On-demand numeric snapshot only. No observers, timers, heap dumps, source
// serialization or retained DOM/chat references. Counts are not RAM estimates.
export function collectMemoryDiagnostics({
    documentRef = globalThis.document, performanceRef = globalThis.performance,
    chat = [], characters = [],
} = {}) {
    const frames = [];
    const dom = readDocument(documentRef, NODE_LIMIT, frames);
    const embedded = [];
    for (const frame of frames) {
        try {
            const snapshot = readDocument(frame.contentDocument, 2000);
            embedded.push(snapshot ? { access: 'same-origin', ...snapshot } : { access: 'unavailable' });
        } catch { embedded.push({ access: 'unavailable' }); }
    }
    const sample = Array.isArray(chat) ? chat.slice(-MESSAGE_LIMIT) : [];
    let data;
    try { data = readDataShape(sample); } catch { data = null; }
    return {
        heap: readHeap(performanceRef), dom, embedded,
        coverage: {
            scope: 'live-documents-and-recent-chat-sample', detachedNodes: 'not-measured',
            tabTotalMemory: 'not-measured', cpu: 'not-measured', temperature: 'not-measured',
            limits: { domElements: NODE_LIMIT, frameDocuments: FRAME_LIMIT, frameElements: 2000, chatMessages: MESSAGE_LIMIT, chatProperties: DATA_LIMIT },
        },
        chat: { messages: Array.isArray(chat) ? chat.length : 0, sampledMessages: sample.length, data },
        characterCount: Array.isArray(characters) ? characters.length : null,
    };
}
