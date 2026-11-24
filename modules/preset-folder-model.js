export const PRESET_GROUPS_KEY = 'cloud_lounge_accelerator_preset_groups';
export const UNGROUPED = '未分类';
export const ROOT = '@root';
const signatures = new WeakMap();
export function hashText(text) {
    let a = 2166136261, b = 2246822519;
    for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b ^ text.charCodeAt(i), 3266489917); }
    return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}
export function promptFingerprint(prompt) {
    const values = [prompt.name, prompt.role, prompt.content, prompt.marker, prompt.system_prompt, prompt.injection_position, prompt.injection_depth, prompt.injection_order];
    const cached = signatures.get(prompt);
    if (cached && values.every((value, index) => value === cached.values[index])) return cached.hash;
    const hash = hashText(JSON.stringify(values)); signatures.set(prompt, { values, hash }); return hash;
}
export function normalizePresetGroup(value) {
    const name = String(value || '').trim();
    if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error('文件夹名称请输入 1–60 个字符');
    return name;
}
export function emptyFolders() { return { schema: 4, folders: [], assignments: {}, collapsed: [], order: {}, fingerprints: {} }; }
export function normalizeFolderState(raw, prompts = [], scope = '') {
    const state = emptyFolders(), known = new Set(prompts.map(prompt => prompt.identifier));
    if (raw?.schema !== 4) {
        // Only explicit legacy assignments migrate. Guessed name/section groups
        // were display-derived, so no automatic category becomes a saved fact.
        const names = new Map();
        const folder = name => {
            if (!names.has(name)) { const id = `migrated-${hashText(scope + name)}`; names.set(name, id); state.folders.push({ id, parentId: null, name }); }
            return names.get(name);
        };
        for (const name of Array.isArray(raw?.groups) ? raw.groups : []) if (typeof name === 'string' && name && name !== UNGROUPED) folder(name);
        for (const [id, name] of Object.entries(raw?.assignments || {})) if (known.has(id) && typeof name === 'string' && name && name !== UNGROUPED) state.assignments = { ...state.assignments, [id]: { folderId: folder(name), source: 'manual' } };
        if (raw && Object.keys(raw).length) state.legacyBackup = structuredClone(raw);
    } else {
        const ids = new Set();
        for (const item of Array.isArray(raw.folders) ? raw.folders : []) {
            if (!item || typeof item.id !== 'string' || !item.id || item.id === ROOT || item.id === '@ungrouped' || ids.has(item.id)) continue;
            let name; try { name = normalizePresetGroup(item.name); } catch { continue; }
            ids.add(item.id); state.folders.push({ id: item.id, name, parentId: typeof item.parentId === 'string' ? item.parentId : null });
        }
        const byId = new Map(state.folders.map(folder => [folder.id, folder]));
        for (const folder of state.folders) {
            const visited = new Set([folder.id]); let parent = folder.parentId;
            while (parent) { if (!byId.has(parent) || visited.has(parent)) { folder.parentId = null; break; } visited.add(parent); parent = byId.get(parent).parentId; }
        }
        for (const [id, record] of Object.entries(raw.assignments || {})) if (record && (record.folderId === null || ids.has(record.folderId))) state.assignments = { ...state.assignments, [id]: { folderId: record.folderId, source: record.source === 'accepted' ? 'accepted' : 'manual' } };
        state.collapsed = [...new Set((Array.isArray(raw.collapsed) ? raw.collapsed : []).filter(id => ids.has(id) || id === '@ungrouped'))];
        for (const [parent, order] of Object.entries(raw.order || {})) if (Array.isArray(order)) state.order = { ...state.order, [parent]: [...new Set(order.filter(id => ids.has(id)))] };
        for (const [id, signature] of Object.entries(raw.fingerprints || {})) if (typeof signature === 'string') state.fingerprints = { ...state.fingerprints, [id]: signature };
        if (raw.legacyBackup) state.legacyBackup = structuredClone(raw.legacyBackup);
    }
    return state;
}
export function folderPath(state, id) {
    const byId = new Map(state.folders.map(folder => [folder.id, folder])), parts = [], visited = new Set();
    while (id && byId.has(id) && !visited.has(id)) { visited.add(id); const folder = byId.get(id); parts.unshift(folder.name); id = folder.parentId; }
    return parts.join(' / ') || UNGROUPED;
}
export function assignedFolder(state, id) { return Object.hasOwn(state.assignments, id) ? state.assignments[id]?.folderId || null : null; }
export function createFolder(state, name, parentId = null, newId = () => globalThis.crypto?.randomUUID?.() || `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`) {
    name = normalizePresetGroup(name);
    if (parentId && !state.folders.some(folder => folder.id === parentId)) throw new Error('上级文件夹已不存在');
    if (state.folders.some(folder => folder.parentId === parentId && folder.name === name)) throw new Error('同一级已有同名文件夹');
    const id = newId(); state.folders.push({ id, name, parentId }); return id;
}
export function renameFolder(state, id, name) {
    name = normalizePresetGroup(name);
    const folder = state.folders.find(item => item.id === id);
    if (!folder) throw new Error('文件夹已不存在');
    if (state.folders.some(item => item.id !== id && item.parentId === folder.parentId && item.name === name)) throw new Error('同一级已有同名文件夹');
    folder.name = name;
}
export function moveFolder(state, id, parentId) {
    const folder = state.folders.find(item => item.id === id);
    if (!folder || (parentId && !state.folders.some(item => item.id === parentId))) throw new Error('文件夹已不存在');
    let current = parentId;
    while (current) { if (current === id) throw new Error('不能移入自身或子文件夹'); current = state.folders.find(item => item.id === current)?.parentId; }
    if (state.folders.some(item => item.id !== id && item.parentId === parentId && item.name === folder.name)) throw new Error('目标位置已有同名文件夹');
    folder.parentId = parentId;
    for (const [parent, order] of Object.entries(state.order)) state.order = { ...state.order, [parent]: order.filter(item => item !== id) };
}
export function deleteFolder(state, id) {
    const folder = state.folders.find(item => item.id === id);
    if (!folder) throw new Error('文件夹已不存在');
    const children = state.folders.filter(child => child.parentId === id);
    for (const child of children) child.parentId = folder.parentId;
    for (const record of Object.values(state.assignments)) if (record.folderId === id) record.folderId = folder.parentId;
    state.folders = state.folders.filter(item => item.id !== id); state.collapsed = state.collapsed.filter(item => item !== id);
    for (const [parent, order] of Object.entries(state.order)) state.order = { ...state.order, [parent]: order.flatMap(item => item === id ? children.map(child => child.id) : [item]) };
    delete state.order[id];
}
export function assignEntries(state, prompts, ids, folderId, source = 'manual') {
    const byId = new Map(prompts.map(prompt => [prompt.identifier, prompt]));
    if (!ids.length || ids.some(id => !byId.has(id))) throw new Error('条目已变化，请重新选择');
    if (folderId && !state.folders.some(folder => folder.id === folderId)) throw new Error('文件夹已不存在');
    for (const id of ids) {
        // Accepted suggestions can never replace a user decision or valid saved relationship.
        if (source === 'accepted' && Object.hasOwn(state.assignments, id)) continue;
        state.assignments = { ...state.assignments, [id]: { folderId, source } };
        state.fingerprints = { ...state.fingerprints, [id]: promptFingerprint(byId.get(id)) };
    }
}
export function folderTree(state, orderedEntries) {
    const nodes = new Map(state.folders.map(folder => [folder.id, { ...folder, items: [], children: [], rank: Infinity }]));
    const roots = [], ungrouped = { id: null, name: UNGROUPED, parentId: null, items: [], children: [], rank: Infinity };
    orderedEntries.forEach((entry, index) => {
        const node = nodes.get(assignedFolder(state, entry.identifier)) || ungrouped;
        node.items.push(entry); node.rank = Math.min(node.rank, index);
        let parent = node.parentId;
        while (parent && nodes.has(parent)) { const ancestor = nodes.get(parent); ancestor.rank = Math.min(ancestor.rank, index); parent = ancestor.parentId; }
    });
    for (const node of nodes.values()) { const parent = nodes.get(node.parentId); if (parent) parent.children.push(node); else roots.push(node); }
    roots.push(ungrouped);
    const sort = (items, parent) => {
        const key = parent || ROOT, order = Object.hasOwn(state.order, key) && Array.isArray(state.order[key]) ? state.order[key] : [];
        const saved = new Map(order.map((id, index) => [id, index]));
        items.sort((a, b) => a.id === null ? 1 : b.id === null ? -1 : saved.size ? (saved.get(a.id) ?? saved.size) - (saved.get(b.id) ?? saved.size) || a.rank - b.rank : a.rank - b.rank);
        for (const node of items) sort(node.children, node.id);
    };
    sort(roots, null); return roots;
}
export function importFolderMetadata(raw, prompts, scope = '') {
    if (raw?.schema !== 4 || !Array.isArray(raw.folders)) throw new Error('请选择本插件导出的分类文件');
    const state = normalizeFolderState(raw, prompts, scope), byId = new Map(prompts.map(prompt => [prompt.identifier, prompt]));
    let skipped = 0;
    for (const id of Object.keys(state.assignments)) if (!byId.has(id) || raw.fingerprints?.[id] !== promptFingerprint(byId.get(id))) { delete state.assignments[id]; delete state.fingerprints[id]; skipped++; }
    return { state, skipped };
}
