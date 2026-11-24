// Only complete pairs create groups. The boundary row stays editable in the
// group body, and the synthetic header sits immediately before it.
const patterns = [
    { family: 'bracket-arrow', pattern: /^(={2,})([↓↑])\[([^\[\]]+)\]\2\1$/u, read: m => [m[2] === '↑', m[3], m[1]] },
    { family: 'arrow', pattern: /^([↓↑])([^↓↑]+)\1$/u, read: m => [m[1] === '↑', m[2]] },
    { family: 'quote', pattern: /^『\s*([^『』]+)$/u, read: m => [false, m[1]] },
    { family: 'quote', pattern: /^([^『』]+?)\s*』$/u, read: m => [true, m[1]] },
    { family: 'warning', pattern: /^(={2,})❗\uFE0F?🚫(↑?)([^↑]+)\2🚫❗\uFE0F?\1$/u, read: m => [!!m[2], m[3], m[1]] },
    { family: 'symbol', pattern: /^(=+§-+·)(.+?)(·-+§=+)$/u, read: m => readEnding(m[2], m[1] + '|' + m[3]) },
    { family: 'dash', pattern: /^(-{2,})\s*(.+?)\s*\1$/u, read: m => readEnding(m[2], m[1]) },
    { family: 'emoji', pattern: /^(\p{Extended_Pictographic}\uFE0F?)([^\p{Extended_Pictographic}]+)\1$/u, read: m => readEnding(m[2], m[1], true) },
    { family: 'comment', pattern: /^<!--\s*=+\s*([^=]+?)\s*=+\s*-->$/u, read: m => [false, m[1]] },
    { family: 'comment', pattern: /^<!--\s*={3,}\s*-->$/u, read: () => [true, null] },
];

function readEnding(label, decoration, stripHint = false) {
    if (label.endsWith('结束')) return [true, label.slice(0, -2), decoration];
    return [false, stripHint ? label.replace(/\([^()]+\)$/u, '') : label, decoration];
}

function readBoundary(name) {
    const text = String(name ?? '').normalize('NFKC').trim();
    for (const { family, pattern, read } of patterns) {
        const match = pattern.exec(text);
        if (!match) continue;
        const [closing, label, decoration] = read(match);
        const title = label?.trim();
        if (label !== null && (!title || title.length > 60)) return null;
        return { closing, title, key: JSON.stringify([family, decoration, title]), family };
    }
    return null;
}

export function findPresetSections(entries) {
    const openings = new Map();
    const pairs = [];
    for (const [index, entry] of entries.entries()) {
        const marker = readBoundary(entry.name);
        if (!marker) continue;
        // A comment terminator can close only the most recent comment opener.
        const key = marker.family === 'comment' ? 'comment' : marker.key;
        if (!openings.has(key)) openings.set(key, []);
        const pending = openings.get(key);
        if (!marker.closing) {
            pending.push({ index, title: marker.title });
            continue;
        }
        const start = pending.pop();
        if (start) pairs.push({ start: start.index, end: index, name: start.title });
    }
    pairs.sort((a, b) => a.start - b.start);
    const crossed = new Set();
    for (const [index, section] of pairs.entries()) {
        for (let i = index + 1; i < pairs.length && pairs[i].start < section.end; i++) {
            if (pairs[i].end > section.end) {
                crossed.add(section);
                crossed.add(pairs[i]);
            }
        }
    }
    return pairs.filter(section => !crossed.has(section));
}
