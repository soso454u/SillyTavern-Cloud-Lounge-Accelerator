#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

// SillyTavern 1.18.0: src/endpoints/settings.js and src/constants.js.
// Backend presets are validated JSON sent as strings. The other presets are sent as values.
const presetSources = [
    ['KoboldAI Settings', 'koboldai_settings', 'koboldai_setting_names'],
    ['NovelAI Settings', 'novelai_settings', 'novelai_setting_names'],
    ['OpenAI Settings', 'openai_settings', 'openai_setting_names'],
    ['TextGen Settings', 'textgenerationwebui_presets', 'textgenerationwebui_preset_names'],
    ['themes', 'themes'],
    ['movingUI', 'movingUIPresets'],
    ['QuickReplies', 'quickReplyPresets'],
    ['instruct', 'instruct'],
    ['context', 'context'],
    ['sysprompt', 'sysprompt'],
    ['reasoning', 'reasoning'],
];

// The default report displays only upstream schema keys and anonymous labels.
const settingsKeys = new Set([
    'firstRun', 'accountStorage', 'currentVersion', 'username', 'active_character',
    'active_group', 'user_avatar', 'amount_gen', 'max_context', 'main_api',
    'world_info_settings', 'textgenerationwebui_settings', 'swipes', 'horde_settings',
    'power_user', 'extension_settings', 'tags', 'tag_map', 'nai_settings', 'kai_settings',
    'oai_settings', 'background', 'proxies', 'selected_proxy',
]);
const extensionKeys = new Set([
    'apiUrl', 'apiKey', 'autoConnect', 'notifyUpdates', 'disabledExtensions',
    'expressionOverrides', 'memory', 'note', 'caption', 'expressions', 'connectionManager',
    'dice', 'regex', 'regex_presets', 'character_allowed_regex', 'preset_allowed_regex',
    'tts', 'sd', 'chromadb', 'translate', 'objective', 'quickReply', 'quickReplyV2',
    'randomizer', 'speech_recognition', 'rvc', 'vectors', 'variables', 'attachments',
    'character_attachments', 'disabled_attachments', 'gallery',
]);
const historyKeys = new Set([
    'history', 'histories', 'archive', 'archives', 'backup', 'backups', 'snapshots',
]);
const chunkSize = 64 * 1024;
const nestedLimit = 2 * 1000 * 1000;
const nestedBudget = 32 * 1000 * 1000;
const maxFingerprints = 20000;

class AuditError extends Error {}

function* stringChunks(value) {
    for (let start = 0; start < value.length;) {
        let end = Math.min(start + chunkSize, value.length);
        // Keep any surrogate pair together for the same encoding as JSON.stringify(value).
        const before = value.charCodeAt(end - 1);
        const after = value.charCodeAt(end);
        if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end++;
        yield value.slice(start, end);
        start = end;
    }
}

function jsonStringBytes(value) {
    if (value.length <= chunkSize) return Buffer.byteLength(JSON.stringify(value));
    let bytes = 2;
    for (const chunk of stringChunks(value)) {
        bytes += Buffer.byteLength(JSON.stringify(chunk)) - 2;
    }
    return bytes;
}

function isContainer(value) {
    return value !== null && typeof value === 'object';
}

function* childKeys(value) {
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) yield index;
    } else {
        yield* Object.keys(value);
    }
}

// Count compact serialization with an iterative traversal. Never concatenate a whole
// object or the outer response. Inspect nodes as their sizes become available.
function measureJson(value, visit = () => {}) {
    function frame(node, key) {
        if (isContainer(node)) return { node, key, keys: childKeys(node), bytes: 2, count: 0, max: 0 };
        const bytes = typeof node === 'string' ? jsonStringBytes(node) : JSON.stringify(node).length;
        return { node, key, bytes, count: 1, max: bytes, entryBytes: bytes };
    }

    const stack = [frame(value)];
    while (true) {
        const current = stack.at(-1);
        const next = current.keys?.next();
        if (next && !next.done) {
            stack.push(frame(current.node[next.value], next.value));
            continue;
        }
        stack.pop();
        const { node, key, bytes, count, max, entryBytes } = current;
        visit(node, key, stack.length, bytes, count);
        if (!stack.length) return { bytes, count, max, entryBytes };
        addChild(stack.at(-1), key, bytes);
    }
}

function addChild(parent, key, bytes) {
    parent.bytes += bytes + (parent.count ? 1 : 0);
    if (typeof key === 'string') parent.bytes += jsonStringBytes(key) + 1;
    parent.count++;
    parent.max = Math.max(parent.max, bytes);
    parent.entryBytes = (parent.entryBytes ?? 0) + bytes;
}

function resolveDirectory(directory, label, allowLink = false) {
    try {
        if (!allowLink && !fs.lstatSync(directory).isDirectory()) throw new Error();
        const real = fs.realpathSync(directory);
        if (fs.statSync(real).isDirectory()) return real;
    } catch {
        // Omit paths and OS error details from the output.
    }
    throw new AuditError(`无法读取目录 ${label}。请核对实例路径、数据根目录及用户参数，或检查目录是否为符号链接。`);
}

function readRegularFile(file, hashBytes = false) {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    // lstat also excludes links on platforms without O_NOFOLLOW.
    const listed = fs.lstatSync(file);
    if (!listed.isFile()) throw new Error();
    const fd = fs.openSync(file, flags);
    try {
        const before = fs.fstatSync(fd);
        if (!before.isFile() || before.dev !== listed.dev || before.ino !== listed.ino) throw new Error();
        const data = fs.readFileSync(fd);
        const after = fs.fstatSync(fd);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
            throw new AuditError('读取期间检测到源文件变动。请在设置和预设未保存时重跑。');
        }
        return {
            raw: data.toString('utf8'),
            disk: before.size,
            sha256: hashBytes ? createHash('sha256').update(data).digest('hex') : undefined,
        };
    } finally {
        fs.closeSync(fd);
    }
}

function list(directory, label) {
    try {
        return fs.readdirSync(directory);
    } catch {
        throw new AuditError(`无法列出 ${label}。该目录无法用于复现原生响应。`);
    }
}

function makeDuplicateCounter() {
    const seen = new Map();
    const result = { groups: 0, copies: 0, bytes: 0, skipped: 0 };
    const bySource = new Map();
    return {
        result,
        bySource,
        add(fingerprint, bytes, source) {
            if (seen.has(fingerprint)) {
                if (!seen.get(fingerprint)) result.groups++;
                result.copies++;
                result.bytes += bytes;
                seen.set(fingerprint, true);
                const row = bySource.get(source) ?? { copies: 0, bytes: 0 };
                row.copies++;
                row.bytes += bytes;
                bySource.set(source, row);
            } else if (seen.size < maxFingerprints) {
                seen.set(fingerprint, false);
            } else {
                result.skipped++;
            }
        },
    };
}

function makeOpenAITextIndex() {
    const firstFiles = new Map();
    let skipped = 0;
    return {
        get skipped() { return skipped; },
        add(file, seenInFile, fingerprint, bytes) {
            if (seenInFile.has(fingerprint)) {
                file.internalCopies++;
                file.internalBytes += bytes;
                return;
            }
            // Retain metadata only. Each file's first occurrence can count once
            // as a cross-file copy, and its later occurrences count as internal.
            const first = firstFiles.get(fingerprint);
            if (!first) {
                if (firstFiles.size >= maxFingerprints) {
                    skipped++;
                    return;
                }
                firstFiles.set(fingerprint, { file, shared: false });
            } else {
                if (!first.shared) first.file.sharedBytes += bytes;
                first.shared = true;
                file.sharedBytes += bytes;
                file.crossCopies++;
                file.crossBytes += bytes;
            }
            seenInFile.add(fingerprint);
        },
    };
}

function makeAudit(showLocalDetails) {
    const textDuplicates = makeDuplicateCounter();
    const presetDuplicates = makeDuplicateCounter();
    const nested = new Map();
    const history = new Map();
    const largest = [];
    const presetGroups = showLocalDetails ? new Map() : null;
    const openAIText = showLocalDetails ? makeOpenAITextIndex() : null;
    let nestedBytes = 0;

    function inspect(value, key, bytes, count, source, onLongText) {
        if (isContainer(value) && typeof key === 'string' && historyKeys.has(key.toLowerCase())) {
            const row = history.get(source) ?? { count: 0, entries: 0, max: 0 };
            row.count++;
            row.entries += count;
            row.max = Math.max(row.max, bytes);
            history.set(source, row);
        }
        if (typeof value !== 'string') return;
        if (bytes >= 1026 && Buffer.byteLength(value) >= 1024) {
            const hash = createHash('sha256');
            for (const chunk of stringChunks(value)) hash.update(chunk, 'utf16le');
            const fingerprint = hash.digest('hex');
            textDuplicates.add(fingerprint, bytes, source);
            onLongText?.(fingerprint, bytes);
        }

        const start = value.search(/[^ \t\r\n]/);
        const opening = value[start];
        if (opening !== '{' && opening !== '[') return;
        const last = /[^ \t\r\n][ \t\r\n]*$/u.exec(value);
        if (last?.[0][0] !== (opening === '{' ? '}' : ']')) return;

        const row = nested.get(source) ?? { objects: 0, arrays: 0, skipped: 0, bytes: 0, max: 0 };
        if (bytes > nestedLimit || nestedBytes + bytes > nestedBudget) {
            row.skipped++;
        } else {
            nestedBytes += bytes;
            try {
                JSON.parse(value);
                if (opening === '{') row.objects++;
                else row.arrays++;
                row.bytes += bytes;
                row.max = Math.max(row.max, bytes);
            } catch {
                return;
            }
        }
        nested.set(source, row);
    }

    function addLargest(row) {
        if (largest.length === 20 && row.bytes <= largest.at(-1).bytes) return;
        largest.push(row);
        largest.sort((left, right) => right.bytes - left.bytes);
        if (largest.length > 20) largest.pop();
    }

    return { inspect, addLargest, largest, nested, history, textDuplicates, presetDuplicates, presetGroups, openAIText };
}

function analyzeSettings(file, audit, extensionIds) {
    let settings;
    let disk;
    let responseBytes;
    try {
        const input = readRegularFile(file);
        ({ disk } = input);
        responseBytes = jsonStringBytes(input.raw);
        settings = JSON.parse(input.raw);
    } catch (error) {
        if (error instanceof AuditError) throw error;
        throw new AuditError('无法读取或解析指定用户的 settings.json。');
    }
    if (!isContainer(settings) || Array.isArray(settings)) throw new AuditError('settings.json 顶层不是对象。');

    const fields = [];
    const compact = { count: 0, bytes: 2, max: 0 };
    const extensions = [];
    const extensionDetails = [];
    let hiddenFields = 0;
    let hiddenExtensions = 0;
    for (const [key, value] of Object.entries(settings)) {
        const label = settingsKeys.has(key) ? key : `自定义字段 #${++hiddenFields}`;
        let stats;
        if (key === 'extension_settings' && isContainer(value) && !Array.isArray(value)) {
            const parent = { count: 0, bytes: 2, max: 0 };
            for (const [extension, config] of Object.entries(value)) {
                const known = extensionKeys.has(extension);
                const name = known ? extension : `自定义扩展配置 #${++hiddenExtensions}`;
                const item = analyzeSettingValue(config, `extension_settings/${name}`, extension, audit);
                extensions.push({ label: name, ...item });
                if (!known && extensionIds.has(hiddenExtensions)) {
                    extensionDetails.push({ id: hiddenExtensions, key: extension, bytes: item.bytes });
                }
                addChild(parent, extension, item.bytes);
            }
            stats = parent;
        } else {
            stats = analyzeSettingValue(value, label, key, audit);
        }
        fields.push({ label, ...stats });
        addChild(compact, key, stats.bytes);
    }
    return {
        disk, responseBytes, fields, extensions, extensionDetails, compactBytes: compact.bytes,
        activeOpenAI: settings.oai_settings?.preset_settings_openai ?? settings.preset_settings_openai,
    };
}

function analyzeSettingValue(value, label, rootKey, audit) {
    let entry = 0;
    return measureJson(value, (node, key, depth, bytes, count) => {
        audit.inspect(node, depth === 0 ? rootKey : key, bytes, count, label);
        if (depth === 1 || (depth === 0 && (!isContainer(node) || count === 0))) {
            audit.addLargest({ label: depth === 1 ? `${label} / 条目 #${++entry}` : label, bytes });
        }
    });
}

function analyzePresetDirectory(userRoot, [directory, field, namesField], audit, activeOpenAI) {
    const root = resolveDirectory(path.join(userRoot, directory), field);
    const names = list(root, field).filter(name => path.parse(name).ext === '.json').sort();
    const payload = { label: field, directory, count: 0, bytes: 2, disk: 0, max: 0, maxDisk: 0 };
    const filenames = { label: namesField, count: 0, bytes: 2, max: 0 };
    const openAI = field === 'openai_settings' ? [] : null;
    let skipped = 0;
    let skippedDisk = 0;

    for (const [index, name] of names.entries()) {
        let input;
        try {
            input = readRegularFile(path.join(root, name), true);
        } catch (error) {
            if (error instanceof AuditError) throw error;
            throw new AuditError(`${field} 的匿名文件 #${index + 1} 无法读取或不是普通文件，无法完整复现。`);
        }
        const { disk, raw, sha256 } = input;
        let value;
        try {
            value = JSON.parse(raw);
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            skipped++;
            skippedDisk += disk;
            continue;
        }
        const stem = namesField ? path.parse(name).name : undefined;
        const entry = { id: index + 1, disk, field };
        if (openAI) {
            entry.nameBytes = jsonStringBytes(stem);
            entry.selected = stem === activeOpenAI;
            Object.assign(entry, { internalCopies: 0, internalBytes: 0, sharedBytes: 0, crossCopies: 0, crossBytes: 0 });
            openAI.push(entry);
        }
        if (audit.presetGroups) {
            entry.name = name;
            const group = audit.presetGroups.get(sha256) ?? [];
            group.push(entry);
            audit.presetGroups.set(sha256, group);
        }
        const seenInFile = openAI && audit.openAIText ? new Set() : null;
        const onLongText = seenInFile
            ? (fingerprint, bytes) => audit.openAIText.add(entry, seenInFile, fingerprint, bytes)
            : undefined;
        const size = measureJson(value, (node, key, _depth, bytes, count) => {
            audit.inspect(node, key, bytes, count, field, onLongText);
        });
        const bytes = namesField ? jsonStringBytes(raw) : size.bytes;
        entry.bytes = bytes;
        addChild(payload, index, bytes);
        payload.disk += disk;
        payload.maxDisk = Math.max(payload.maxDisk, disk);
        if (namesField) addChild(filenames, index, entry.nameBytes ?? jsonStringBytes(stem));
        audit.presetDuplicates.add(sha256, disk, field);
        audit.addLargest({ label: `${field} / 文件 #${index + 1}`, bytes, disk });
    }
    return { payload, filenames: namesField ? filenames : null, skipped, skippedDisk, openAI };
}

function analyzeWorldNames(userRoot) {
    const root = resolveDirectory(path.join(userRoot, 'worlds'), 'world_names');
    const row = { label: 'world_names', bytes: 2, count: 0, max: 0 };
    for (const name of list(root, 'world_names')) {
        if (path.extname(name).toLowerCase() === '.json') {
            addChild(row, row.count, jsonStringBytes(path.parse(name).name));
        }
    }
    return row;
}

const mb = bytes => (bytes / 1000000).toFixed(3);
const asSize = bytes => `${bytes.toLocaleString('en-US')} B / ${mb(bytes)} MB`;
const ordered = rows => [...rows].sort((left, right) => right.bytes - left.bytes);

function showRank(title, rows, total) {
    console.log(`\n${title}（百分比的分母为 ${asSize(total)}）`);
    console.table(ordered(rows).map(row => ({
        来源: row.label,
        '序列化 B': row.bytes,
        '序列化 MB': mb(row.bytes),
        占比: `${(total ? 100 * row.bytes / total : 0).toFixed(2)}%`,
        数量: row.count ?? '—',
        '最大条目 B': row.count ? row.max : '—',
        '平均条目 B': row.count ? (row.entryBytes / row.count).toFixed(1) : '—',
        '磁盘 B': row.disk ?? '—',
        '磁盘 MB': row.disk === undefined ? '—' : mb(row.disk),
    })));
}

function terminalLabel(value) {
    // A filename or custom key may contain terminal controls or bidi formatting.
    return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, character => {
        return `\\u{${character.codePointAt(0).toString(16)}}`;
    });
}

function archiveBytes(files, count) {
    const values = files.reduce((sum, file) => sum + file.bytes + file.nameBytes, 0);
    // Both arrays retain their brackets, even when all entries are removed.
    const removedCommas = Math.max(count - 1, 0) - Math.max(count - files.length - 1, 0);
    return values + 2 * removedCommas;
}

function showArchiveEstimate(title, files, count, estimated) {
    const bytes = archiveBytes(files, count);
    console.log(`${title}（${files.length} 项）预计每次响应减少 ${asSize(bytes)}，剩余 ${asSize(estimated - bytes)}。`);
}

function showLocalDetails(audit, openAI, estimated) {
    console.log('\nOpenAI 预设排行榜（文件名仅在本地详细模式展示）');
    console.table(ordered(openAI).map(file => ({
        编号: file.id, 文件名: terminalLabel(file.name), '磁盘 B': file.disk, '响应值 B': file.bytes,
        '单项归档估减 B': archiveBytes([file], openAI.length),
        当前保存选择: file.selected ? '是' : '—',
    })));
    console.log('按文件统计重复长文本（≥ 1024 UTF-8 B，下表字节数按内层 JSON 字符串值计）');
    console.table(ordered(openAI).map(file => ({
        编号: file.id, '内部额外次数': file.internalCopies, '内部额外 B': file.internalBytes,
        '跨文件额外次数': file.crossCopies, '跨文件额外 B': file.crossBytes, '跨文件共有 B': file.sharedBytes,
    })));
    const totals = openAI.reduce((sum, file) => {
        sum.internal += file.internalBytes;
        sum.cross += file.crossBytes;
        return sum;
    }, { internal: 0, cross: 0 });
    console.log(`OpenAI 内部额外 ${asSize(totals.internal)}，跨文件额外 ${asSize(totals.cross)}，探测预算外 ${audit.openAIText.skipped} 次。`);
    console.log('跨文件额外值归到排序较后的文件，各文件重复出现的剩余次数归到文件内部。跨文件共有列同时标记首个文件，不参与加总。');

    const candidates = [];
    const duplicates = [...audit.presetGroups].filter(([, files]) => files.length > 1);
    console.log('\n原始字节相同的预设组（SHA-256）');
    if (!duplicates.length) console.log('本次未发现。');
    for (const [hash, files] of duplicates) {
        console.log(hash);
        const openAIFiles = files.filter(file => file.field === 'openai_settings');
        const keep = openAIFiles.find(file => file.selected) ?? openAIFiles[0];
        console.table(files.map(file => ({
            类型: file.field, 编号: file.id, 文件名: terminalLabel(file.name), '磁盘 B': file.disk,
        })));
        // Only OpenAI copies with an equivalent file in the same preset directory
        // are suggested. Prefer keeping the currently selected name.
        candidates.push(...openAIFiles.filter(file => file !== keep));
    }
    if (candidates.length) {
        console.log(`完全重复的 OpenAI 归档候选编号 ${candidates.map(file => file.id).join(', ')}。请先核对其他配置或脚本对这些名称的引用。`);
        showArchiveEstimate('归档上述完全重复候选', candidates, openAI.length, estimated);
    }
}

function parseIds(values, option) {
    const ids = new Set();
    for (const value of values ?? []) {
        const id = Number(value);
        if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(id)) {
            throw new AuditError(`--${option} 需要正整数编号，可重复使用。`);
        }
        ids.add(id);
    }
    return ids;
}

function argumentsForAudit() {
    const { values } = parseArgs({
        options: {
            root: { type: 'string' },
            user: { type: 'string' },
            'data-root': { type: 'string' },
            'decoded-bytes': { type: 'string' },
            'encoded-bytes': { type: 'string' },
            'transfer-bytes': { type: 'string' },
            'show-local-details': { type: 'boolean' },
            'extension-id': { type: 'string', multiple: true },
            'archive-openai': { type: 'string', multiple: true },
            help: { type: 'boolean', short: 'h' },
        },
    });
    if (values.help) {
        console.log('用法: node scripts/analyze-settings-size.mjs --root <SillyTavern根目录> --user <用户handle>');
        console.log('可选: --data-root <实际dataRoot，默认<root>/data>');
        console.log('可选: --decoded-bytes <decodedBodySize> --encoded-bytes <encodedBodySize> --transfer-bytes <transferSize>');
        console.log('本地查看: --show-local-details 显示预设文件名、逐文件重复统计及 SHA-256 对应关系。');
        console.log('本地查看: --extension-id 22 --extension-id 6 显示指定匿名编号的配置键名。');
        console.log('只读估算: --archive-openai 8 --archive-openai 24 按编号估算合计可减的解码响应字节。');
        return null;
    }
    if (!values.root || !values.user || /[/\\:\u0000-\u001f]/u.test(values.user)
        || /^\./u.test(values.user) || path.basename(values.user) !== values.user) {
        throw new AuditError('请指定 --root 和单个有效的 --user handle。使用 --help 查看参数。');
    }
    const observed = {};
    for (const key of ['decoded-bytes', 'encoded-bytes', 'transfer-bytes']) {
        if (values[key] === undefined) continue;
        const bytes = Number(values[key]);
        if (!/^\d+$/u.test(values[key]) || !Number.isSafeInteger(bytes)) {
            throw new AuditError(`--${key} 需要非负整数 bytes。`);
        }
        observed[key] = bytes;
    }
    return {
        ...values, observed,
        extensionIds: parseIds(values['extension-id'], 'extension-id'),
        archiveIds: parseIds(values['archive-openai'], 'archive-openai'),
    };
}

function main() {
    const args = argumentsForAudit();
    if (!args) return;
    const root = resolveDirectory(args.root, 'SillyTavern 根目录', true);
    if (!fs.existsSync(path.join(root, 'src', 'endpoints', 'settings.js'))) {
        throw new AuditError('指定根目录缺少 SillyTavern 的 src/endpoints/settings.js。');
    }
    const dataRoot = resolveDirectory(path.resolve(root, args['data-root'] ?? 'data'), 'dataRoot', true);
    const userRoot = resolveDirectory(path.join(dataRoot, args.user), '指定用户数据');
    const audit = makeAudit(args['show-local-details']);
    const settings = analyzeSettings(path.join(userRoot, 'settings.json'), audit, args.extensionIds);
    const presets = presetSources.map(source => analyzePresetDirectory(userRoot, source, audit, settings.activeOpenAI));
    const openAI = presets.find(row => row.openAI).openAI;
    const archive = openAI.filter(file => args.archiveIds.has(file.id));
    if (archive.length !== args.archiveIds.size) throw new AuditError('指定的 OpenAI 归档编号中有不存在或无效的预设。');
    if (settings.extensionDetails.length !== args.extensionIds.size) throw new AuditError('指定的自定义扩展编号中有不存在的配置。');
    const defaults = {
        enable_extensions: true,
        enable_extensions_auto_update: true,
        enable_accounts: false,
        request_compression: { enabled: false, minPayloadSize: 262144, maxPayloadSize: 8388608, timeout: 3000 },
    };
    const response = [
        { label: 'settings', count: 1, bytes: settings.responseBytes, max: settings.responseBytes,
            entryBytes: settings.responseBytes, disk: settings.disk },
        ...presets.flatMap(({ payload, filenames }) => filenames ? [payload, filenames] : [payload]),
        analyzeWorldNames(userRoot),
        ...Object.entries(defaults).map(([label, value]) => ({ label, ...measureJson(value) })),
    ];
    const overhead = 2 + response.length - 1
        + response.reduce((sum, row) => sum + jsonStringBytes(row.label) + 1, 0);
    const estimated = overhead + response.reduce((sum, row) => sum + row.bytes, 0);

    console.log('SillyTavern 1.18.0 /api/settings/get 只读体积分析');
    console.log(`磁盘来源合计（settings.json 与成功读取的预设） ${asSize(settings.disk + presets.reduce((sum, { payload }) => sum + payload.disk, 0))}`);
    console.log(`估算 HTTP 解码正文 ${asSize(estimated)}（紧凑 JSON，配置字段按上游默认值）`);
    for (const [option, label] of [
        ['decoded-bytes', '实测 HTTP 解码正文'], ['encoded-bytes', '实测压缩正文'], ['transfer-bytes', '实测网络传输总量'],
    ]) {
        console.log(`${label} ${args.observed[option] === undefined ? '未提供' : asSize(args.observed[option])}`);
    }
    if (args.observed['decoded-bytes'] !== undefined) {
        console.log(`估算减实测 ${asSize(estimated - args.observed['decoded-bytes'])}`);
    }
    console.log(`外层字段名和分隔符 ${asSize(overhead)}。world_names 仅读名称，磁盘正文不计入。`);
    console.log('settings.json 下级为解析后紧凑 JSON 的值，各级分母含该对象的属性名及分隔符。');
    showRank('响应顶层字段', response, estimated);
    showRank('settings.json 内部字段', settings.fields, settings.compactBytes);
    if (settings.extensions.length) {
        showRank('extension_settings 内部配置', settings.extensions,
            settings.fields.find(row => row.label === 'extension_settings').bytes);
    }
    console.log('\n预设文件按类型汇总（序列化大小为正文值的数组，名称数组见顶层表）');
    console.table(presets.map(({ payload, skipped, skippedDisk }) => ({
        目录类型: payload.directory, 文件数: payload.count, '磁盘 B': payload.disk,
        '磁盘 MB': mb(payload.disk), '序列化 B': payload.bytes, '序列化 MB': mb(payload.bytes),
        占响应: `${(100 * payload.bytes / estimated).toFixed(2)}%`,
        '最大文件 B': payload.count ? payload.maxDisk : '—',
        '平均文件 B': payload.count ? (payload.disk / payload.count).toFixed(1) : '—',
        '跳过的无效 JSON': skipped, '跳过的磁盘 B': skippedDisk,
    })));
    console.log('\n最大 20 个条目（文件按响应值，设置条目按内部紧凑值）');
    console.table(audit.largest.map(({ label, bytes, disk }) => ({
        条目: label, '序列化 B': bytes, '序列化 MB': mb(bytes), '磁盘 B': disk ?? '—',
    })));
    console.log('\n嵌套 JSON 字符串（只分类一层，以字符串的 JSON 编码字节计）');
    console.table([...audit.nested].map(([source, row]) => ({
        来源: source, 对象: row.objects, 数组: row.arrays, '大小 B': row.bytes,
        '最大 B': row.max, 超出探测预算: row.skipped,
    })));
    console.log('历史、归档、备份和快照（仅按固定键名识别，匹配不代表可删）');
    console.table([...audit.history].map(([source, row]) => ({
        来源: source, 匹配数: row.count, 直接子项: row.entries, '最大 B': row.max,
    })));
    for (const [label, { result, bySource }] of [
        ['相同长文本（≥ 1024 UTF-8 B，按字符串的 JSON 编码字节计）', audit.textDuplicates],
        ['相同预设文件原始字节（SHA-256，按额外文件的磁盘字节计）', audit.presetDuplicates],
    ]) {
        console.log(`${label} ${result.groups} 组，额外副本 ${result.copies} 项，共 ${asSize(result.bytes)}，索引预算外 ${result.skipped} 项。`);
        if (bySource.size) {
            console.table([...bySource].sort((left, right) => right[1].bytes - left[1].bytes).map(([source, row]) => ({
                来源: source, 额外副本: row.copies, '额外 B': row.bytes,
            })));
        }
    }
    if (args['show-local-details']) showLocalDetails(audit, openAI, estimated);
    if (settings.extensionDetails.length) {
        console.log('\n指定的自定义扩展配置键（仅键名）');
        console.table(settings.extensionDetails.map(row => ({
            编号: row.id, 配置键: terminalLabel(row.key), '紧凑 JSON B': row.bytes,
        })));
    }
    if (archive.length) {
        showArchiveEstimate(`按指定编号 ${archive.map(file => file.id).join(', ')} 估算归档`, archive, openAI.length, estimated);
        if (archive.some(file => file.selected)) console.log('候选包含当前保存的 OpenAI 预设，请在手动归档前先切换。');
    }
    if (args['show-local-details'] || archive.length) {
        console.log('归档估值包含预设正文值、名称值和数组分隔符，仅代表解码响应。手动移出扫描目录后，这些预设在恢复前会从酒馆预设列表消失。');
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof AuditError ? error.message : '分析失败。请检查参数、源文件可读性和 Node.js 可用内存。使用 --help 查看参数。');
    process.exitCode = 1;
}
