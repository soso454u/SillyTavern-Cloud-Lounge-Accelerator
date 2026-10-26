import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const SIGNATURE_FILES = Object.freeze([
    'public/script.js',
    'public/style.css',
    'public/lib.js',
]);

function parseBoolean(value) {
    if (value === true || String(value).toLowerCase() === 'true') return true;
    if (value === false || String(value).toLowerCase() === 'false') return false;
    return null;
}

export function resolveBasicAuthMode(content, { argv = process.argv, env = process.env } = {}) {
    const match = String(content || '').match(/^basicAuthMode\s*:\s*(true|false)\b/m);
    let value = match ? match[1] === 'true' : null;

    const environmentValue = parseBoolean(env.SILLYTAVERN_BASICAUTHMODE);
    if (environmentValue !== null) value = environmentValue;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--no-basicAuthMode') value = false;
        else if (argument === '--basicAuthMode') {
            const explicitValue = parseBoolean(argv[index + 1]);
            value = explicitValue ?? true;
        } else if (argument?.startsWith('--basicAuthMode=')) {
            const explicitValue = parseBoolean(argument.slice(argument.indexOf('=') + 1));
            if (explicitValue !== null) value = explicitValue;
        }
    }
    return value;
}

export async function readRuntimeInfo({ configPath, version, rootPath = process.cwd() }) {
    let basicAuthMode = null;
    try {
        const content = await readFile(configPath, 'utf8');
        basicAuthMode = resolveBasicAuthMode(content);
    } catch {
        // Runtime information is advisory and must never break the health route.
    }

    const fileSignatures = await Promise.all(SIGNATURE_FILES.map(async file => {
        try {
            const metadata = await stat(join(rootPath, file));
            return `${file}:${metadata.size}:${Math.trunc(metadata.mtimeMs)}`;
        } catch {
            return `${file}:missing`;
        }
    }));

    return {
        basicAuthMode,
        appSignature: `${version}:${fileSignatures.join('|')}`,
    };
}
