import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readPerformanceSettings, updatePerformanceSetting, writePerformanceSetting } from '../server/performance-config.js';

const SAMPLE = `listen: true
enableKeepAlive: false # network compatibility

performance:
  lazyLoadCharacters: false # extension compatibility
  memoryCacheCapacity: '100mb'

extensions:
  enabled: true
`;

test('reads only the intended top-level and performance settings', () => {
    assert.deepEqual(readPerformanceSettings(SAMPLE), {
        keepAlive: false,
        lazyCharacters: false,
    });
    assert.deepEqual(readPerformanceSettings('performance: false\nenableKeepAlive: true\n'), {
        keepAlive: true,
        lazyCharacters: null,
    });
});

test('updates independent booleans while preserving comments and surrounding config', () => {
    const keepAlive = updatePerformanceSetting(SAMPLE, 'keepAlive', true);
    assert.match(keepAlive, /^enableKeepAlive: true # network compatibility$/m);
    assert.match(keepAlive, /^  lazyLoadCharacters: false # extension compatibility$/m);

    const lazyCharacters = updatePerformanceSetting(keepAlive, 'lazyCharacters', true);
    assert.match(lazyCharacters, /^  lazyLoadCharacters: true # extension compatibility$/m);
    assert.match(lazyCharacters, /^  memoryCacheCapacity: '100mb'$/m);
    assert.match(lazyCharacters, /^extensions:$/m);
});

test('adds missing settings without creating a duplicate performance section', () => {
    const withPerformance = updatePerformanceSetting('performance:\n  useDiskCache: true\n', 'lazyCharacters', true);
    assert.equal(withPerformance.match(/^performance:/gm)?.length, 1);
    assert.match(withPerformance, /^  lazyLoadCharacters: true$/m);

    const withoutPerformance = updatePerformanceSetting('listen: true\n', 'lazyCharacters', true);
    assert.equal(withoutPerformance.match(/^performance:/gm)?.length, 1);
    assert.match(withoutPerformance, /^  lazyLoadCharacters: true$/m);

    const keepAlive = updatePerformanceSetting('listen: true\n', 'keepAlive', true);
    assert.match(keepAlive, /^enableKeepAlive: true$/m);
});

test('rejects unknown performance setting names', () => {
    assert.throws(() => updatePerformanceSetting(SAMPLE, 'everything', true), /未知的性能设置/);
});

test('uses the shared bounded backup policy and skips no-op writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cloud-lounge-performance-'));
    const configPath = join(directory, 'config.yaml');
    try {
        await writeFile(configPath, SAMPLE, 'utf8');
        const changed = await writePerformanceSetting(configPath, 'keepAlive', true);
        assert.equal(changed.changed, true);
        assert.equal(changed.backup, '.cloud-lounge-accelerator/backups/config.original.yaml');
        assert.equal(await readFile(join(directory, changed.backup), 'utf8'), SAMPLE);
        assert.match(await readFile(configPath, 'utf8'), /^enableKeepAlive: true/m);

        const unchanged = await writePerformanceSetting(configPath, 'keepAlive', true);
        assert.equal(unchanged.changed, false);
        assert.equal(unchanged.backup, null);
        assert.equal((await readdir(directory)).filter(name => name.includes('.backup-')).length, 0);
        assert.deepEqual(await readdir(join(directory, '.cloud-lounge-accelerator', 'backups')), ['config.original.yaml']);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
