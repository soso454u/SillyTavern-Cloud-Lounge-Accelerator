const UNGROUPED_COLLECTION = '未分类';

export function getRegexCollectionName(scriptName) {
    const name = String(scriptName || '').trim();
    const bracketed = name.match(/^(?:\[([^\]]+)\]|【([^】]+)】|〔([^〕]+)〕|「([^」]+)」|『([^』]+)』)/u);
    const collection = bracketed?.slice(1).find(Boolean)?.trim();
    // Numbered packs use the second field as their collection, e.g. 00b | iMessage | 会话视角.
    const numbered = name.match(/^[0-9０-９]+[a-z]?\s*[|｜│]\s*([^|｜│]+)[|｜│]\s*\S/iu);
    return collection || numbered?.[1].trim() || UNGROUPED_COLLECTION;
}
