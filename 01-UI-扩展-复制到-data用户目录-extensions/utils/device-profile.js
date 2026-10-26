export function matchesMedia(query, matchMediaRef = globalThis.matchMedia) {
    try {
        return Boolean(matchMediaRef?.(query)?.matches);
    } catch {
        return false;
    }
}

export function isIosFamily({
    userAgent = '',
    platform = '',
    maxTouchPoints = 0,
} = {}) {
    const touchPoints = Number(maxTouchPoints) || 0;
    return /iPad|iPhone|iPod/i.test(String(userAgent))
        || (String(platform) === 'MacIntel' && touchPoints > 1);
}

export function isTouchEnvironment({
    navigatorRef = globalThis.navigator,
    matchMediaRef = globalThis.matchMedia,
} = {}) {
    return Number(navigatorRef?.maxTouchPoints || 0) > 0
        || matchesMedia('(pointer: coarse)', matchMediaRef);
}

export function isIosWebKitTouch({
    navigatorRef = globalThis.navigator,
    matchMediaRef = globalThis.matchMedia,
} = {}) {
    const userAgent = String(navigatorRef?.userAgent || '');
    return !/Android/i.test(userAgent)
        && isTouchEnvironment({ navigatorRef, matchMediaRef })
        && isIosFamily({
            userAgent,
            platform: navigatorRef?.platform,
            maxTouchPoints: navigatorRef?.maxTouchPoints,
        });
}

export function detectRenderProfile({
    userAgent = globalThis.navigator?.userAgent || '',
    platform = globalThis.navigator?.platform || '',
    maxTouchPoints = globalThis.navigator?.maxTouchPoints || 0,
    coarsePointer = false,
} = {}) {
    const touch = Number(maxTouchPoints) > 0 || coarsePointer === true;
    if (!touch) return 'desktop';
    return !/Android/i.test(String(userAgent)) && isIosFamily({
        userAgent,
        platform,
        maxTouchPoints,
    }) ? 'webkit' : 'balanced';
}
