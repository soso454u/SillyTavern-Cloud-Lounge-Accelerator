const ARROWS_DOWN = /[↓⇩⬇▼▽]/u;
const ARROWS_UP = /[↑⇧⬆▲△]/u;
const EDGE_DECORATION = /^[^\p{L}\p{N}（(]+|[^\p{L}\p{N}）)]+$/gu;

export function parsePresetSectionMarker(value) {
    let text = String(value || '').trim();
    if (!text) return null;
    let direction, family = 'named', strong = false;
    if (/^<!--[\s\S]*-->$/u.test(text)) {
        family = 'comment'; text = text.slice(4, -3).trim();
        if (/^[\s=─━_-]+$/u.test(text)) return { direction: 'end', group: null, family, strong: true };
    }
    const down = ARROWS_DOWN.test(text), up = ARROWS_UP.test(text);
    if (down && up) return null;
    if (down || up) { direction = down ? 'start' : 'end'; strong = true; }
    const brackets = [['『', '』'], ['「', '」'], ['【', '】'], ['[', ']'], ['〔', '〕'], ['［', '］']];
    for (const [left, right] of brackets) {
        if (text.startsWith(left) && !text.includes(right)) { direction = 'start'; family = `bracket:${left}`; strong = true; }
        if (text.endsWith(right) && !text.includes(left)) { direction = 'end'; family = `bracket:${left}`; strong = true; }
    }
    const decorated = /^[-=─━—_~＝]{2,}|[-=─━—_~＝]{2,}$/u.test(text)
        || /^[\p{S}\uFE0F]+[\s\S]+[\p{S}\uFE0F]+$/u.test(text);
    text = text.replace(/[↓⇩⬇▼▽↑⇧⬆▲△]/gu, '').replace(EDGE_DECORATION, '').trim();
    const end = text.match(/^(.*?)(?:结束|终止|完毕|[\s_-]+end)$/iu);
    const start = text.match(/^(.*?)(?:开始|起始|[\s_-]+(?:start|begin))$/iu);
    if (end) { direction = 'end'; text = end[1]; strong = true; }
    else if (start) { direction = 'start'; text = start[1]; strong = true; }
    if (!direction && !decorated && family !== 'comment') return null;
    const group = text.replace(EDGE_DECORATION, '').trim();
    if (!group || group.length > 60) return null;
    return { direction: direction || 'start', group, family, strong };
}

export function findPresetSections(entries) {
    const pending = [], pairs = [];
    const base = name => name?.replace(/[（(][^（）()]*[)）]/gu, '').trim();
    entries.forEach((prompt, index) => {
        const marker = parsePresetSectionMarker(prompt.name);
        if (!marker) return;
        if (marker.direction === 'start') { pending.push({ ...marker, start: index }); return; }
        let match = -1;
        for (let i = pending.length - 1; i >= 0; i--) {
            const candidate = pending[i];
            if (candidate.family !== marker.family) continue;
            if (marker.group === null || candidate.group === marker.group
                || (base(candidate.group) === marker.group && base(candidate.group) !== candidate.group)) { match = i; break; }
        }
        if (match < 0) return;
        // Explicit crossing boundaries are invalid. Unpaired decorative titles
        // inside a valid region do not prevent its named closer from matching.
        if (pending.slice(match + 1).some(item => item.strong)) { pending.splice(match); return; }
        const opening = pending[match]; pending.splice(match);
        pairs.push({ start: opening.start, end: index, name: marker.group || opening.group });
    });
    return pairs.sort((a, b) => a.start - b.start || b.end - a.end);
}
