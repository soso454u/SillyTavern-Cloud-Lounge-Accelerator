const activeAnchors = new WeakMap();
// Preserve a stable heading through local layout changes, including height clamps.
export function preservePresetAnchor(anchor, update) {
    if (!anchor?.isConnected) return update();
    const doc = anchor.ownerDocument, win = doc.defaultView, scrolling = doc.scrollingElement || doc.documentElement;
    activeAnchors.get(doc)?.();
    const containers = [];
    for (let node = anchor.parentElement; node; node = node.parentElement) {
        if (node === scrolling || /auto|scroll|overlay/.test(win.getComputedStyle(node).overflowY)) containers.push(node);
    }
    if (!containers.includes(scrolling)) containers.push(scrolling);
    const top = anchor.getBoundingClientRect().top;
    const records = containers.map(node => ({ node, visible: top >= (node === scrolling ? 0 : node.getBoundingClientRect().top) && top < (node === scrolling ? win.innerHeight : node.getBoundingClientRect().bottom),
        value: node.style.getPropertyValue('overflow-anchor'), priority: node.style.getPropertyPriority('overflow-anchor') }));
    for (const { node } of records) node.style.setProperty('overflow-anchor', 'none', 'important');
    let released = false;
    const restore = () => {
        if (released) return; released = true;
        if (activeAnchors.get(doc) === restore) activeAnchors.delete(doc);
        for (const { node, value, priority } of records) {
            if (value) node.style.setProperty('overflow-anchor', value, priority); else node.style.removeProperty('overflow-anchor');
        }
    };
    activeAnchors.set(doc, restore);
    const correct = () => {
        if (released || !anchor.isConnected) return;
        // Inner scroll frames first; an outer frame can absorb their clamp.
        for (const { node } of records) node.scrollTop += anchor.getBoundingClientRect().top - top;
        for (const { node, visible } of records) {
            if (!visible) continue;
            const viewport = node === scrolling ? { top: 0, bottom: win.innerHeight } : node.getBoundingClientRect();
            const rect = anchor.getBoundingClientRect();
            if (rect.top < viewport.top) node.scrollTop += rect.top - viewport.top - 4;
            else if (rect.bottom > viewport.bottom) node.scrollTop += rect.bottom - viewport.bottom + 4;
        }
    };
    try { update(); correct(); } catch (error) { restore(); throw error; }
    win.requestAnimationFrame(() => { try { correct(); } finally { restore(); } });
}
