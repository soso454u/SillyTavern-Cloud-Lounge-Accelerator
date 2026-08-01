import { ACCELERATOR_VERSION, createServiceWorkerSource } from './worker-template.js';

const workerSource = createServiceWorkerSource();

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
    router.get('/health', (_request, response) => {
        response.set({
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        response.json({
            ok: true,
            id: info.id,
            version: ACCELERATOR_VERSION,
            workerPath: `/api/plugins/${info.id}/service-worker.js`,
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
