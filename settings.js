import { CHAT_PAGE_SIZE, CLIENT_VERSION, normalizeChatPageSize } from './client-core.js';

export const DEFAULT_SETTINGS = Object.freeze({
    pageAcceleration: true,
    chatOptimization: true,
    interactionOptimization: true,
    autoConnect: true,
    regexCollections: true,
    transferTools: true,
    presetEntryActions: true,
    presetTokenPreview: true,
    secretKeyBatch: true,
    chatHistoryBatch: true,
    chatPageSize: CHAT_PAGE_SIZE,
    settingsVersion: CLIENT_VERSION,
});

export function normalizeSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        pageAcceleration: source.pageAcceleration ?? source.enabled !== false,
        chatOptimization: source.chatOptimization ?? source.takeoverEnabled !== false,
        interactionOptimization: source.interactionOptimization !== false,
        autoConnect: source.autoConnect !== false,
        regexCollections: source.regexCollections !== false,
        transferTools: source.transferTools !== false,
        presetEntryActions: source.presetEntryActions !== false,
        presetTokenPreview: source.presetTokenPreview !== false,
        secretKeyBatch: source.secretKeyBatch !== false,
        chatHistoryBatch: source.chatHistoryBatch !== false,
        chatPageSize: normalizeChatPageSize(source.chatPageSize),
        settingsVersion: CLIENT_VERSION,
    };
}

export function getLegacyChatTruncation(value) {
    const source = value && typeof value === 'object' ? value : {};
    const candidates = [source.adaptivePreviousChatTruncation, source.previousChatTruncation];
    return candidates.find(Number.isFinite) ?? null;
}
