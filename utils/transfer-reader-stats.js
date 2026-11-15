export const WORLD_FILTERS = [
    ['all', '全部'],
    ['blue', '蓝灯'],
    ['green', '绿灯'],
    ['vector', '向量'],
    ['disabled', '未启用'],
];
export const PRESET_FILTERS = [
    ['all', '全部'],
    ['enabled', '已启用'],
    ['disabled', '未启用'],
];

export function entryStatus(kind, item) {
    if (kind === 'prompt') return item.enabled ? 'enabled' : 'disabled';
    if (kind !== 'world') return null;
    if (item.value.disable) return 'disabled';
    if (item.value.constant) return 'blue';
    return item.value.vectorized ? 'vector' : 'green';
}

export async function countReaderTokens(kind, items, countText, active = () => true) {
    const definitions = kind === 'world' ? WORLD_FILTERS : PRESET_FILTERS;
    const groups = new Map(definitions.slice(1).map(([key]) => [key, []]));
    for (const item of items) {
        const { content, marker } = item.value;
        if (!marker && typeof content === 'string' && content.trim()) groups.get(entryStatus(kind, item)).push(content);
    }
    // Each group is one block of source text. Reuse the same block count
    // for every filter selection, even when the book has hundreds of entries.
    const totals = new Map();
    for (const [key, contents] of groups) {
        if (!active()) break;
        try {
            const result = contents.length ? await countText(contents.join('\n\n')) : 0;
            totals.set(key, Number.isSafeInteger(result) && result >= 0 ? result : null);
        } catch {
            totals.set(key, null);
        }
    }
    if (totals.size === groups.size && [...totals.values()].every(value => value !== null)) {
        totals.set('all', [...totals.values()].reduce((sum, value) => sum + value, 0));
    }
    return totals;
}
