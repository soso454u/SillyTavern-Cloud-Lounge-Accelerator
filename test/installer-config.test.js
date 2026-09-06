import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildInstallerConfig, validateInstallerConfig } from '../scripts/configure.mjs';

test('installer config transform is idempotent and preserves independent settings', () => {
    const source = 'enableServerPlugins: false # server\r\nenableKeepAlive: false # network\r\nperformance:\r\n  lazyLoadCharacters: false # extensions\r\n  memoryCacheCapacity: 100mb\r\n  requestCompression:\r\n    enabled: false\r\n    minPayloadSize: 256kb\r\n    maxPayloadSize: 8mb\r\n    timeout: 4000\r\n';
    const options = { keepAlive: true, lazyCharacters: true };
    const updated = buildInstallerConfig(source, options);
    assert.match(updated, /^enableServerPlugins: true # server\r$/m);
    assert.match(updated, /^enableKeepAlive: true # network\r$/m);
    assert.match(updated, /^  lazyLoadCharacters: true # extensions\r$/m);
    assert.match(updated, /^  memoryCacheCapacity: 100mb\r$/m);
    assert.match(updated, /^    enabled: true\r$/m);
    assert.match(updated, /^    maxPayloadSize: 0\r$/m);
    assert.match(updated, /^    timeout: 15000\r$/m);
    assert.equal(validateInstallerConfig(updated, options), true);
    assert.equal(buildInstallerConfig(updated, options), updated);
});

test('already-enabled values stay byte-for-byte unchanged', () => {
    const source = "enableServerPlugins:true\nenableKeepAlive :    true # keep\nperformance:\n    lazyLoadCharacters:true # lazy\n    requestCompression:\n      enabled: true\n      minPayloadSize: '256kb'\n      maxPayloadSize: 0\n      timeout: 15000\n";
    assert.equal(buildInstallerConfig(source, { keepAlive: true, lazyCharacters: true }), source);
});

test('installer opt-out explicitly disables chat upload compression', () => {
    const source = "enableServerPlugins: true\nperformance:\n  requestCompression:\n    enabled: true\n    maxPayloadSize: 0\n";
    const updated = buildInstallerConfig(source, { chatCompression: false });
    assert.match(updated, /^    enabled: false$/m);
    assert.equal(validateInstallerConfig(updated, { chatCompression: false }), true);
});

test('both installers delegate configuration to the shared safe writer', async () => {
    const [shell, powershell] = await Promise.all([
        readFile(new URL('../scripts/install.sh', import.meta.url), 'utf8'),
        readFile(new URL('../scripts/install.ps1', import.meta.url), 'utf8'),
    ]);
    for (const source of [shell, powershell]) {
        assert.match(source, /scripts[\\/]configure\.mjs/);
        assert.doesNotMatch(source, /backup-cloud-lounge-\$Timestamp|backup-cloud-lounge-\$\{timestamp\}/);
    }
});
