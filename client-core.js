export const CLIENT_VERSION = '2.1.14';
export const CHAT_PAGE_SIZE = 5;

export const CHAT_REQUEST_PATHS = Object.freeze(['/api/chats/get', '/api/chats/group/get']);

export function clampInteger(value, fallback, minimum, maximum) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

export function chooseAdaptiveChatLimit() {
    return CHAT_PAGE_SIZE;
}

export function looksLikeHeavyHtml(text) {
    if (typeof text !== 'string' || text.length < 3000) return false;
    const hasDocumentRoot = /<!doctype\s+html\b/i.test(text) || /<html\b/i.test(text);
    const hasPageParts = /<style\b/i.test(text) || /<script\b/i.test(text) || /<head\b/i.test(text);
    const hasFencedHtml = /```html\b/i.test(text);
    return (hasDocumentRoot && hasPageParts) || (hasFencedHtml && text.length >= 6000);
}

export function measureChatPayload(messages) {
    const sample = (Array.isArray(messages) ? messages : []).slice(-40);
    if (!sample.length) {
        return { averageTextLength: 0, richMarkerCount: 0, heavyHtmlCount: 0, maxHtmlLength: 0 };
    }
    const richPattern = /<(?:details|table|svg|pre|iframe)\b|(?:box-shadow|filter\s*:|backdrop-filter|text-shadow)/gi;
    let textLength = 0;
    let richMarkerCount = 0;
    let heavyHtmlCount = 0;
    let maxHtmlLength = 0;
    for (const message of sample) {
        const text = String(message?.mes ?? message?.message ?? '');
        textLength += text.length;
        richMarkerCount += text.match(richPattern)?.length || 0;
        if (looksLikeHeavyHtml(text)) {
            heavyHtmlCount += 1;
            maxHtmlLength = Math.max(maxHtmlLength, text.length);
        }
    }
    return {
        averageTextLength: Math.round(textLength / sample.length),
        richMarkerCount,
        heavyHtmlCount,
        maxHtmlLength,
    };
}

export function selectLiveMessageIndexes(visibility, { generating = false, fallbackCount = 3 } = {}) {
    const states = Array.isArray(visibility) ? visibility : [];
    const selected = new Set();
    states.forEach((visible, index) => {
        if (!visible) return;
        if (index > 0) selected.add(index - 1);
        selected.add(index);
        if (index + 1 < states.length) selected.add(index + 1);
    });
    if (!selected.size) {
        const count = clampInteger(fallbackCount, 3, 1, Math.max(1, states.length));
        for (let index = Math.max(0, states.length - count); index < states.length; index += 1) selected.add(index);
    }
    if (generating && states.length) selected.add(states.length - 1);
    return [...selected].sort((left, right) => left - right);
}

export function classifyStartupRequest({ pathname = '', method = 'GET' } = {}) {
    const verb = String(method).toUpperCase();
    if (CHAT_REQUEST_PATHS.includes(pathname) && verb === 'POST') return 'observe-chat';
    if (pathname === '/api/chats/recent' && verb === 'POST') return 'stale-recent';
    if (verb === 'POST' && (
        /^\/api\/chats\/(?:save|delete|rename|import|group\/(?:save|delete|import))$/.test(pathname)
        || /^\/api\/groups\/(?:create|edit|delete)$/.test(pathname)
    )) return 'invalidate';
    if (verb === 'GET' && (
        pathname === '/api/extensions/discover'
        || /^\/scripts\/extensions\/.+\.(?:html|css|json)$/.test(pathname)
    )) return 'reuse';
    if (verb === 'POST' && ['/api/avatars/get', '/api/characters/all', '/api/backgrounds/all'].includes(pathname)) return 'reuse';
    if (/^\/api\/(?:characters|avatars|backgrounds)\/(?:create|edit|delete|rename|upload|import|duplicate)/.test(pathname)) return 'invalidate';
    return 'native';
}

export function detectSwipeAxis({ deltaX = 0, deltaY = 0, minimum = 12, ratio = 1.35 } = {}) {
    const x = Math.abs(Number(deltaX) || 0);
    const y = Math.abs(Number(deltaY) || 0);
    if (Math.max(x, y) < minimum) return 'pending';
    if (y > x * ratio) return 'vertical';
    if (x > y * ratio) return 'horizontal';
    return 'ambiguous';
}

export function estimateRenderComplexity({ domNodes = 0, htmlLength = 0, richElements = 0 } = {}) {
    return Math.round(
        Math.max(0, Number(domNodes) || 0)
        + Math.max(0, Number(htmlLength) || 0) / 120
        + Math.max(0, Number(richElements) || 0) * 45,
    );
}

export function getAdaptiveBatchSize({ complexity = 0, previousFrameMs = 0, currentBatch = 4 } = {}) {
    const score = Math.max(0, Number(complexity) || 0);
    const frameMs = Math.max(0, Number(previousFrameMs) || 0);
    let batch = clampInteger(currentBatch, 4, 1, 6);
    if (score >= 900) batch = 1;
    else if (score >= 450) batch = Math.min(batch, 2);
    else if (score >= 220) batch = Math.min(batch, 3);
    if (frameMs > 20) batch = Math.max(1, batch - 2);
    else if (frameMs > 13) batch = Math.max(1, batch - 1);
    else if (frameMs > 0 && frameMs < 7 && score < 450) batch = Math.min(6, batch + 1);
    return batch;
}

export function prioritizeMessageDescriptors(descriptors) {
    return [...(Array.isArray(descriptors) ? descriptors : [])]
        .map((descriptor, order) => ({ descriptor, order }))
        .sort((left, right) => {
            const leftPriority = left.descriptor?.visible ? 0 : (left.descriptor?.recent ? 1 : 2);
            const rightPriority = right.descriptor?.visible ? 0 : (right.descriptor?.recent ? 1 : 2);
            return leftPriority - rightPriority || left.order - right.order;
        })
        .map(item => item.descriptor);
}

export function connectionAllowsWarmup(connection) {
    if (!connection) return true;
    if (connection.saveData === true) return false;
    return !['slow-2g', '2g'].includes(connection.effectiveType);
}
