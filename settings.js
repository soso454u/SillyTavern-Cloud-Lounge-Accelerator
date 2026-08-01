import { CLIENT_VERSION } from './client-core.js';

export const DEFAULT_SETTINGS = Object.freeze({
    pageAcceleration: true,
    chatOptimization: true,
    interactionOptimization: true,
    settingsVersion: CLIENT_VERSION,
});

export function normalizeSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        pageAcceleration: source.pageAcceleration ?? source.enabled !== false,
        chatOptimization: source.chatOptimization ?? source.takeoverEnabled !== false,
        interactionOptimization: source.interactionOptimization !== false,
        settingsVersion: CLIENT_VERSION,
    };
}

export function getLegacyChatTruncation(value) {
    const source = value && typeof value === 'object' ? value : {};
    const candidates = [source.adaptivePreviousChatTruncation, source.previousChatTruncation];
    return candidates.find(Number.isFinite) ?? null;
}
