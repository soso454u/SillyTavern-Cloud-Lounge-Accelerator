export const CLIENT_VERSION = '1.2.0';

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoWarm: false,
    cacheThirdPartyAssets: false,
    renderBoost: false,
    renderBoostThreshold: 80,
    longChatMode: false,
    longChatLimit: 50,
    previousChatTruncation: null,
    lastWarmVersion: '',
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

export function normalizeSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        ...DEFAULT_SETTINGS,
        ...source,
        enabled: source.enabled !== false,
        autoWarm: source.autoWarm === true,
        cacheThirdPartyAssets: source.cacheThirdPartyAssets === true,
        renderBoost: source.renderBoost === true,
        renderBoostThreshold: clampInteger(source.renderBoostThreshold, DEFAULT_SETTINGS.renderBoostThreshold, 20, 500),
        longChatMode: source.longChatMode === true,
        longChatLimit: normalizeChoice(source.longChatLimit, DEFAULT_SETTINGS.longChatLimit, [30, 50, 100]),
        previousChatTruncation: Number.isFinite(source.previousChatTruncation)
            ? source.previousChatTruncation
            : null,
        lastWarmVersion: typeof source.lastWarmVersion === 'string' ? source.lastWarmVersion : '',
    };
}

export function shouldActivateRenderBoost({ enabled, messageCount, threshold }) {
    return enabled === true
        && Number.isFinite(messageCount)
        && messageCount >= clampInteger(threshold, DEFAULT_SETTINGS.renderBoostThreshold, 20, 500);
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
