export function hasPointerDragSupport(scope = globalThis) {
    return typeof scope.PointerEvent === 'function'
        && typeof scope.requestAnimationFrame === 'function'
        && typeof scope.document?.elementsFromPoint === 'function';
}

export function isElementActuallyVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

export function requestIdle(callback, timeout = 1500) {
    if (typeof globalThis.requestIdleCallback === 'function') {
        return globalThis.requestIdleCallback(callback, { timeout });
    }
    return globalThis.setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 40);
}

export function cancelIdle(handle) {
    if (typeof globalThis.cancelIdleCallback === 'function') globalThis.cancelIdleCallback(handle);
    else globalThis.clearTimeout(handle);
}
