import { getRegexCollectionName } from '../utils/regex-collections.js';
const clone = value => structuredClone(value);
export const fingerprint = value => JSON.stringify(value);
const OPENAI_ORDER_ID = 100001;
const builtinPromptIds = new Set([
    'main', 'nsfw', 'jailbreak', 'enhanceDefinitions', 'chatHistory', 'dialogueExamples',
    'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription',
]);
const isProtectedPrompt = prompt => prompt.marker || prompt.system_prompt || builtinPromptIds.has(prompt.identifier);

function promptOrder(data) {
    const order = data.prompt_order.find(group => String(group?.character_id) === String(OPENAI_ORDER_ID))?.order;
    return Array.isArray(order) ? order : null;
}

function promptInsertionIndex(order, position) {
    if (!position) return order.length;
    if (position.edge === 'start') return 0;
    if (position.edge === 'end') return order.length;
    const index = order.findIndex(item => item?.identifier === position.anchorId);
    if (index < 0 || order.findLastIndex(item => item?.identifier === position.anchorId) !== index) {
        throw new Error('插入位置已变化，请重新选择');
    }
    return index + (position.before ? 0 : 1);
}

export function reorderPresetPrompts(data, ids, position) {
    const next = clone(data);
    const order = promptOrder(next);
    if (!order) throw new Error('请先在酒馆启用此预设，让原生提示词顺序初始化后重试');
    const selected = new Set(ids);
    const moving = order.filter(item => selected.has(item?.identifier));
    const prompts = next.prompts.filter(prompt => selected.has(prompt?.identifier));
    if (!selected.size || moving.length !== selected.size || new Set(moving.map(item => item.identifier)).size !== selected.size
        || prompts.length !== selected.size || prompts.some(isProtectedPrompt)) {
        throw new Error('只能排序已在预设列表中的自定义条目');
    }
    if (position?.anchorId && selected.has(position.anchorId)) return null;
    const remaining = order.filter(item => !selected.has(item?.identifier));
    remaining.splice(promptInsertionIndex(remaining, position), 0, ...moving);
    if (remaining.every((item, index) => item === order[index])) return null;
    order.splice(0, order.length, ...remaining);
    return next;
}

export function transferItems(kind, data) {
    if (kind === 'world') return Object.entries(data.entries).map(([id, value]) => ({ id, value }));
    if (kind !== 'prompt') return data.map(value => ({ id: String(value.id), value }));
    const order = promptOrder(data) ?? [];
    const positions = new Map(order.map((item, index) => [item?.identifier, index]));
    return data.prompts.filter(Boolean).map(value => ({ id: value.identifier, value,
        enabled: order[positions.get(value.identifier)]?.enabled === true,
        inOrder: positions.has(value.identifier),
        protected: Boolean(isProtectedPrompt(value)),
    })).sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity));
}

function removePresetPrompts(data, ids) {
    data.prompts = data.prompts.filter(prompt => !ids.has(prompt?.identifier));
    for (const group of data.prompt_order) {
        if (Array.isArray(group?.order)) group.order = group.order.filter(item => !ids.has(item?.identifier));
    }
    return data;
}

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
    const entry = transferItems(kind, next).find(item => item.id === String(id))?.value;
    if (!entry) throw new Error('条目已不存在，请重新加载');
    if (kind === 'world') {
        entry.comment = String(patch.name ?? entry.comment ?? '');
        entry.content = String(patch.content ?? entry.content ?? '');
        const changes = {};
        if (patch.strategy !== undefined) {
            if (!['normal', 'constant', 'vectorized'].includes(patch.strategy)) throw new Error('触发策略无效');
            changes.constant = patch.strategy === 'constant'; changes.vectorized = patch.strategy === 'vectorized';
        }
        for (const key of ['disable', 'useProbability']) if (patch[key] !== undefined) changes[key] = Boolean(patch[key]);
        for (const [key, min, max] of [['selectiveLogic',0,3], ['position',0,7], ['role',0,2], ['depth',0,10000], ['order',0,Number.MAX_SAFE_INTEGER], ['probability',0,100]]) {
            if (patch[key] === undefined) continue;
            const value = Number(patch[key]);
            if (String(patch[key]).trim() === '' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 必须为 ${min}～${max} 的整数`);
            changes[key] = value;
        }
        for (const key of ['key', 'keysecondary']) if (patch[key] !== undefined) {
            if (!Array.isArray(patch[key]) || patch[key].some(value => typeof value !== 'string')) throw new Error('关键词格式无效');
            changes[key] = clone(patch[key]);
        }
        if (patch.outletName !== undefined) changes.outletName = String(patch.outletName);
        Object.assign(entry, changes);
        const original = Array.isArray(next.originalData?.entries) ? next.originalData.entries.find(item => String(item.uid) === String(id)) : null;
        if (original) {
            Object.assign(original, { comment: entry.comment, content: entry.content });
            const paths = { selectiveLogic: 'selectiveLogic', disable: 'enabled', key: 'keys', keysecondary: 'secondary_keys', constant: 'constant', order: 'insertion_order', useProbability: 'extensions.useProbability', vectorized: 'extensions.vectorized', position: 'extensions.position', role: 'extensions.role', depth: 'extensions.depth', probability: 'extensions.probability', outletName: 'extensions.outlet_name' };
            for (const [key, value] of Object.entries(changes)) {
                const path = paths[key].split('.'); let owner = original;
                for (const part of path.slice(0, -1)) { owner[part] ??= {}; owner = owner[part]; }
                owner[path.at(-1)] = key === 'disable' ? !value : clone(value);
            }
        }
    } else if (kind === 'prompt') {
        if (isProtectedPrompt(entry)) throw new Error('请在酒馆原生编辑器管理内置条目');
        const name = String(patch.name ?? entry.name ?? '').trim();
        if (!name) throw new Error('条目名称不能为空');
        entry.name = name;
        entry.content = String(patch.content ?? entry.content ?? '');
    } else {
        const name = String(patch.name ?? entry.scriptName ?? '').trim();
        if (!name) throw new Error('正则名称不能为空');
        entry.scriptName = name;
        entry.findRegex = String(patch.findRegex ?? entry.findRegex ?? '');
        entry.replaceString = String(patch.replaceString ?? entry.replaceString ?? '');
    }
    return next;
}

export function deleteTransferEntries(kind, data, ids) {
    const wanted = new Set(ids.map(String));
    if (!wanted.size || transferItems(kind, data).filter(item => wanted.has(item.id)).length !== wanted.size) throw new Error('所选条目已改变，请重新加载');
    const next = clone(data);
    if (kind === 'prompt') {
        if (next.prompts.some(prompt => wanted.has(prompt?.identifier) && isProtectedPrompt(prompt))) throw new Error('内置条目不能删除');
        return removePresetPrompts(next, wanted);
    }
    if (kind !== 'world') return next.filter(item => !wanted.has(String(item.id)));
    for (const id of wanted) delete next.entries[id];
    if (Array.isArray(next.originalData?.entries)) next.originalData.entries = next.originalData.entries.filter(item => !wanted.has(String(item.uid)));
    return next;
}

// Plans detached copies only: source/target objects are never mutated here.
export function planTransfer(kind, source, target, ids, uuid = () => crypto.randomUUID(), position = null) {
    const wanted = new Set(ids.map(String));
    const entries = transferItems(kind, source).filter(item => wanted.has(item.id));
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
    } else if (kind === 'prompt') {
        const order = promptOrder(nextTarget);
        if (!order) throw new Error('请先在酒馆启用目标预设，让原生提示词顺序初始化后重试');
        let index = promptInsertionIndex(order, position);
        if (entries.some(item => item.protected)) throw new Error('内置条目不能转移');
        const existing = new Set(nextTarget.prompts.filter(Boolean).map(prompt => prompt.identifier));
        for (const group of nextTarget.prompt_order) {
            for (const item of group?.order || []) existing.add(item?.identifier);
        }
        for (const { value, enabled } of entries) {
            const identifier = uuid();
            if (!identifier || existing.has(identifier)) throw new Error('无法分配新的提示词 ID，请重新操作');
            existing.add(identifier);
            nextTarget.prompts.push({ ...value, identifier, system_prompt: false, marker: false });
            order.splice(index++, 0, { identifier, enabled });
            created.push(identifier);
        }
        removePresetPrompts(nextSource, wanted);
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
        if ((source.kind === 'world') !== (target.kind === 'world')) throw new Error('世界书与其他类型不能混合转移');
        if ((source.kind === 'prompt') !== (target.kind === 'prompt')) throw new Error('预设提示词只能在提示词预设之间转移');
        if (source.kind === target.kind && source.id === target.id) throw new Error('来源和目标不能相同');
        const sourceData = await this.repository.read(source);
        const targetData = await this.repository.read(target);
        return { kind, source, target, ids: [...ids], sourceData, targetData,
            sourceHash: fingerprint(sourceData), targetHash: fingerprint(targetData) };
    }

    async execute(job, { move = false, valid = () => true, uuid, position = null } = {}) {
        if (this.busy) throw new Error('已有转移正在保存');
        this.busy = true;
        let targetSaved = false;
        let created = [];
        try {
            const assertValid = () => { if (!valid()) throw new Error('窗口已关闭或插件已停用，操作已停止'); };
            assertValid();
            if (fingerprint(await this.repository.read(job.source)) !== job.sourceHash
                || fingerprint(await this.repository.read(job.target)) !== job.targetHash) throw new Error('来源或目标已更改，请重新加载后选择');
            assertValid();
            const plan = planTransfer(job.kind, job.sourceData, job.targetData, job.ids, uuid, position);
            await this.repository.beforeWrite?.(job);
            assertValid();
            await this.repository.write(job.target, plan.nextTarget, job.targetData);
            targetSaved = true;
            created = plan.created;
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
            if (targetSaved) error.created = created;
            error.targetSaved = targetSaved || error.targetSaved === true;
            throw error;
        } finally { this.busy = false; }
    }
}

export class NativeTransferRepository {
    constructor({ scriptApi, worldApi, presetApi, openaiApi, extensionSettings, verifyCurrentCharacter = false, fetchImpl = (...args) => fetch(...args) }) {
        Object.assign(this, { scriptApi, worldApi, presetApi, openaiApi, extensionSettings, verifyCurrentCharacter, fetchImpl });
    }

    async post(url, data) {
        const response = await this.fetchImpl(url, { method: 'POST', headers: this.scriptApi.getRequestHeaders(), body: JSON.stringify(data) });
        if (!response.ok) throw new Error(`保存或读取失败（HTTP ${response.status}），请检查连接`);
        return response;
    }

    list(kind) {
        if (kind === 'global') return this.extensionSettings ? [{ kind, id: 'global' }] : [];
        if (kind === 'world') return (this.worldApi.world_names || []).map(name => ({ kind, id: name, name, label: name }));
        if (kind === 'character') return (this.scriptApi.characters || []).filter(character => character?.avatar)
            .map(character => ({ kind, id: character.avatar, avatar: character.avatar, label: `${character.name || '未命名角色'} · ${character.avatar}` }));
        if (kind === 'prompt') {
            const manager = this.presetApi.getPresetManager('openai');
            if (!['getAllPresets', 'getCompletionPresetByName', 'getPresetList', 'getSelectedPresetName', 'savePreset']
                .every(key => typeof manager?.[key] === 'function')) return [];
            return manager.getAllPresets().filter(name => Array.isArray(manager.getCompletionPresetByName(name)?.prompts))
                .map(name => ({ kind, id: JSON.stringify(['openai', name]), apiId: 'openai', name, label: name }));
        }
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
        if (ref.kind === 'global') return clone(this.extensionSettings.regex ?? []);
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
        if (ref.kind === 'prompt') {
            const preset = manager.getCompletionPresetByName(ref.name);
            const current = manager.getSelectedPresetName() === ref.name ? manager.getPresetList().settings : null;
            const { prompts, prompt_order = [] } = current && Array.isArray(current.prompts) ? current : preset;
            if (!Array.isArray(prompts) || !Array.isArray(prompt_order)
                || prompt_order.some(group => !Array.isArray(group?.order))) throw new Error('预设提示词数据格式不正确');
            return clone({ prompts, prompt_order });
        }
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

    async writePresetPrompts(ref, data, expected) {
        const manager = this.presetApi.getPresetManager(ref.apiId);
        const preset = manager.getCompletionPresetByName(ref.name);
        const patch = clone(data);
        await manager.savePreset(ref.name, { ...preset, ...patch }, { skipUpdate: true });
        if (manager.getCompletionPresetByName(ref.name) !== preset) {
            throw new Error('预设在保存期间发生变化，请检查后重新加载两侧');
        }
        const liveChanged = fingerprint(await this.read(ref)) !== fingerprint(expected);
        if (liveChanged) throw new Error('预设在保存期间发生变化，请检查后重新加载两侧');
        Object.assign(preset, patch);
        if (manager.getSelectedPresetName() === ref.name) {
            Object.assign(manager.getPresetList().settings, clone(data));
            this.scriptApi.saveSettingsDebounced?.();
            this.openaiApi?.promptManager?.render?.(false);
        }
    }

    async writeGlobalRegex(data) {
        const saveSettings = this.scriptApi.saveSettings;
        if (typeof saveSettings !== 'function' || !this.scriptApi.settingsReady) throw new Error('酒馆设置尚未就绪');
        const nativeFetch = window.fetch;
        const previous = this.extensionSettings.regex;
        const receipts = [];
        // The native save reports errors internally. Observe its small acknowledgement,
        // and treat overlapping settings requests as unconfirmed.
        const observeSave = (input, init) => {
            const response = nativeFetch.call(window, input, init);
            if (input === '/api/settings/save' && init?.method === 'POST') {
                receipts.push(response.then(async result => result.ok && (await result.clone().json()).result === 'ok')
                    .catch(() => false));
            }
            return response;
        };
        window.fetch = observeSave;
        this.extensionSettings.regex = data;
        try {
            await saveSettings();
            if (receipts.length !== 1 || !await receipts[0] || receipts.length !== 1 || this.extensionSettings.regex !== data) {
                throw new Error('全局正则保存未确认，请检查两个范围');
            }
        } catch (error) {
            if (this.extensionSettings.regex === data) {
                if (previous === undefined) delete this.extensionSettings.regex;
                else this.extensionSettings.regex = previous;
            }
            throw error;
        } finally {
            if (window.fetch === observeSave) window.fetch = nativeFetch;
        }
    }

    async write(ref, data, expected) {
        if (!this.exists(ref) || fingerprint(await this.read(ref)) !== fingerprint(expected)) throw new Error('保存前数据已改变，已停止覆盖');
        if (ref.kind === 'global') return this.writeGlobalRegex(data);
        if (ref.kind === 'world') return this.writeWorld(ref.name, data);
        if (ref.kind === 'prompt') return this.writePresetPrompts(ref, data, expected);
        if (ref.kind === 'character') {
            if (this.verifyCurrentCharacter) {
                const character = this.scriptApi.characters?.[this.scriptApi.this_chid];
                if (character?.avatar !== ref.avatar || fingerprint(character.data?.extensions?.regex_scripts ?? []) !== fingerprint(expected)) {
                    throw new Error('当前角色正则在保存前发生变化，请重新拖动');
                }
            }
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
