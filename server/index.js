import { ACCELERATOR_VERSION, createServiceWorkerSource } from './worker-template.js';
import { readPerformanceSettings, resolveConfigPath, writePerformanceSetting } from './performance-config.js';
import { readRuntimeInfo } from './runtime-info.js';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';

const workerSource = createServiceWorkerSource();
const configPath = resolveConfigPath();
let configWriteQueue = Promise.resolve();

function noStore(response) {
    response.set({
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
}

async function readPerformanceResponse() {
    const content = await readFile(configPath, 'utf8');
    const writable = await access(configPath, constants.W_OK).then(() => true).catch(() => false);
    return {
        ok: true,
        settings: readPerformanceSettings(content),
        writable,
        restartRequired: false,
    };
}

export const info = Object.freeze({
    id: 'cloud-lounge-accelerator',
    name: '云酒馆加速器',
    description: 'Safely caches SillyTavern static startup resources for faster repeat visits.',
});

/**
 * Register the worker and probe routes under SillyTavern's official plugin router.
 * @param {import('express').Router} router
 */
export async function init(router) {
    router.get('/health', async (request, response) => {
        noStore(response);
        const runtime = await readRuntimeInfo({ configPath, version: ACCELERATOR_VERSION });
        const authorization = request.headers?.authorization || request.get?.('authorization') || '';
        response.json({
            ok: true,
            id: info.id,
            version: ACCELERATOR_VERSION,
            workerPath: `/api/plugins/${info.id}/service-worker.js`,
            basicAuthMode: runtime.basicAuthMode === true || /^Basic\s/i.test(authorization),
            appSignature: runtime.appSignature,
        });
    });

    router.get('/performance', async (_request, response) => {
        noStore(response);
        try {
            response.json(await readPerformanceResponse());
        } catch (error) {
            response.status(503).json({ ok: false, error: `无法读取 config.yaml：${error.message}` });
        }
    });

    router.post('/performance', (request, response) => {
        noStore(response);
        const { setting, enabled } = request.body || {};
        if (!['keepAlive', 'lazyCharacters'].includes(setting) || typeof enabled !== 'boolean') {
            response.status(400).json({ ok: false, error: '性能设置参数无效' });
            return;
        }

        const operation = configWriteQueue.then(() => writePerformanceSetting(configPath, setting, enabled));
        configWriteQueue = operation.catch(() => {});
        operation.then(result => {
            response.json({ ok: true, ...result, restartRequired: result.changed });
        }).catch(error => {
            response.status(500).json({ ok: false, error: `无法更新 config.yaml：${error.message}` });
        });
    });

    router.get('/service-worker.js', (_request, response) => {
        response.set({
            'Cache-Control': 'no-store, max-age=0',
            'Content-Type': 'application/javascript; charset=utf-8',
            'Service-Worker-Allowed': '/',
            'X-Content-Type-Options': 'nosniff',
        });
        response.send(workerSource);
    });
}

export async function exit() {
    return Promise.resolve();
}
