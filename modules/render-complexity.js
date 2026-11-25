// Inspect only the current rendered message, without serializing its HTML,
// forcing layout or entering embedded documents. Stop as soon as it is heavy.
const MAX_NODES = 400;
const MAX_CHARS = 64000;
const INTERVALS = {
    desktop: { normal: 0, large: 100, heavy: 250 },
    balanced: { normal: 0, large: 250, heavy: 500 },
    webkit: { normal: 0, large: 250, heavy: 500 },
};

export function measureRenderComplexity(root, documentRef = globalThis.document) {
    let nodes = 0;
    let chars = 0;
    let frames = 0;
    if (root && typeof documentRef?.createTreeWalker === 'function') {
        // SHOW_ELEMENT | SHOW_TEXT. Text.length avoids concatenating code blocks
        // or creating a second copy of a large HTML replacement.
        const walker = documentRef.createTreeWalker(root, 1 | 4);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            nodes++;
            if (node.nodeType === 3) chars = Math.min(MAX_CHARS, chars + node.length);
            else if (node.nodeName === 'IFRAME') frames++;
            if (nodes >= MAX_NODES || chars >= MAX_CHARS || frames >= 3) break;
        }
    }
    const tier = nodes >= MAX_NODES || chars >= MAX_CHARS || frames >= 3 ? 'heavy'
        : nodes >= 160 || chars >= 16000 || frames > 0 ? 'large' : 'normal';
    return { tier, nodes, chars, frames };
}

export function getComplexityInterval(sample, profile) {
    return (INTERVALS[profile] || INTERVALS.desktop)[sample.tier] || 0;
}
