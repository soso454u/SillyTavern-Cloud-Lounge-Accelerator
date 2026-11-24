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
    const markers = new Map();
    for (const [index, entry] of entries.entries()) {
        const marker = readBoundary(entry.name);
        if (!marker) continue;
        markers.set(index, marker);
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
        pairs.push({ start: start.index, end: index, name: start.title, rank: 2 });
    }
    const sections = removeCrossed(pairs);
    // A one-sided heading such as "=== 基调等 ===" runs until the next divider
    // or the end of the section that contains it.
    for (const open of pending) {
        if (!['dash', 'symbol', 'emoji', 'comment', 'corner', 'quote'].includes(open.family) || !open.title) continue;
        let end = entries.length - 1;
        for (const section of sections) if (section.start < open.index && section.end > open.index) end = Math.min(end, section.end - 1);
        for (let i = open.index + 1; i <= end; i++) if (markers.has(i)) { end = i - 1; break; }
        for (const section of sections) if (section.start > open.index && section.start <= end) end = section.start - 1;
        if (end > open.index) sections.push({ start: open.index, end, name: open.title, rank: 1 });
    }
    // A series that fills a whole section adds nothing.
    const series = findSeries(entries, markers).filter(run => !sections.some(sec => sec.start + 1 === run.start && sec.end - 1 === run.end));
    return removeCrossed([...sections, ...series]);
}

// Runs of neighbours sharing a name stem: 身份1..身份5, 「写卡」…, 剧情选项….
const SYMBOLS = /^[\s\p{P}\p{S}\p{Extended_Pictographic}️]+/u;
function stem(name) {
    const text = String(name ?? '').normalize('NFKC').trim();
    const tag = /^([「【\[《〔(（][^」】\]》〕)）]{1,12}[」】\]》〕)）])/u.exec(text);
    if (tag) return tag[1];
    return text.replace(SYMBOLS, '');
}
function common(a, b) { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i); }
function findSeries(entries, markers) {
    const out = [];
    let i = 0;
    while (i < entries.length) {
        if (markers.has(i)) { i++; continue; }
        let prefix = stem(entries[i].name), j = i;
        while (j + 1 < entries.length && !markers.has(j + 1)) {
            const next = common(prefix, stem(entries[j + 1].name)).replace(/[\s\d\p{P}]+$/u, '');
            if ([...next].length < 2) break;
            prefix = next; j++;
        }
        const name = prefix.replace(/(.)[\[(（【「《〔][^\])）】」》〕]*$/u, '$1').replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '');
        if (j - i + 1 >= 3 && [...name].length >= 2) out.push({ start: i, end: j, name, rank: 0 });
        i = j + 1;
    }
    return out;
}

// rank: manual 3 > paired 2 > one-sided heading 1 > name series 0.
export function removeCrossed(pairs) {
    pairs.sort((a, b) => a.start - b.start || b.end - a.end);
    const dropped = new Set();
    for (const [index, section] of pairs.entries()) {
        for (let i = index + 1; i < pairs.length && pairs[i].start <= section.end; i++) {
            const other = pairs[i];
            const same = other.start === section.start && other.end === section.end;
            if (!same && other.end <= section.end) continue;
            const a = section.rank ?? 2, b = other.rank ?? 2;
            if (a > b) dropped.add(other); else if (b > a) dropped.add(section);
            else if (same) dropped.add(other); else { dropped.add(section); dropped.add(other); }
        }
    }
    return pairs.filter(section => !dropped.has(section)).map(({ rank, ...rest }) => rest.manual ? { ...rest } : rest);
}
