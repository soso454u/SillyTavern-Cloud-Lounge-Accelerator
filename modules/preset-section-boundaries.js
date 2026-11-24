const DOWN = /[↓⇩⬇▼▽]/u;
const UP = /[↑⇧⬆▲△]/u;
const EDGE = /^[^\p{L}\p{N}（(]+|[^\p{L}\p{N}）)]+$/gu;
const BRACKETS = [['『', '』'], ['「', '」'], ['【', '】'], ['[', ']'], ['〔', '〕'], ['［', '］']];
const trimEdge = value => value.replace(EDGE, '').trim();

export function parsePresetSectionMarker(name) {
    let text = String(name || '').trim();
    if (!text) return null;
    const signature = text;
    const comment = /^<!--([\s\S]*)-->$/u.exec(text);
    let family = comment ? 'comment' : 'named', direction;
    if (comment) {
        text = comment[1].trim();
        if (/^[\s=─━_-]+$/u.test(text)) return { direction: 'end', group: null, family };
    }
    const down = DOWN.test(text), up = UP.test(text);
    if (down && up) return null;
    if (down || up) direction = down ? 'start' : 'end';
    for (const [left, right] of BRACKETS) {
        if (text.startsWith(left) && !text.includes(right)) { direction = 'start'; family = `bracket:${left}`; }
        if (text.endsWith(right) && !text.includes(left)) { direction = 'end'; family = `bracket:${left}`; }
    }
    const decorated = /^[-=─━—_~＝]{2,}|[-=─━—_~＝]{2,}$/u.test(text)
        || /^[\p{S}\uFE0F]+[\s\S]+[\p{S}\uFE0F]+$/u.test(text)
        || /^꒰.+꒱$/u.test(text);
    if (!direction && /^[╭╰]/u.test(text)) {
        direction = text.startsWith('╭') ? 'start' : 'end';
        family = 'corners';
    }
    text = text.replace(/[↓⇩⬇▼▽↑⇧⬆▲△]/gu, '').replace(/^꒰[^┈]*┈+|┈+[^┈]*꒱$/gu, '');
    text = trimEdge(text);
    const tail = /^(.*?)(?:结束|终止|完毕|[\s_-]+end)$/iu.exec(text);
    const head = /^(.*?)(?:开始|起始|[\s_-]+(?:s(?:t)?art|begin))$/iu.exec(text);
    const prefix = /^(开始|结束|start\s*[:：]|end\s*[:：])\s*(.+)$/iu.exec(text);
    if (tail?.[1]) { direction = 'end'; text = tail[1]; }
    else if (head?.[1]) { direction = 'start'; text = head[1]; }
    else if (prefix) { direction = /^(?:开始|start)/iu.test(prefix[1]) ? 'start' : 'end'; text = prefix[2]; }
    const group = trimEdge(text);
    if (!group || group.length > 60 || (!direction && !decorated && !comment)) return null;
    return { direction: direction || 'either', group, family, signature };
}

export function findPresetSections(entries) {
    const pending = [], pairs = [];
    const base = name => name?.replace(/[（(][^（）()]*[)）]/gu, '').trim().toLocaleLowerCase();
    for (let index = 0; index < entries.length; index++) {
        const marker = parsePresetSectionMarker(entries[index].name);
        if (!marker) continue;
        if (marker.direction === 'start') { pending.push({ ...marker, index }); continue; }
        const target = base(marker.group);
        const sameFamily = candidate => candidate.family === marker.family;
        const accepts = candidate => marker.direction === 'either' ? candidate.direction === 'either' && candidate.signature === marker.signature
            : !target || base(candidate.group) === target;
        let match = pending.findLastIndex(candidate => sameFamily(candidate) && accepts(candidate));
        if (match < 0 && marker.direction === 'end' && target?.length >= 2) {
            // Some paired dividers shorten their title on the closing row.
            const candidates = pending.filter(candidate => sameFamily(candidate) && base(candidate.group)?.endsWith(target));
            if (candidates.length === 1) match = pending.indexOf(candidates[0]);
        }
        if (match < 0) {
            if (marker.direction === 'either') pending.push({ ...marker, index });
            continue;
        }
        const [opening] = pending.splice(match, 1);
        if (index > opening.index + 1) pairs.push({
            start: opening.index, end: index, name: base(opening.group) === target && marker.group ? marker.group : opening.group,
            explicit: marker.direction === 'end',
        });
    }
    const crossing = (a, b) => a.start < b.start && b.start < a.end && a.end < b.end;
    return pairs.filter(pair => !pairs.some(other => (crossing(pair, other) || crossing(other, pair))
        && (!pair.explicit || other.explicit)))
        .sort((a, b) => a.start - b.start)
        .map(({ start, end, name }) => ({ start, end, name }));
}
