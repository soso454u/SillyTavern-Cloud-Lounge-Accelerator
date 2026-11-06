import { getRegexCollectionName } from '../utils/regex-collections.js';
const clone = value => structuredClone(value);
export const fingerprint = value => JSON.stringify(value);
const itemsOf = (kind, data) => kind === 'world' ? Object.entries(data.entries).map(([id, value]) => ({ id, value }))
    : data.map(value => ({ id: String(value.id), value }));

export function transferScopeKey(ref) {
    return ref.kind === 'character' ? JSON.stringify(['SCOPED', ref.avatar])
        : ref.kind === 'preset' ? JSON.stringify(['PRESET', ref.apiId, ref.name]) : null;
}

export function transferCollection(ref, value, settings = {}) {
    const assignments = settings.cloud_lounge_accelerator_regex_collections?.[transferScopeKey(ref)]?.assignments;
    return assignments && Object.hasOwn(assignments, String(value.id)) && typeof assignments[value.id] === 'string'
        ? assignments[value.id] : getRegexCollectionName(value.scriptName);
}

export function editTransferEntry(kind, data, id, patch) {
    const next = clone(data);
    const entry = itemsOf(kind, next).find(item => item.id === String(id))?.value;
    if (!entry) throw new Error('条目已不存在，请重新加载');
    if (kind === 'world') {
        entry.comment = String(patch.name ?? entry.comment ?? '');
        entry.content = String(patch.content ?? entry.content ?? '');
        const original = Array.isArray(next.originalData?.entries) ? next.originalData.entries.find(item => String(item.uid) === String(id)) : null;
        if (original) Object.assign(original, { comment: entry.comment, content: entry.content });
    } else {
        const name = String(patch.name ?? entry.scriptName ?? '').trim();
        if (!name) throw new Error('正则名称不能为空');
        entry.scriptName = name;
        entry.findRegex = String(patch.findRegex ?? entry.findRegex ?? '');
        entry.replaceString = String(patch.replaceString ?? entry.replaceString ?? '');
    }
    return next;
}

// Plans detached copies only: source/target objects are never mutated here.
export function planTransfer(kind, source, target, ids, uuid = () => crypto.randomUUID()) {
    const wanted = new Set(ids.map(String));
    const entries = itemsOf(kind, source).filter(item => wanted.has(item.id));
    if (!wanted.size || entries.length !== wanted.size) throw new Error('所选条目已改变，请重新加载来源');
    const nextTarget = clone(target), nextSource = clone(source), created = [];
    if (kind === 'world') {
        let uid = 0;
        let display = Object.values(nextTarget.entries).reduce((max, value) => Math.max(max, Number(value.displayIndex) || 0), -1) + 1;
        for (const { id, value } of entries) {
            while (Object.hasOwn(nextTarget.entries, String(uid))) uid++;
            const copy = { ...clone(value), uid, displayIndex: display++ };
            nextTarget.entries[uid] = copy;
            const original = Array.isArray(source.originalData?.entries) ? source.originalData.entries.find(entry => String(entry.uid) === id) : null;
            if (original && Array.isArray(nextTarget.originalData?.entries)) nextTarget.originalData.entries.push({ ...clone(original), uid });
            delete nextSource.entries[id];
            created.push(String(uid++));
        }
        if (Array.isArray(nextSource.originalData?.entries)) nextSource.originalData.entries = nextSource.originalData.entries.filter(entry => !wanted.has(String(entry.uid)));
    } else {
        const existing = new Set(nextTarget.map(item => String(item.id)));
        for (const { value } of entries) {
            const id = uuid();
            if (!id || existing.has(id)) throw new Error('无法分配新的正则 ID，请重新操作');
            existing.add(id);
            nextTarget.push({ ...clone(value), id });
            created.push(id);
        }
        nextSource.splice(0, nextSource.length, ...nextSource.filter(item => !wanted.has(String(item.id))));
    }
    return { nextSource, nextTarget, created, count: entries.length };
}

export class ContentTransferService {
    constructor(repository) { this.repository = repository; this.busy = false; }

    async prepare(kind, source, target, ids) {
        if ((source.kind === 'world') !== (target.kind === 'world')) throw new Error('世界书与正则不能混合转移');
        if (source.kind === target.kind && source.id === target.id) throw new Error('来源和目标不能相同');
        const sourceData = await this.repository.read(source);
        const targetData = await this.repository.read(target);
        return { kind, source, target, ids: [...ids], sourceData, targetData,
            sourceHash: fingerprint(sourceData), targetHash: fingerprint(targetData) };
    }

    async execute(job, { move = false, valid = () => true } = {}) {
        if (this.busy) throw new Error('已有转移正在保存');
        this.busy = true;
        let targetSaved = false;
        try {
            const assertValid = () => { if (!valid()) throw new Error('窗口已关闭或插件已停用，操作已停止'); };
            assertValid();
            if (fingerprint(await this.repository.read(job.source)) !== job.sourceHash
                || fingerprint(await this.repository.read(job.target)) !== job.targetHash) throw new Error('来源或目标已更改，请重新加载后选择');
            assertValid();
            const plan = planTransfer(job.kind, job.sourceData, job.targetData, job.ids);
            await this.repository.beforeWrite?.(job);
            assertValid();
            await this.repository.write(job.target, plan.nextTarget, job.targetData);
            targetSaved = true;
            if (!move) return { count: plan.count, moved: false, targetSaved, created: plan.created };
            assertValid();
            // A move is two saves, never a delete followed by a copy. Recheck
            // both endpoints before removing anything from the source.
            if (fingerprint(await this.repository.read(job.source)) !== job.sourceHash
                || fingerprint(await this.repository.read(job.target)) !== fingerprint(plan.nextTarget)) throw new Error('数据在复制后发生变化，来源已保留');
            assertValid();
            await this.repository.write(job.source, plan.nextSource, job.sourceData);
            return { count: plan.count, moved: true, targetSaved, created: plan.created };
        } catch (error) {
            error.targetSaved = targetSaved || error.targetSaved === true;
            throw error;
        } finally { this.busy = false; }
    }
}

export class NativeTransferRepository {
    constructor({ scriptApi, worldApi, presetApi, fetchImpl = (...args) => fetch(...args) }) {
        Object.assign(this, { scriptApi, worldApi, presetApi, fetchImpl });
    }

    async post(url, data) {
        const response = await this.fetchImpl(url, { method: 'POST', headers: this.scriptApi.getRequestHeaders(), body: JSON.stringify(data) });
        if (!response.ok) throw new Error(`保存或读取失败（HTTP ${response.status}），请检查连接`);
        return response;
    }

    list(kind) {
        if (kind === 'world') return (this.worldApi.world_names || []).map(name => ({ kind, id: name, name, label: name }));
        if (kind === 'character') return (this.scriptApi.characters || []).filter(character => character?.avatar)
            .map(character => ({ kind, id: character.avatar, avatar: character.avatar, label: `${character.name || '未命名角色'} · ${character.avatar}` }));
        return ['openai', 'textgenerationwebui', 'kobold', 'novel'].flatMap(apiId => {
            const manager = this.presetApi.getPresetManager(apiId);
            if (!['getAllPresets', 'getCompletionPresetByName', 'getPresetList', 'getSelectedPresetName',
                'readPresetExtensionField', 'writePresetExtensionField'].every(key => typeof manager?.[key] === 'function')) return [];
            return manager.getAllPresets().filter(name => manager.getCompletionPresetByName(name))
                .map(name => ({ kind, id: JSON.stringify([apiId, name]), apiId, name, label: `[${apiId}] ${name}` }));
        });
    }

    exists(ref) { return this.list(ref.kind).some(item => item.id === ref.id); }

    async read(ref) {
        if (!this.exists(ref)) throw new Error('来源或目标已不存在，请重新打开工具');
        if (ref.kind === 'world') {
            const data = await this.worldApi.loadWorldInfo(ref.name);
            if (!data?.entries || Array.isArray(data.entries) || typeof data.entries !== 'object') throw new Error('无法读取世界书');
            return clone(data);
        }
        if (ref.kind === 'character') {
            const data = await (await this.post('/api/characters/get', { avatar_url: ref.avatar })).json();
            const scripts = data?.data?.extensions?.regex_scripts ?? [];
            if (!Array.isArray(scripts)) throw new Error('角色正则数据格式不正确');
            return clone(scripts);
        }
        const manager = this.presetApi.getPresetManager(ref.apiId);
        const scripts = manager.readPresetExtensionField({ name: ref.name, path: 'regex_scripts' }) ?? [];
        if (!Array.isArray(scripts)) throw new Error('预设正则数据格式不正确');
        return clone(scripts);
    }

    async beforeWrite(job) {
        if (job.kind !== 'world') return;
        // Flush the native editor's pending debounced save before another book's
        // immediate save cancels that global debounce. No content is changed.
        const select = document.getElementById('world_editor_select');
        if (!select || select.value === '') return;
        const name = this.worldApi.world_names?.[Number(select.value)];
        if (!name || !this.worldApi.worldInfoCache?.has(name)) return;
        const data = await this.worldApi.loadWorldInfo(name);
        await this.writeWorld(name, data);
    }

    async writeWorld(name, data) {
        const previous = this.worldApi.worldInfoCache?.get(name);
        try {
            await this.worldApi.saveWorldInfo(name, data, true);
            // Native saveWorldInfo does not check HTTP status. A fresh server
            // read must agree before a move can delete its source entries.
            const actual = await (await this.post('/api/worldinfo/get', { name })).json();
            if (fingerprint(actual) !== fingerprint(data)) throw new Error('世界书保存未确认，来源条目会保留');
        } catch (error) {
            const current = this.worldApi.worldInfoCache?.get(name);
            if (fingerprint(current) === fingerprint(data)) {
                if (previous) this.worldApi.worldInfoCache.set(name, previous);
                else this.worldApi.worldInfoCache?.delete(name);
            }
            throw error;
        }
        this.worldApi.reloadEditor?.(name);
    }

    async write(ref, data, expected) {
        if (!this.exists(ref) || fingerprint(await this.read(ref)) !== fingerprint(expected)) throw new Error('保存前数据已改变，已停止覆盖');
        if (ref.kind === 'world') return this.writeWorld(ref.name, data);
        if (ref.kind === 'character') {
            await this.post('/api/characters/merge-attributes', { avatar: ref.avatar, data: { extensions: { regex_scripts: data } } });
            if (fingerprint(await this.read(ref)) !== fingerprint(data)) throw new Error('角色正则保存未确认，来源会保留');
            // Update only this extension field in all matching in-memory cards.
            for (const character of this.scriptApi.characters || []) if (character.avatar === ref.avatar) {
                character.data ??= {}; character.data.extensions ??= {};
                character.data.extensions.regex_scripts = clone(data);
                if (character.json_data) {
                    const json = JSON.parse(character.json_data);
                    json.data ??= {}; json.data.extensions ??= {}; json.data.extensions.regex_scripts = clone(data);
                    character.json_data = JSON.stringify(json);
                    if (this.scriptApi.characters[this.scriptApi.this_chid] === character) {
                        const field = document.getElementById('character_json_data');
                        if (field) field.value = character.json_data;
                    }
                }
            }
            return;
        }
        const manager = this.presetApi.getPresetManager(ref.apiId);
        const preset = manager.getCompletionPresetByName(ref.name);
        const settings = manager.getPresetList().settings;
        const owners = [preset, ...(manager.getSelectedPresetName() === ref.name && settings ? [settings] : [])];
        const previous = owners.map(owner => ({ owner, value: owner.extensions?.regex_scripts }));
        try { await manager.writePresetExtensionField({ name: ref.name, path: 'regex_scripts', value: data }); }
        catch (error) {
            for (const { owner, value } of previous) if (owner.extensions?.regex_scripts === data) {
                if (value === undefined) delete owner.extensions.regex_scripts; else owner.extensions.regex_scripts = value;
            }
            // Restore a current preset's failed optimistic extension update.
            this.scriptApi.saveSettingsDebounced?.();
            throw error;
        }
        if (fingerprint(await this.read(ref)) !== fingerprint(data)) throw new Error('预设正则已变化，请检查目标后再操作');
    }
}
