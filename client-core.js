export const CLIENT_VERSION = '1.3.0';

export const CHAT_LIMIT_CHOICES = Object.freeze([10, 15, 20, 30, 50]);
export const CHAT_REQUEST_PATHS = Object.freeze(['/api/chats/get', '/api/chats/group/get']);

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoWarm: false,
    cacheThirdPartyAssets: false,
    renderBoost: false,
    renderBoostThreshold: 20,
    longChatMode: false,
    longChatLimit: 20,
    previousChatTruncation: null,
    heavyBeautifyMode: false,
    heavyModePrevious: null,
    lastWarmVersion: '',
    settingsVersion: CLIENT_VERSION,
});

function clampInteger(value, fallback, minimum, maximum) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeChoice(value, fallback, choices) {
    const parsed = Number.parseInt(value, 10);
    return choices.includes(parsed) ? parsed : fallback;
}

function isBeforeSettingsVersion13(version) {
    if (typeof version !== 'string') return true;
    const [major = 0, minor = 0] = version.split('.').map(part => Number.parseInt(part, 10) || 0);
    return major < 1 || (major === 1 && minor < 3);
}

export function normalizeSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    const isPre13Settings = isBeforeSettingsVersion13(source.settingsVersion);
    const heavyBeautifyMode = source.heavyBeautifyMode === true;
    const requestedChatLimit = normalizeChoice(source.longChatLimit, DEFAULT_SETTINGS.longChatLimit, CHAT_LIMIT_CHOICES);
    const previous = source.heavyModePrevious && typeof source.heavyModePrevious === 'object'
        ? source.heavyModePrevious
        : null;
    return {
        ...DEFAULT_SETTINGS,
        ...source,
        enabled: source.enabled !== false,
        autoWarm: source.autoWarm === true,
        cacheThirdPartyAssets: source.cacheThirdPartyAssets === true,
        renderBoost: heavyBeautifyMode || source.renderBoost === true,
        renderBoostThreshold: isPre13Settings
            ? DEFAULT_SETTINGS.renderBoostThreshold
            : clampInteger(source.renderBoostThreshold, DEFAULT_SETTINGS.renderBoostThreshold, 1, 500),
        longChatMode: heavyBeautifyMode || source.longChatMode === true,
        longChatLimit: heavyBeautifyMode && requestedChatLimit > 20 ? 20 : requestedChatLimit,
        previousChatTruncation: Number.isFinite(source.previousChatTruncation)
            ? source.previousChatTruncation
            : null,
        heavyBeautifyMode,
        heavyModePrevious: previous ? {
            renderBoost: previous.renderBoost === true,
            longChatMode: previous.longChatMode === true,
            longChatLimit: normalizeChoice(previous.longChatLimit, DEFAULT_SETTINGS.longChatLimit, CHAT_LIMIT_CHOICES),
        } : null,
        lastWarmVersion: typeof source.lastWarmVersion === 'string' ? source.lastWarmVersion : '',
        settingsVersion: CLIENT_VERSION,
    };
}

export function shouldActivateRenderBoost({ enabled, messageCount, threshold }) {
    return enabled === true
        && Number.isFinite(messageCount)
        && messageCount >= clampInteger(threshold, DEFAULT_SETTINGS.renderBoostThreshold, 1, 500);
}

export function isChatRequestEntry(entry) {
    if (!entry || typeof entry.name !== 'string') return false;
    try {
        return CHAT_REQUEST_PATHS.includes(new URL(entry.name, 'http://localhost').pathname);
    } catch {
        return false;
    }
}

export function findLatestChatRequest(entries, now = Number.POSITIVE_INFINITY, maxAge = 120000) {
    return [...(Array.isArray(entries) ? entries : [])]
        .filter(isChatRequestEntry)
        .filter(entry => Number.isFinite(entry.responseEnd) && entry.responseEnd <= now)
        .filter(entry => !Number.isFinite(now) || now - entry.responseEnd <= maxAge)
        .sort((left, right) => right.responseEnd - left.responseEnd)[0] || null;
}

export function buildChatDiagnostics({
    now,
    requestEntry,
    loadStart,
    firstContentAt,
    displayedMessages,
    totalMessages,
    domNodes,
    longTasks = [],
}) {
    const end = Number.isFinite(now) ? now : 0;
    const requestStart = Number.isFinite(requestEntry?.startTime) ? requestEntry.startTime : null;
    const responseEnd = Number.isFinite(requestEntry?.responseEnd) ? requestEntry.responseEnd : null;
    const start = Number.isFinite(loadStart) && requestStart !== null
        ? Math.min(loadStart, requestStart)
        : (Number.isFinite(loadStart) ? loadStart : requestStart);
    const relevantLongTasks = longTasks.filter(entry => {
        const entryStart = Number(entry?.startTime);
        return Number.isFinite(entryStart) && (start === null || entryStart >= start) && entryStart <= end;
    });
    return {
        requestMs: Number.isFinite(requestEntry?.duration) ? requestEntry.duration : null,
        transferBytes: Number.isFinite(requestEntry?.transferSize) ? requestEntry.transferSize : null,
        displayedMessages: Number.isFinite(displayedMessages) ? displayedMessages : 0,
        totalMessages: Number.isFinite(totalMessages) ? totalMessages : 0,
        domNodes: Number.isFinite(domNodes) ? domNodes : 0,
        firstContentMs: start !== null && Number.isFinite(firstContentAt)
            ? Math.max(0, firstContentAt - start)
            : null,
        totalLoadMs: start !== null ? Math.max(0, end - start) : null,
        frontendMs: responseEnd !== null ? Math.max(0, end - responseEnd) : null,
        longestTaskMs: relevantLongTasks.length
            ? Math.max(...relevantLongTasks.map(entry => Number(entry.duration) || 0))
            : null,
        measuredAt: end,
    };
}

export function connectionAllowsWarmup(connection) {
    if (!connection) return true;
    if (connection.saveData === true) return false;
    return !['slow-2g', '2g'].includes(connection.effectiveType);
}

export function shouldAutoWarm({ enabled, autoWarm, visible, connection, lastWarmVersion, version = CLIENT_VERSION }) {
    return enabled === true
        && autoWarm === true
        && visible === true
        && connectionAllowsWarmup(connection)
        && lastWarmVersion !== version;
}
