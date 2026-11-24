// Only complete pairs create groups. The boundary row stays editable in the
// group body, and the synthetic header sits immediately before it.
// Patterns are generic decorations seen across many community presets, not
// tied to one preset. A closer first matches an opener with the same title;
// when titles differ (e.g. "----USER信息----" / "----信息结束----") it falls back
// to the nearest open opener of the same family whose title overlaps.
const patterns = [
    { family: 'bracket-arrow', pattern: /^(={2,})([↓↑])\[([^\[\]]+)\]\2\1$/u, read: m => [m[2] === '↑', m[3], m[1]] },
    { family: 'arrow', pattern: /^([↓↑⬇⬆])([^↓↑⬇⬆]+)\1$/u, read: m => [/[↑⬆]/u.test(m[1]), m[2]] },
    { family: 'quote', pattern: /^『\s*([^『』]+)$/u, read: m => [false, m[1]] },
    { family: 'quote', pattern: /^([^『』]+?)\s*』$/u, read: m => [true, m[1]] },
    { family: 'corner', pattern: /^【\s*([^【】]+)$/u, read: m => [false, m[1]] },
    { family: 'corner', pattern: /^([^【】]+?)\s*】$/u, read: m => [true, m[1]] },
    // ╭─ 标题 ... 标题 ─╯ : box drawings pair by nesting, titles may differ.
    { family: 'box', loose: true, pattern: /^[╭┌]\s*[─━-]+\s*(.+)$/u, read: m => [false, m[1]] },
    { family: 'box', loose: true, pattern: /^(.+?)\s*[─━-]+\s*[╯┘]$/u, read: m => [true, m[1]] },
    { family: 'warning', pattern: /^(={2,})❗️?🚫(↑?)([^↑]+)\2🚫❗️?\1$/u, read: m => [!!m[2], m[3], m[1]] },
    { family: 'symbol', pattern: /^(=+§-+·)(.+?)(·-+§=+)$/u, read: m => readEnding(m[2], m[1] + '|' + m[3]) },
    { family: 'dash', pattern: /^([-=—]{2,})\s*(.+?)\s*\1$/u, read: m => readEnding(m[2], m[1][0]) },
    { family: 'emoji', pattern: /^(\p{Extended_Pictographic}️?)([^\p{Extended_Pictographic}]+)\1$/u, read: m => readEnding(m[2], m[1], true) },
    { family: 'comment', pattern: /^<!--\s*=+\s*([^=]+?)\s*=+\s*-->$/u, read: m => readEnding(m[1], '') },
    { family: 'comment', pattern: /^<!--\s*={3,}\s*-->$/u, read: () => [true, null] },
    { family: 'tag', pattern: /^<\s*([^\s<>/!][^<>]*?)\s*>$/u, read: m => [false, m[1]] },
    { family: 'tag', pattern: /^<\s*\/\s*([^<>]+?)\s*>$/u, read: m => [true, m[1]] },
];

const END = /(?:结束|完|end|END|End)$/u;
function readEnding(label, decoration, stripHint = false) {
    const text = label.trim();
    if (END.test(text) && text.replace(END, '').trim()) return [true, text.replace(END, '').trim(), decoration];
    if (END.test(text)) return [true, '', decoration];
    return [false, stripHint ? text.replace(/[(（][^()（）]+[)）]$/u, '') : text, decoration];
}

function readBoundary(name) {
    const text = String(name ?? '').normalize('NFKC').trim();
    for (const { family, pattern, read, loose } of patterns) {
        const match = pattern.exec(text);
        if (!match) continue;
        const [closing, label, decoration] = read(match);
        const title = label?.trim() ?? null;
        if (label !== null && ((!title && !closing) || title.length > 60)) return null;
        return { closing, title, family, loose: !!loose, key: loose ? family : JSON.stringify([family, decoration ?? '', title]), group: JSON.stringify([family, decoration ?? '']) };
    }
    return null;
}

const overlaps = (a, b) => !!a && !!b && (a.includes(b) || b.includes(a));

export function findPresetSections(entries) {
    const pending = [];
    const pairs = [];
    for (const [index, entry] of entries.entries()) {
        const marker = readBoundary(entry.name);
        if (!marker) continue;
        if (!marker.closing) { pending.push({ index, ...marker }); continue; }
        let at = -1;
        for (let i = pending.length - 1; i >= 0; i--) {
            const open = pending[i];
            if (open.family !== marker.family) continue;
            if (marker.family === 'comment' && marker.title === null) { at = i; break; }
            if (marker.loose || open.key === marker.key) { at = i; break; }
        }
        if (at < 0) for (let i = pending.length - 1; i >= 0; i--) {
            const open = pending[i];
            if (open.group === marker.group && (marker.title === '' || overlaps(open.title, marker.title))) { at = i; break; }
        }
        if (at < 0) continue;
        const [start] = pending.splice(at, 1);
        pairs.push({ start: start.index, end: index, name: start.title });
    }
    return removeCrossed(pairs);
}

export function removeCrossed(pairs, keep = new Set()) {
    pairs.sort((a, b) => a.start - b.start || b.end - a.end);
    const crossed = new Set();
    for (const [index, section] of pairs.entries()) {
        for (let i = index + 1; i < pairs.length && pairs[i].start <= section.end; i++) {
            const other = pairs[i];
            const cross = other.end > section.end || (other.start === section.start && other.end === section.end);
            if (!cross) continue;
            // Manual groups win over recognized ones when they collide.
            if (keep.has(section) && !keep.has(other)) crossed.add(other);
            else if (keep.has(other) && !keep.has(section)) crossed.add(section);
            else if (other.start === section.start && other.end === section.end) crossed.add(other);
            else { crossed.add(section); crossed.add(other); }
        }
    }
    return pairs.filter(section => !crossed.has(section));
}
