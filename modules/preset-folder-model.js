import { ADULT_CATEGORY_ORDER, classifyPresetEntry, PRESET_CATEGORY_ORDER } from './preset-folder-suggestions.js';

export const PRESET_GROUPS_KEY = 'cloud_lounge_accelerator_preset_groups';
export const UNGROUPED = '未分类';
export const ROOT = '@root';
export const UNGROUPED_ID = '@ungrouped';
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
export function emptyFolders() { return { schema: 4, folders: [], assignments: {}, collapsed: [UNGROUPED_ID], order: {}, fingerprints: {} }; }
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
        for (const [id, name] of Object.entries(raw?.assignments || {})) {
            if (!known.has(id)) continue;
            if (name === null || name === UNGROUPED || (typeof name === 'string' && name)) {
                state.assignments = { ...state.assignments, [id]: { folderId: name && name !== UNGROUPED ? folder(name) : null, source: 'manual' } };
            }
        }
        if (Array.isArray(raw?.collapsed)) {
            state.collapsed = raw.collapsed.flatMap(name => name === UNGROUPED || name === UNGROUPED_ID ? [UNGROUPED_ID] : names.has(name) ? [names.get(name)] : []);
        }
        if (raw && Object.keys(raw).length) state.legacyBackup = structuredClone(raw);
    } else {
        const ids = new Set();
        for (const item of Array.isArray(raw.folders) ? raw.folders : []) {
            if (!item || typeof item.id !== 'string' || !item.id || item.id === ROOT || item.id === UNGROUPED_ID || ids.has(item.id)) continue;
            let name; try { name = normalizePresetGroup(item.name); } catch { continue; }
            ids.add(item.id); state.folders.push({ id: item.id, name, parentId: typeof item.parentId === 'string' ? item.parentId : null });
        }
        const byId = new Map(state.folders.map(folder => [folder.id, folder]));
        for (const folder of state.folders) {
            const visited = new Set([folder.id]); let parent = folder.parentId;
            while (parent) { if (!byId.has(parent) || visited.has(parent)) { folder.parentId = null; break; } visited.add(parent); parent = byId.get(parent).parentId; }
        }
        state.assignments = Object.fromEntries(Object.entries(raw.assignments || {})
            .filter(([, record]) => record && (record.folderId === null || ids.has(record.folderId)))
            .map(([id, record]) => [id, { folderId: record.folderId, source: ['accepted', 'auto'].includes(record.source) ? record.source : 'manual' }]));
        state.collapsed = [...new Set((Array.isArray(raw.collapsed) ? raw.collapsed : []).filter(id => ids.has(id) || id === UNGROUPED_ID))];
        for (const [parent, order] of Object.entries(raw.order || {})) if (Array.isArray(order)) state.order = { ...state.order, [parent]: [...new Set(order.filter(id => ids.has(id)))] };
        state.fingerprints = Object.fromEntries(Object.entries(raw.fingerprints || {}).filter(([, signature]) => typeof signature === 'string'));
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
    const id = newId();
    state.folders.push({ id, name, parentId });
    state.collapsed.push(id);
    return id;
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
function saveAssignment(state, prompt, folderId, source) {
    const set = (object, value) => Object.defineProperty(object, prompt.identifier, {
        value, enumerable: true, writable: true, configurable: true,
    });
    set(state.assignments, { folderId, source });
    set(state.fingerprints, promptFingerprint(prompt));
}

export function assignEntries(state, prompts, ids, folderId, source = 'manual') {
    const byId = new Map(prompts.map(prompt => [prompt.identifier, prompt]));
    if (!ids.length || ids.some(id => !byId.has(id))) throw new Error('条目已变化，请重新选择');
    if (folderId && !state.folders.some(folder => folder.id === folderId)) throw new Error('文件夹已不存在');
    for (const id of ids) {
        if (source !== 'manual' && Object.hasOwn(state.assignments, id)) continue;
        saveAssignment(state, byId.get(id), folderId, source);
    }
}
export function classifyUnassignedEntries(state, entries) {
    let changed = false;
    for (const prompt of entries) {
        const id = prompt.identifier;
        if (Object.hasOwn(state.assignments, id)) continue;
        const path = classifyPresetEntry(prompt);
        if (!path) continue;
        let parentId = null;
        for (const name of path) {
            const folder = state.folders.find(item => item.parentId === parentId && item.name === name);
            parentId = folder?.id || createFolder(state, name, parentId);
        }
        saveAssignment(state, prompt, parentId, 'auto');
        changed = true;
    }
    return changed;
}

export function folderTree(state, orderedEntries) {
    const nodes = new Map(state.folders.map(folder => [folder.id, { ...folder, items: [], children: [], total: 0, rank: Infinity }]));
    const roots = [], ungrouped = { id: null, name: UNGROUPED, parentId: null, items: [], children: [], total: 0, rank: Infinity };
    orderedEntries.forEach((entry, index) => {
        const node = nodes.get(assignedFolder(state, entry.identifier)) || ungrouped;
        node.items.push(entry); node.total++; node.rank = Math.min(node.rank, index);
        let parent = node.parentId;
        while (parent && nodes.has(parent)) { const ancestor = nodes.get(parent); ancestor.total++; ancestor.rank = Math.min(ancestor.rank, index); parent = ancestor.parentId; }
    });
    for (const node of nodes.values()) { const parent = nodes.get(node.parentId); if (parent) parent.children.push(node); else roots.push(node); }
    roots.push(ungrouped);
    const sort = (items, parent) => {
        const key = parent || ROOT, order = Object.hasOwn(state.order, key) && Array.isArray(state.order[key]) ? state.order[key] : [];
        const saved = new Map(order.map((id, index) => [id, index]));
        const categories = parent === null ? PRESET_CATEGORY_ORDER
            : nodes.get(parent)?.name === 'NSFW' ? ADULT_CATEGORY_ORDER : [];
        const rank = folder => {
            const index = categories.indexOf(folder.name);
            return index < 0 ? categories.length : index;
        };
        items.sort((a, b) => a.id === null ? 1 : b.id === null ? -1 :
            (saved.get(a.id) ?? saved.size) - (saved.get(b.id) ?? saved.size)
            || rank(a) - rank(b) || a.rank - b.rank);
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
