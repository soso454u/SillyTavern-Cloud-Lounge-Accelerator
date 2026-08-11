import { copyFile, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const BOOLEAN_TEXT = '(?:true|false)';

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
    let performanceIndent = -1;

    for (const line of lines) {
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const indent = line.match(/^\s*/)?.[0].length || 0;
        if (performanceIndent < 0) {
            if (indent === 0 && /^performance\s*:\s*(?:#.*)?$/.test(line)) performanceIndent = indent;
            continue;
        }
        if (indent <= performanceIndent) break;
        const match = line.match(new RegExp(`^\\s+lazyLoadCharacters\\s*:\\s*(${BOOLEAN_TEXT})\\b`));
        if (match) {
            lazyCharacters = match[1] === 'true';
            break;
        }
    }

    return {
        keepAlive: keepAlive ? keepAlive[1] === 'true' : null,
        lazyCharacters,
    };
}

function replaceBooleanLine(line, key, enabled) {
    const match = line.match(new RegExp(`^(\\s*${key}\\s*:)\\s*[^#]*(\\s+#.*)?$`));
    if (!match) return line;
    return `${match[1]} ${enabled ? 'true' : 'false'}${match[2] || ''}`;
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
        const performanceIndex = lines.findIndex(line => /^performance\s*:\s*(?:#.*)?$/.test(line));
        if (performanceIndex < 0) {
            lines.push('', '# Managed by Cloud Lounge Accelerator', 'performance:', `  lazyLoadCharacters: ${enabled}`);
        } else {
            let blockEnd = lines.length;
            for (let index = performanceIndex + 1; index < lines.length; index += 1) {
                const line = lines[index];
                if (!line.trim() || /^\s*#/.test(line)) continue;
                if (!/^\s/.test(line)) {
                    blockEnd = index;
                    break;
                }
            }
            const lazyIndex = lines.slice(performanceIndex + 1, blockEnd)
                .findIndex(line => /^\s+lazyLoadCharacters\s*:/.test(line));
            if (lazyIndex >= 0) {
                const absoluteIndex = performanceIndex + 1 + lazyIndex;
                lines[absoluteIndex] = replaceBooleanLine(lines[absoluteIndex], 'lazyLoadCharacters', enabled);
            } else {
                lines.splice(performanceIndex + 1, 0, `  lazyLoadCharacters: ${enabled}`);
            }
        }
    } else {
        throw new TypeError('未知的性能设置');
    }

    return `${lines.join(lineEnding)}${hadFinalNewline ? lineEnding : ''}`;
}

function backupSuffix(date = new Date()) {
    return date.toISOString().replace(/[-:]/g, '').replace('.', '');
}

export async function writePerformanceSetting(configPath, setting, enabled) {
    const current = await readFile(configPath, 'utf8');
    const updated = updatePerformanceSetting(current, setting, enabled);
    if (updated === current) {
        return { changed: false, backup: null, settings: readPerformanceSettings(current) };
    }

    const fileStat = await stat(configPath);
    const backupPath = `${configPath}.backup-cloud-lounge-performance-${backupSuffix()}-${process.hrtime.bigint()}`;
    const temporaryPath = join(dirname(configPath), `.${basename(configPath)}.cloud-lounge-${process.pid}-${Date.now()}.tmp`);
    await copyFile(configPath, backupPath);
    let temporaryFile;
    try {
        temporaryFile = await open(temporaryPath, 'wx', fileStat.mode);
        await temporaryFile.writeFile(updated, 'utf8');
        await temporaryFile.sync();
        await temporaryFile.close();
        temporaryFile = null;
        await rename(temporaryPath, configPath);
    } catch (error) {
        await temporaryFile?.close().catch(() => {});
        await unlink(temporaryPath).catch(() => {});
        throw error;
    }

    return {
        changed: true,
        backup: basename(backupPath),
        settings: readPerformanceSettings(updated),
    };
}
