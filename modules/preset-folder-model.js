import { findPresetSections } from './preset-section-boundaries.js';

export const PRESET_GROUPS_KEY = 'cloud_lounge_accelerator_preset_groups';
export const PRESET_GROUPS_SCHEMA = 5;

export function folderLayout(entries) {
    const roots = [];
    const open = [];
    const starts = new Map(findPresetSections(entries).map(section => [section.start, section]));
    for (const [index, entry] of entries.entries()) {
        const section = starts.get(index);
        if (section) {
            const id = JSON.stringify([entry.identifier, entries[section.end].identifier]);
            const folder = { id, name: section.name, total: section.end - index + 1, children: [] };
            (open.at(-1)?.folder.children ?? roots).push(folder);
            open.push({ end: section.end, folder });
        }
        (open.at(-1)?.folder.children ?? roots).push({ entry });
        while (open.at(-1)?.end === index) open.pop();
    }
    return roots;
}
