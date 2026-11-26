import { findPresetSections, removeCrossed } from './preset-section-boundaries.js';

export const PRESET_GROUPS_KEY = 'cloud_lounge_accelerator_preset_groups';
export const PRESET_GROUPS_SCHEMA = 5;

// manual: [{ start: identifier, end: identifier, name }]. Manual groups are
// metadata only; they never reorder or edit native prompt rows.
export function resolveSections(entries, manual = []) {
    const index = new Map(entries.map((entry, i) => [entry.identifier, i]));
    const auto = findPresetSections(entries);
    for (const group of manual) {
        const a = index.get(group.start), b = index.get(group.end);
        if (a === undefined || b === undefined) continue;
        auto.push({ start: Math.min(a, b), end: Math.max(a, b), name: group.name || '新分组', manual: true, rank: 3 });
    }
    return removeCrossed(auto);
}

export function folderLayout(entries, manual = [], names = {}, hidden = [], { automaticSubgroups = false } = {}) {
    const skip = new Set(hidden);
    const roots = [];
    const open = [];
    const starts = new Map();
    for (const section of resolveSections(entries, manual)) {
        if (!section.manual && skip.has(JSON.stringify([entries[section.start].identifier, entries[section.end].identifier]))) continue;
        if (!starts.has(section.start)) starts.set(section.start, []);
        starts.get(section.start).push(section);
    }
    for (const list of starts.values()) list.sort((a, b) => b.end - a.end);
    for (const [index, entry] of entries.entries()) {
        for (const section of starts.get(index) || []) {
            if (!automaticSubgroups && !section.manual && open.length) continue;
            const id = JSON.stringify([entry.identifier, entries[section.end].identifier]);
            const original = section.name;
            const folder = { id, name: section.manual ? original : (names[id] || original), original, manual: !!section.manual, rank: section.rank ?? 2, total: section.end - index + 1, children: [] };
            (open.at(-1)?.folder.children ?? roots).push(folder);
            open.push({ end: section.end, folder });
        }
        (open.at(-1)?.folder.children ?? roots).push({ entry });
        while (open.at(-1)?.end === index) open.pop();
    }
    return roots;
}
