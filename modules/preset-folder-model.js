import { findPresetSections } from './preset-section-boundaries.js';

export const PRESET_GROUPS_KEY = 'cloud_lounge_accelerator_preset_groups';
export const UNGROUPED = '未分类';
export const ROOT = '@root';
export const UNGROUPED_ID = '@ungrouped';
const signatures = new WeakMap();
const newFolderId = () => globalThis.crypto?.randomUUID?.() || `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
            ids.add(item.id);
            const folder = { id: item.id, name, parentId: typeof item.parentId === 'string' ? item.parentId : null };
            if (typeof item.sectionKey === 'string') {
                folder.sectionKey = item.sectionKey;
                if (item.sectionMoved === true) folder.sectionMoved = true;
            }
            state.folders.push(folder);
        }
        const byId = new Map(state.folders.map(folder => [folder.id, folder]));
        for (const folder of state.folders) {
            const visited = new Set([folder.id]); let parent = folder.parentId;
            while (parent) { if (!byId.has(parent) || visited.has(parent)) { folder.parentId = null; break; } visited.add(parent); parent = byId.get(parent).parentId; }
        }
        state.assignments = Object.fromEntries(Object.entries(raw.assignments || {})
            .filter(([, record]) => record && (record.folderId === null || ids.has(record.folderId)))
            .map(([id, record]) => [id, { folderId: record.folderId, source: ['accepted', 'auto', 'section'].includes(record.source) ? record.source : 'manual' }]));
        state.collapsed = [...new Set((Array.isArray(raw.collapsed) ? raw.collapsed : []).filter(id => ids.has(id) || id === UNGROUPED_ID))];
        for (const [parent, order] of Object.entries(raw.order || {})) if (Array.isArray(order)) state.order = { ...state.order, [parent]: [...new Set(order.filter(id => ids.has(id)))] };
        state.fingerprints = Object.fromEntries(Object.entries(raw.fingerprints || {}).filter(([, signature]) => typeof signature === 'string'));
        if (Array.isArray(raw.hiddenSections)) state.hiddenSections = [...new Set(raw.hiddenSections.filter(key => typeof key === 'string'))];
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
export function createFolder(state, name, parentId = null, newId = newFolderId) {
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
    if (folder.sectionKey) folder.sectionMoved = true;
    for (const [parent, order] of Object.entries(state.order)) state.order = { ...state.order, [parent]: order.filter(item => item !== id) };
}
export function deleteFolder(state, id) {
    const folder = state.folders.find(item => item.id === id);
    if (!folder) throw new Error('文件夹已不存在');
    const children = state.folders.filter(child => child.parentId === id);
    for (const child of children) child.parentId = folder.parentId;
    if (folder.sectionKey) state.hiddenSections = [...new Set([...(state.hiddenSections || []), folder.sectionKey])];
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
export function syncPresetSections(state, entries) {
    const oldAssignments = state.assignments;
    const assignments = new Map(Object.entries(oldAssignments).filter(([, item]) => !['auto', 'section'].includes(item.source)));
    const folders = new Map(state.folders.map(folder => [folder.id, folder]));
    const knownSections = new Map(state.folders.filter(folder => folder.sectionKey).map(folder => [folder.sectionKey, folder]));
    const suppressed = new Set(state.hiddenSections);
    const obsolete = new Set();
    for (const item of Object.values(oldAssignments)) {
        if (item.source !== 'auto') continue;
        for (let id = item.folderId; id && !obsolete.has(id); id = folders.get(id)?.parentId) obsolete.add(id);
    }
    const active = [];
    const byStart = new Map(findPresetSections(entries).map(section => [section.start, section]));
    let changed = false;
    entries.forEach((prompt, index) => {
        while (active.length && active.at(-1).end < index) active.pop();
        const section = byStart.get(index);
        if (section) {
            const key = prompt.identifier;
            let folder = null;
            if (!suppressed.has(key)) {
                const parentId = active.at(-1)?.folderId || null;
                folder = knownSections.get(key);
                if (!folder) {
                    folder = state.folders.find(item => !item.sectionKey && item.parentId === parentId && item.name === section.name);
                    if (!folder) {
                        // Distinct intervals can have the same display name.
                        const id = newFolderId();
                        folder = { id, name: section.name, parentId };
                        folders.set(id, folder);
                        state.folders.push(folder);
                        state.collapsed.push(id);
                    }
                    folder.sectionKey = key;
                    changed = true;
                } else if (!folder.sectionMoved && folder.parentId !== parentId) {
                    // A manually moved ancestor could already include this folder.
                    let ancestor = parentId;
                    while (ancestor && ancestor !== folder.id) ancestor = folders.get(ancestor)?.parentId;
                    if (ancestor !== folder.id) { folder.parentId = parentId; changed = true; }
                }
            }
            active.push({ end: section.end, folderId: folder?.id || active.at(-1)?.folderId || null });
        }
        const folderId = active.at(-1)?.folderId;
        if (folderId && !assignments.has(prompt.identifier)) assignments.set(prompt.identifier, { folderId, source: 'section' });
    });
    const used = new Set([...assignments.values()].map(item => item.folderId));
    // Remove obsolete auto-only folders, while keeping custom folders and hand
    // filed entries even if the old automatic pass also used their folder.
    const children = new Map(state.folders.map(folder => [folder.id, 0]));
    for (const folder of state.folders) children.set(folder.parentId, (children.get(folder.parentId) || 0) + 1);
    const removed = new Set();
    for (const id of obsolete) {
        let current = id;
        while (obsolete.has(current) && !folders.get(current)?.sectionKey && !used.has(current) && children.get(current) === 0) {
            const { parentId } = folders.get(current);
            removed.add(current);
            children.delete(current);
            children.set(parentId, children.get(parentId) - 1);
            current = parentId;
        }
    }
    if (removed.size) {
        state.folders = state.folders.filter(folder => !removed.has(folder.id));
        state.collapsed = state.collapsed.filter(id => !removed.has(id));
        changed = true;
    }
    if (assignments.size !== Object.keys(oldAssignments).length || [...assignments].some(([id, record]) =>
        !Object.hasOwn(oldAssignments, id) || oldAssignments[id].folderId !== record.folderId || oldAssignments[id].source !== record.source)) {
        state.assignments = Object.fromEntries(assignments);
        changed = true;
    }
    return changed;
}

// A folder is emitted where its rows actually occur. A hand-filed folder may
// span separate ranges; each range has a header sharing the same fold setting.
export function folderLayout(state, orderedEntries) {
    const folders = new Map(state.folders.map(folder => [folder.id, folder]));
    const paths = new Map(), firstSegment = new Map(), roots = [];
    const pathTo = id => {
        if (!id || !folders.has(id)) return [];
        if (!paths.has(id)) paths.set(id, [...pathTo(folders.get(id).parentId), id]);
        return paths.get(id);
    };
    let position = 0;
    const add = (id, siblings) => {
        const segment = { ...folders.get(id), children: [], total: 0, segment: position++ };
        siblings.push(segment);
        if (!firstSegment.has(id)) firstSegment.set(id, segment);
        return segment;
    };
    const active = [];
    for (const entry of orderedEntries) {
        const path = pathTo(assignedFolder(state, entry.identifier));
        let common = 0;
        while (common < path.length && active[common]?.id === path[common]) common++;
        active.length = common;
        for (const id of path.slice(common)) active.push(add(id, active.at(-1)?.children || roots));
        for (const segment of active) segment.total++;
        (active.at(-1)?.children || roots).push({ entry });
    }
    for (const folder of state.folders) {
        if (folder.sectionKey && !firstSegment.has(folder.id)) continue;
        let siblings = roots;
        for (const id of pathTo(folder.id)) siblings = (firstSegment.get(id) || add(id, siblings)).children;
    }
    return roots;
}
export function importFolderMetadata(raw, prompts, scope = '') {
    if (raw?.schema !== 4 || !Array.isArray(raw.folders)) throw new Error('请选择本插件导出的分类文件');
    const state = normalizeFolderState(raw, prompts, scope), byId = new Map(prompts.map(prompt => [prompt.identifier, prompt]));
    let skipped = 0;
    for (const id of Object.keys(state.assignments)) if (!byId.has(id) || raw.fingerprints?.[id] !== promptFingerprint(byId.get(id))) { delete state.assignments[id]; delete state.fingerprints[id]; skipped++; }
    return { state, skipped };
}
