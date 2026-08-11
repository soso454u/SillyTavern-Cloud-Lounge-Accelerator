import { pathToFileURL } from 'node:url';
import { writeConfigWithBackup } from '../server/config-backup.js';

function replaceTopLevelBoolean(content, key, enabled, lineEnding) {
    const value = enabled ? 'true' : 'false';
    const pattern = new RegExp(`^(${key}\\s*:)\\s*(true|false)([^#\\r\\n]*)(\\s+#.*)?$`, 'm');
    if (pattern.test(content)) {
        return content.replace(pattern, (line, prefix, current, trailing, comment = '') => (
            current === value ? line : `${prefix} ${value}${trailing}${comment}`
        ));
    }
    return `${content.trimEnd()}${lineEnding}${lineEnding}`
        + `# Enabled by Cloud Lounge Accelerator installer${lineEnding}${key}: ${value}${lineEnding}`;
}

export function buildInstallerConfig(content, { keepAlive = false, lazyCharacters = false } = {}) {
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    let updated = replaceTopLevelBoolean(content, 'enableServerPlugins', true, lineEnding);
    if (keepAlive) updated = replaceTopLevelBoolean(updated, 'enableKeepAlive', true, lineEnding);

    if (lazyCharacters) {
        const hadFinalNewline = /\r?\n$/.test(updated);
        const lines = updated.split(/\r?\n/);
        if (hadFinalNewline) lines.pop();
        const performanceIndex = lines.findIndex(line => /^performance\s*:\s*(?:#.*)?$/.test(line));
        if (performanceIndex < 0) {
            lines.push('', '# Enabled by Cloud Lounge Accelerator installer', 'performance:', '  lazyLoadCharacters: true');
        } else {
            let blockEnd = lines.length;
            for (let index = performanceIndex + 1; index < lines.length; index += 1) {
                if (!lines[index].trim() || /^\s*#/.test(lines[index])) continue;
                if (!/^\s/.test(lines[index])) {
                    blockEnd = index;
                    break;
                }
            }
            const relativeIndex = lines.slice(performanceIndex + 1, blockEnd)
                .findIndex(line => /^\s+lazyLoadCharacters\s*:/.test(line));
            if (relativeIndex >= 0) {
                const index = performanceIndex + 1 + relativeIndex;
                lines[index] = lines[index].replace(
                    /^(\s*lazyLoadCharacters\s*:)\s*(true|false)([^#\r\n]*)(\s+#.*)?$/,
                    (line, prefix, current, trailing, comment = '') => (
                        current === 'true' ? line : `${prefix} true${trailing}${comment}`
                    ),
                );
            } else {
                lines.splice(performanceIndex + 1, 0, '  lazyLoadCharacters: true');
            }
        }
        updated = `${lines.join(lineEnding)}${hadFinalNewline ? lineEnding : ''}`;
    }

    return updated;
}

export function validateInstallerConfig(content, { keepAlive = false, lazyCharacters = false } = {}) {
    if (!/^enableServerPlugins\s*:\s*true(?:\s|$)/m.test(content)) return false;
    if (keepAlive && !/^enableKeepAlive\s*:\s*true(?:\s|$)/m.test(content)) return false;
    if (lazyCharacters && !/^\s+lazyLoadCharacters\s*:\s*true(?:\s|$)/m.test(content)) return false;
    return true;
}

function parseArguments(argv) {
    const options = { configPath: '', keepAlive: false, lazyCharacters: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--config') options.configPath = argv[++index] || '';
        else if (argument === '--keep-alive') options.keepAlive = true;
        else if (argument === '--lazy-characters') options.lazyCharacters = true;
        else throw new Error(`未知配置参数：${argument}`);
    }
    if (!options.configPath) throw new Error('--config 后缺少 config.yaml 路径');
    return options;
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const { readFile } = await import('node:fs/promises');
    const current = await readFile(options.configPath, 'utf8');
    const updated = buildInstallerConfig(current, options);
    const result = await writeConfigWithBackup({
        configPath: options.configPath,
        updatedContent: updated,
        validate: content => validateInstallerConfig(content, options),
    });

    if (result.migrated > 0) {
        console.log(`[云酒馆加速器] 已整理 ${result.migrated} 个旧备份到 ${result.backupDirectory}`);
    }
    if (!result.changed) {
        console.log('[云酒馆加速器] config.yaml 已是目标状态，跳过修改和备份');
        return;
    }
    console.log(`[云酒馆加速器] 已保存修改前配置：${result.backup}`);
    console.log('[云酒馆加速器] 已开启服务端插件');
    if (options.keepAlive) {
        console.log('[云酒馆加速器] 已开启 HTTP/HTTPS Keep-Alive；若出现 ECONNRESET 或连接中断，请在设置面板关闭');
    }
    if (options.lazyCharacters) console.log('[云酒馆加速器] 已开启 performance.lazyLoadCharacters');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(`[错误] ${error.message}`);
        process.exitCode = 1;
    });
}
