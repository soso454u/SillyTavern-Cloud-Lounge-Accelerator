import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const BACKUP_ROOT = '.cloud-lounge-accelerator';
const BACKUP_FOLDER = 'backups';
const ORIGINAL_NAME = 'config.original.yaml';
const SNAPSHOT_PATTERN = /^config\.\d{8}-\d{6}-\d{3}(?:-\d+)?\.yaml$/;
const MAX_SNAPSHOTS = 3;

function timestamp(date = new Date()) {
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
        + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
        + `-${pad(date.getMilliseconds(), 3)}`;
}

function legacySortKey(name) {
    const match = name.match(/(\d{8})[T-]?(\d{6})-?(\d{3})?/);
    return match ? `${match[1]}${match[2]}${match[3] || '000'}:${name}` : `00000000000000000:${name}`;
}

async function pathExists(path) {
    return stat(path).then(() => true).catch(() => false);
}

async function readIfPresent(path) {
    return readFile(path, 'utf8').catch(() => null);
}

async function uniqueSnapshotPath(backupDirectory, date = new Date()) {
    const stem = `config.${timestamp(date)}`;
    for (let counter = 0; ; counter += 1) {
        const suffix = counter === 0 ? '' : `-${counter}`;
        const candidate = join(backupDirectory, `${stem}${suffix}.yaml`);
        if (!await pathExists(candidate)) return candidate;
    }
}

async function listSnapshots(backupDirectory) {
    const entries = await readdir(backupDirectory, { withFileTypes: true }).catch(() => []);
    return entries
        .filter(entry => entry.isFile() && SNAPSHOT_PATTERN.test(entry.name))
        .map(entry => join(backupDirectory, entry.name))
        .sort((left, right) => basename(right).localeCompare(basename(left)));
}

async function pruneSnapshots(backupDirectory) {
    const snapshots = await listSnapshots(backupDirectory);
    const seen = new Set();
    const remove = [];
    let kept = 0;
    for (const path of snapshots) {
        const content = await readIfPresent(path);
        if (content === null || seen.has(content) || kept >= MAX_SNAPSHOTS) remove.push(path);
        else {
            seen.add(content);
            kept += 1;
        }
    }
    await Promise.all(remove.map(path => unlink(path).catch(() => {})));
    return remove.length;
}

async function copyExclusive(source, destination) {
    const metadata = await stat(source);
    let copied = false;
    try {
        await copyFile(source, destination, constants.COPYFILE_EXCL);
        copied = true;
        await chmod(destination, metadata.mode & 0o777);
        return destination;
    } catch (error) {
        if (copied) await unlink(destination).catch(() => {});
        throw error;
    }
}

/**
 * Move backups created by older accelerator versions out of the SillyTavern root.
 * Only the accelerator's exact legacy prefix is considered.
 */
export async function migrateLegacyConfigBackups(configPath) {
    const rootDirectory = dirname(configPath);
    const backupDirectory = join(rootDirectory, BACKUP_ROOT, BACKUP_FOLDER);
    const originalPath = join(backupDirectory, ORIGINAL_NAME);
    const legacyPrefix = `${basename(configPath)}.backup-cloud-lounge-`;
    const entries = await readdir(rootDirectory, { withFileTypes: true });
    const legacy = entries
        .filter(entry => entry.isFile() && entry.name.startsWith(legacyPrefix))
        .map(entry => ({
            name: entry.name,
            path: join(rootDirectory, entry.name),
            key: legacySortKey(entry.name),
        }))
        .sort((left, right) => left.key.localeCompare(right.key));

    if (legacy.length === 0) {
        const pruned = await pruneSnapshots(backupDirectory);
        return { migrated: 0, pruned, backupDirectory, originalPath };
    }

    await mkdir(backupDirectory, { recursive: true });
    if (!await pathExists(originalPath)) await copyExclusive(legacy[0].path, originalPath);

    const originalContent = await readFile(originalPath, 'utf8');
    const selected = [];
    const seen = new Set([originalContent]);
    for (const item of [...legacy].reverse()) {
        const content = await readIfPresent(item.path);
        if (content === null || seen.has(content)) continue;
        seen.add(content);
        selected.push(item);
        if (selected.length === MAX_SNAPSHOTS) break;
    }

    for (const item of selected.reverse()) {
        const match = item.name.match(/(\d{8})[T-]?(\d{6})-?(\d{3})?/);
        const legacyDate = match
            ? new Date(
                Number(match[1].slice(0, 4)),
                Number(match[1].slice(4, 6)) - 1,
                Number(match[1].slice(6, 8)),
                Number(match[2].slice(0, 2)),
                Number(match[2].slice(2, 4)),
                Number(match[2].slice(4, 6)),
                Number(match[3] || 0),
            )
            : new Date();
        const destination = await uniqueSnapshotPath(backupDirectory, legacyDate);
        await copyExclusive(item.path, destination);
    }

    // Delete only after every selected legacy backup has been safely copied.
    await Promise.all(legacy.map(item => unlink(item.path)));
    const pruned = await pruneSnapshots(backupDirectory);
    return { migrated: legacy.length, pruned, backupDirectory, originalPath };
}

async function findMatchingBackup(backupDirectory, originalPath, content) {
    if (await readIfPresent(originalPath) === content) return originalPath;
    for (const path of await listSnapshots(backupDirectory)) {
        if (await readIfPresent(path) === content) return path;
    }
    return null;
}

async function prepareRollback(configPath, currentContent, date = new Date()) {
    const migration = await migrateLegacyConfigBackups(configPath);
    const { backupDirectory, originalPath } = migration;
    await mkdir(backupDirectory, { recursive: true });

    let baselineCreated = false;
    if (!await pathExists(originalPath)) {
        await copyExclusive(configPath, originalPath);
        baselineCreated = true;
    }

    let rollbackPath = await findMatchingBackup(backupDirectory, originalPath, currentContent);
    let snapshotCreated = false;
    if (!rollbackPath) {
        rollbackPath = await uniqueSnapshotPath(backupDirectory, date);
        await copyExclusive(configPath, rollbackPath);
        snapshotCreated = true;
    }

    const pruned = migration.pruned + await pruneSnapshots(backupDirectory);
    return { ...migration, pruned, baselineCreated, snapshotCreated, rollbackPath };
}

async function atomicWrite(path, content, mode) {
    const temporaryPath = join(dirname(path), `.${basename(path)}.cloud-lounge-${process.pid}-${Date.now()}.tmp`);
    let handle;
    try {
        handle = await open(temporaryPath, 'wx', mode);
        await handle.writeFile(content, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        if (process.platform === 'win32') {
            await copyFile(temporaryPath, path);
            await unlink(temporaryPath);
        } else {
            await rename(temporaryPath, path);
        }
    } catch (error) {
        await handle?.close().catch(() => {});
        await unlink(temporaryPath).catch(() => {});
        throw error;
    }
}

/** Write config only when it changes, keeping a permanent baseline and three snapshots. */
export async function writeConfigWithBackup({
    configPath,
    updatedContent,
    validate = () => true,
    date = new Date(),
}) {
    const currentContent = await readFile(configPath, 'utf8');
    if (updatedContent === currentContent) {
        const migration = await migrateLegacyConfigBackups(configPath);
        return { changed: false, backup: null, ...migration };
    }

    const metadata = await stat(configPath);
    const prepared = await prepareRollback(configPath, currentContent, date);
    try {
        await atomicWrite(configPath, updatedContent, metadata.mode);
        const written = await readFile(configPath, 'utf8');
        if (!validate(written)) throw new Error('config.yaml 写入验证失败');
    } catch (error) {
        let restored = false;
        try {
            await atomicWrite(configPath, currentContent, metadata.mode);
            restored = await readFile(configPath, 'utf8') === currentContent;
        } catch {
            restored = false;
        }
        const suffix = restored ? '，已自动恢复修改前配置' : '，自动恢复失败，请使用保留的快照';
        throw new Error(`${error.message}${suffix}`, { cause: error });
    }

    return {
        changed: true,
        backup: prepared.rollbackPath.slice(dirname(configPath).length + 1),
        ...prepared,
    };
}

export const CONFIG_BACKUP_POLICY = Object.freeze({
    directory: `${BACKUP_ROOT}/${BACKUP_FOLDER}`,
    original: ORIGINAL_NAME,
    maxSnapshots: MAX_SNAPSHOTS,
});
