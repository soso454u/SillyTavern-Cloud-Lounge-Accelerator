import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    CONFIG_BACKUP_POLICY,
    migrateLegacyConfigBackups,
    writeConfigWithBackup,
} from '../server/config-backup.js';

async function backupNames(directory) {
    const backupDirectory = join(directory, '.cloud-lounge-accelerator', 'backups');
    return readdir(backupDirectory).catch(() => []);
}

test('keeps one permanent baseline and only three rolling snapshots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cloud-lounge-backups-'));
    const configPath = join(directory, 'config.yaml');
    try {
        await writeFile(configPath, 'value: A\n', 'utf8');
        if (process.platform !== 'win32') await chmod(configPath, 0o600);
        const values = ['B', 'C', 'D', 'E', 'F'];
        for (let index = 0; index < values.length; index += 1) {
            await writeConfigWithBackup({
                configPath,
                updatedContent: `value: ${values[index]}\n`,
                date: new Date(2026, 7, 12, 4, 35, index, 0),
                validate: content => content === `value: ${values[index]}\n`,
            });
        }

        const names = await backupNames(directory);
        assert.equal(names.includes('config.original.yaml'), true);
        assert.equal(names.filter(name => /^config\.\d/.test(name)).length, 3);
        assert.equal(await readFile(join(directory, CONFIG_BACKUP_POLICY.directory, 'config.original.yaml'), 'utf8'), 'value: A\n');
        if (process.platform !== 'win32') {
            const originalMode = (await stat(join(directory, CONFIG_BACKUP_POLICY.directory, 'config.original.yaml'))).mode & 0o777;
            assert.equal(originalMode, 0o600);
        }
        assert.equal(await readFile(configPath, 'utf8'), 'value: F\n');

        const before = [...names].sort();
        const unchanged = await writeConfigWithBackup({ configPath, updatedContent: 'value: F\n' });
        assert.equal(unchanged.changed, false);
        assert.equal(unchanged.backup, null);
        assert.deepEqual((await backupNames(directory)).sort(), before);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('migrates only accelerator legacy backups and deduplicates their contents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cloud-lounge-legacy-'));
    const configPath = join(directory, 'config.yaml');
    try {
        await writeFile(configPath, 'current\n', 'utf8');
        await writeFile(`${configPath}.backup-cloud-lounge-20260810-010000`, 'original\n', 'utf8');
        await writeFile(`${configPath}.backup-cloud-lounge-20260811-010000`, 'middle\n', 'utf8');
        await writeFile(`${configPath}.backup-cloud-lounge-20260811-020000`, 'middle\n', 'utf8');
        await writeFile(`${configPath}.backup-cloud-lounge-performance-20260812T010000000Z-1`, 'latest\n', 'utf8');
        await writeFile(`${configPath}.backup-user-created`, 'leave me\n', 'utf8');

        const result = await migrateLegacyConfigBackups(configPath);
        assert.equal(result.migrated, 4);
        const rootNames = await readdir(directory);
        assert.equal(rootNames.includes('config.yaml.backup-user-created'), true);
        assert.equal(rootNames.some(name => name.startsWith('config.yaml.backup-cloud-lounge-')), false);

        const names = await backupNames(directory);
        assert.equal(names.includes('config.original.yaml'), true);
        assert.equal(names.filter(name => /^config\.\d/.test(name)).length, 2);
        assert.equal(await readFile(join(directory, CONFIG_BACKUP_POLICY.directory, 'config.original.yaml'), 'utf8'), 'original\n');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('automatically restores config when post-write validation fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cloud-lounge-rollback-'));
    const configPath = join(directory, 'config.yaml');
    try {
        await writeFile(configPath, 'safe: true\n', 'utf8');
        await assert.rejects(writeConfigWithBackup({
            configPath,
            updatedContent: 'safe: false\n',
            validate: () => false,
        }), /已自动恢复修改前配置/);
        assert.equal(await readFile(configPath, 'utf8'), 'safe: true\n');
        assert.equal(await readFile(join(directory, CONFIG_BACKUP_POLICY.directory, 'config.original.yaml'), 'utf8'), 'safe: true\n');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
