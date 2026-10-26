import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { writeConfigWithBackup } from './config-backup.js';

const BOOLEAN_TEXT = '(?:true|false)';
const CHAT_COMPRESSION_VALUES = Object.freeze({
    minPayloadSize: "'256kb'",
    maxPayloadSize: '0',
    timeout: '15000',
});

function commandLineValue(name) {
    const exact = `--${name}`;
    const index = process.argv.findIndex(argument => argument === exact || argument.startsWith(`${exact}=`));
    if (index < 0) return '';
    const argument = process.argv[index];
    return argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : (process.argv[index + 1] || '');
}

export function resolveConfigPath() {
    const requested = commandLineValue('configPath') || process.env.SILLYTAVERN_CONFIGPATH || '';
    if (!requested) return join(process.cwd(), 'config.yaml');
    return isAbsolute(requested) ? requested : resolve(process.cwd(), requested);
}

export function readPerformanceSettings(content) {
    const keepAlive = content.match(new RegExp(`^enableKeepAlive\\s*:\\s*(${BOOLEAN_TEXT})\\b`, 'm'));
    const lines = content.split(/\r?\n/);
    let lazyCharacters = null;
    let chatCompression = null;
    let performanceIndent = -1;
    let compressionIndent = -1;

    for (const line of lines) {
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const indent = line.match(/^\s*/)?.[0].length || 0;
        if (performanceIndent < 0) {
            if (indent === 0 && /^performance\s*:\s*(?:#.*)?$/.test(line)) performanceIndent = indent;
            continue;
        }
        if (indent <= performanceIndent) break;

        if (compressionIndent >= 0 && indent <= compressionIndent) compressionIndent = -1;
        if (compressionIndent >= 0) {
            const compressionMatch = line.match(new RegExp(`^\\s+enabled\\s*:\\s*(${BOOLEAN_TEXT})\\b`));
            if (compressionMatch) chatCompression = compressionMatch[1] === 'true';
            continue;
        }

        const lazyMatch = line.match(new RegExp(`^\\s+lazyLoadCharacters\\s*:\\s*(${BOOLEAN_TEXT})\\b`));
        if (lazyMatch) lazyCharacters = lazyMatch[1] === 'true';
        if (/^\s+requestCompression\s*:\s*(?:#.*)?$/.test(line)) compressionIndent = indent;
    }

    return {
        keepAlive: keepAlive ? keepAlive[1] === 'true' : null,
        lazyCharacters,
        chatCompression,
    };
}

function replaceBooleanLine(line, key, enabled) {
    const match = line.match(new RegExp(`^(\\s*${key}\\s*:)\\s*[^#]*(\\s+#.*)?$`));
    if (!match) return line;
    return `${match[1]} ${enabled ? 'true' : 'false'}${match[2] || ''}`;
}

function replaceValueLine(line, key, value) {
    const match = line.match(new RegExp(`^(\\s*${key}\\s*:)\\s*[^#]*(\\s+#.*)?$`));
    if (!match) return line;
    return `${match[1]} ${value}${match[2] || ''}`;
}

function findBlockEnd(lines, start, indent) {
    for (let index = start + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const currentIndent = line.match(/^\s*/)?.[0].length || 0;
        if (currentIndent <= indent) return index;
    }
    return lines.length;
}

function ensurePerformanceBlock(lines) {
    let index = lines.findIndex(line => /^performance\s*:\s*(?:#.*)?$/.test(line));
    if (index >= 0) return index;
    lines.push('', '# Managed by Cloud Lounge Accelerator', 'performance:');
    index = lines.length - 1;
    return index;
}

function updateChatCompression(lines, enabled) {
    const performanceIndex = ensurePerformanceBlock(lines);
    const performanceEnd = findBlockEnd(lines, performanceIndex, 0);
    let compressionIndex = lines.slice(performanceIndex + 1, performanceEnd)
        .findIndex(line => /^\s+requestCompression\s*:\s*(?:#.*)?$/.test(line));

    if (compressionIndex < 0) {
        const block = [
            '  # Managed by Cloud Lounge Accelerator: compress large chat saves over the network',
            '  requestCompression:',
            `    enabled: ${enabled}`,
        ];
        if (enabled) {
            block.push(
                `    minPayloadSize: ${CHAT_COMPRESSION_VALUES.minPayloadSize}`,
                `    maxPayloadSize: ${CHAT_COMPRESSION_VALUES.maxPayloadSize}`,
                `    timeout: ${CHAT_COMPRESSION_VALUES.timeout}`,
            );
        }
        lines.splice(performanceIndex + 1, 0, ...block);
        return;
    }

    compressionIndex += performanceIndex + 1;
    const compressionIndent = lines[compressionIndex].match(/^\s*/)?.[0].length || 2;
    const fieldIndent = `${' '.repeat(compressionIndent + 2)}`;
    let compressionEnd = findBlockEnd(lines, compressionIndex, compressionIndent);

    const upsert = (key, value) => {
        const relativeIndex = lines.slice(compressionIndex + 1, compressionEnd)
            .findIndex(line => new RegExp(`^\\s+${key}\\s*:`).test(line));
        if (relativeIndex >= 0) {
            const index = compressionIndex + 1 + relativeIndex;
            lines[index] = key === 'enabled'
                ? replaceBooleanLine(lines[index], key, value === true)
                : replaceValueLine(lines[index], key, value);
            return;
        }
        lines.splice(compressionEnd, 0, `${fieldIndent}${key}: ${value}`);
        compressionEnd += 1;
    };

    upsert('enabled', enabled);
    if (enabled) {
        for (const [key, value] of Object.entries(CHAT_COMPRESSION_VALUES)) upsert(key, value);
    }
}

export function updatePerformanceSetting(content, setting, enabled) {
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    const hadFinalNewline = /\r?\n$/.test(content);
    const lines = content.split(/\r?\n/);
    if (hadFinalNewline) lines.pop();

    if (setting === 'keepAlive') {
        const index = lines.findIndex(line => /^enableKeepAlive\s*:/.test(line));
        if (index >= 0) lines[index] = replaceBooleanLine(lines[index], 'enableKeepAlive', enabled);
        else lines.push('', '# Managed by Cloud Lounge Accelerator', `enableKeepAlive: ${enabled}`);
    } else if (setting === 'lazyCharacters') {
        const performanceIndex = ensurePerformanceBlock(lines);
        const blockEnd = findBlockEnd(lines, performanceIndex, 0);
        const lazyIndex = lines.slice(performanceIndex + 1, blockEnd)
            .findIndex(line => /^\s+lazyLoadCharacters\s*:/.test(line));
        if (lazyIndex >= 0) {
            const absoluteIndex = performanceIndex + 1 + lazyIndex;
            lines[absoluteIndex] = replaceBooleanLine(lines[absoluteIndex], 'lazyLoadCharacters', enabled);
        } else {
            lines.splice(performanceIndex + 1, 0, `  lazyLoadCharacters: ${enabled}`);
        }
    } else if (setting === 'chatCompression') {
        updateChatCompression(lines, enabled);
    } else {
        throw new TypeError('未知的性能设置');
    }

    return `${lines.join(lineEnding)}${hadFinalNewline ? lineEnding : ''}`;
}

export async function writePerformanceSetting(configPath, setting, enabled) {
    const current = await readFile(configPath, 'utf8');
    const updated = updatePerformanceSetting(current, setting, enabled);
    const result = await writeConfigWithBackup({
        configPath,
        updatedContent: updated,
        validate(content) {
            const value = readPerformanceSettings(content);
            if (setting === 'keepAlive') return value.keepAlive === enabled;
            if (setting === 'lazyCharacters') return value.lazyCharacters === enabled;
            return value.chatCompression === enabled;
        },
    });
    return {
        changed: result.changed,
        backup: result.backup,
        migrated: result.migrated,
        pruned: result.pruned,
        settings: readPerformanceSettings(result.changed ? updated : current),
    };
}
