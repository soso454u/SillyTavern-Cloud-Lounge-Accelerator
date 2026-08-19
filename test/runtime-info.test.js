import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readRuntimeInfo, resolveBasicAuthMode } from '../server/runtime-info.js';

test('reads Basic Auth and respects environment and command-line overrides', () => {
    const content = 'basicAuthMode: false\n';
    assert.equal(resolveBasicAuthMode(content, { argv: [], env: {} }), false);
    assert.equal(resolveBasicAuthMode(content, { argv: [], env: { SILLYTAVERN_BASICAUTHMODE: 'true' } }), true);
    assert.equal(resolveBasicAuthMode(content, { argv: ['node', 'server.js', '--basicAuthMode'], env: {} }), true);
    assert.equal(resolveBasicAuthMode('basicAuthMode: true\n', { argv: ['node', 'server.js', '--no-basicAuthMode'], env: {} }), false);
});

test('builds an app signature from core SillyTavern files without exposing credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cloud-lounge-runtime-'));
    try {
        await mkdir(join(directory, 'public'));
        await writeFile(join(directory, 'config.yaml'), 'basicAuthMode: true\nbasicAuthUser:\n  password: secret-value\n', 'utf8');
        await writeFile(join(directory, 'public', 'script.js'), 'script', 'utf8');
        await writeFile(join(directory, 'public', 'style.css'), 'style', 'utf8');
        await writeFile(join(directory, 'public', 'lib.js'), 'lib', 'utf8');

        const runtime = await readRuntimeInfo({
            configPath: join(directory, 'config.yaml'),
            rootPath: directory,
            version: '2.1.13',
        });
        assert.equal(runtime.basicAuthMode, true);
        assert.match(runtime.appSignature, /^2\.1\.13:public\/script\.js:/);
        assert.doesNotMatch(JSON.stringify(runtime), /secret-value/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
