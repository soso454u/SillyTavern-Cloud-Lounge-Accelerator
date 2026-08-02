export const ACCELERATOR_VERSION = '2.0.5';
export const CACHE_PREFIX = 'cloud-lounge-static-v2-';
export const LEGACY_CACHE_PREFIX = 'cloud-lounge-static-';

export const STATIC_EXACT_PATHS = Object.freeze([
    '/script.js',
    '/style.css',
    '/lib.js',
    '/favicon.ico',
    '/manifest.json',
]);

export const STATIC_PATH_PREFIXES = Object.freeze([
    '/css/',
    '/img/',
    '/lib/',
    '/locales/',
    '/scripts/',
    '/sounds/',
    '/webfonts/',
]);

export const PRIVATE_PATH_PREFIXES = Object.freeze([
    '/api/',
    '/backgrounds/',
    '/characters/',
    '/thumbnail',
    '/user/',
]);

export function isSafeStaticPath(pathname) {
    if (typeof pathname !== 'string' || !pathname.startsWith('/')) return false;
    if (pathname === '/css/user.css') return false;
    if (pathname.startsWith('/scripts/extensions/third-party/')) return false;
    if (PRIVATE_PATH_PREFIXES.some(prefix => pathname.startsWith(prefix))) return false;
    return STATIC_EXACT_PATHS.includes(pathname)
        || STATIC_PATH_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

export function isCacheableResponseMetadata({ status, type = 'basic', headers = {}, redirected = false } = {}) {
    const normalized = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    return status === 200
        && ['basic', 'default'].includes(type)
        && redirected !== true
        && !normalized.has('www-authenticate')
        && !normalized.has('proxy-authenticate');
}

export function createServiceWorkerSource() {
    return `/* Cloud Lounge Accelerator ${ACCELERATOR_VERSION} */
'use strict';

const VERSION = ${JSON.stringify(ACCELERATOR_VERSION)};
const CACHE_PREFIX = ${JSON.stringify(CACHE_PREFIX)};
const LEGACY_CACHE_PREFIX = ${JSON.stringify(LEGACY_CACHE_PREFIX)};
const CACHE_NAME = CACHE_PREFIX + VERSION;
const METADATA_CACHE = CACHE_PREFIX + 'metadata';
const VERSION_SIGNATURE_KEY = '/.cloud-lounge-version-signature';
const MAX_ENTRIES = 700;
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const STATIC_EXACT_PATHS = ${JSON.stringify(STATIC_EXACT_PATHS)};
const STATIC_PATH_PREFIXES = ${JSON.stringify(STATIC_PATH_PREFIXES)};
const PRIVATE_PATH_PREFIXES = ${JSON.stringify(PRIVATE_PATH_PREFIXES)};
let runtimeHits = 0;
let runtimeMisses = 0;
let runtimeWrites = 0;
let writesSinceTrim = 0;

${isSafeStaticPath.toString()}

function isEligibleRequest(request) {
    if (!request || request.method !== 'GET') return false;
    if (request.cache === 'no-store' || request.headers.has('range')) return false;
    const url = new URL(request.url);
    return url.origin === self.location.origin && isSafeStaticPath(url.pathname);
}

function isCacheableResponse(response) {
    return response.status === 200
        && response.type === 'basic'
        && !response.redirected
        && !response.headers.has('www-authenticate')
        && !response.headers.has('proxy-authenticate');
}

async function trimCache(cache) {
    const keys = await cache.keys();
    const overflow = keys.length - MAX_ENTRIES;
    if (overflow > 0) await Promise.all(keys.slice(0, overflow).map(key => cache.delete(key)));
}

async function fetchAndCache(request, cacheMode = 'no-cache') {
    const networkRequest = new Request(request, { cache: cacheMode, credentials: 'same-origin' });
    const response = await fetch(networkRequest);
    const contentLength = Number(response.headers.get('content-length') || 0);
    const withinSizeLimit = !Number.isFinite(contentLength) || contentLength <= 0 || contentLength <= MAX_RESOURCE_BYTES;
    if (isCacheableResponse(response) && withinSizeLimit) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
        runtimeWrites += 1;
        writesSinceTrim += 1;
        if (writesSinceTrim >= 50) {
            writesSinceTrim = 0;
            await trimCache(cache);
        }
    }
    return response;
}

async function cacheFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) {
        runtimeHits += 1;
        return cached;
    }
    runtimeMisses += 1;
    return fetchAndCache(request);
}

async function handlePotentialStaticRequest(event) {
    if (!isEligibleRequest(event.request)) return fetch(event.request);
    return cacheFirst(event.request);
}

function isExtensionMutation(request) {
    if (!request || request.method === 'GET') return false;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return false;
    return ['/api/extensions/install', '/api/extensions/update', '/api/extensions/delete', '/api/extensions/move', '/api/extensions/switch'].includes(url.pathname);
}

async function clearResourceCaches() {
    const names = await caches.keys();
    const ownNames = names.filter(name => (
        name.startsWith(CACHE_PREFIX) || name.startsWith(LEGACY_CACHE_PREFIX)
    ) && name !== METADATA_CACHE);
    const results = await Promise.all(ownNames.map(name => caches.delete(name)));
    return results.filter(Boolean).length;
}

async function forwardMutation(request) {
    const response = await fetch(new Request(request, { credentials: 'same-origin' }));
    if (response.status === 200 && !response.headers.has('www-authenticate') && !response.headers.has('proxy-authenticate')) {
        await clearResourceCaches();
    }
    return response;
}

async function warmUrls(urls) {
    const unique = [...new Set(Array.isArray(urls) ? urls : [])].slice(0, MAX_ENTRIES);
    const queue = unique.filter(rawUrl => {
        try {
            return isEligibleRequest(new Request(new URL(rawUrl, self.location.origin), { credentials: 'same-origin' }));
        } catch {
            return false;
        }
    });
    let warmed = 0;
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length) {
            const rawUrl = queue.shift();
            try {
                const request = new Request(new URL(rawUrl, self.location.origin), { credentials: 'same-origin' });
                const cache = await caches.open(CACHE_NAME);
                if (await cache.match(request)) continue;
                await fetchAndCache(request, 'force-cache');
                if (await cache.match(request)) warmed += 1;
            } catch {
                // Optional warm-up failures never block the remaining queue.
            }
        }
    });
    await Promise.all(workers);
    await trimCache(await caches.open(CACHE_NAME));
    return warmed;
}

async function acceptVersionSignature(signature) {
    if (typeof signature !== 'string' || !signature.trim()) return false;
    const metadata = await caches.open(METADATA_CACHE);
    const key = new Request(new URL(VERSION_SIGNATURE_KEY, self.location.origin));
    const stored = await metadata.match(key);
    const previous = stored ? await stored.text() : '';
    if (previous && previous !== signature) await clearResourceCaches();
    if (previous !== signature) await metadata.put(key, new Response(signature));
    return previous !== signature;
}

async function getStats() {
    const cache = await caches.open(CACHE_NAME);
    return {
        version: VERSION,
        entries: (await cache.keys()).length,
        hits: runtimeHits,
        misses: runtimeMisses,
        writes: runtimeWrites,
    };
}

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(name => (
            name.startsWith(LEGACY_CACHE_PREFIX) || name.startsWith(CACHE_PREFIX)
        ) && name !== CACHE_NAME && name !== METADATA_CACHE).map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    if (event.request.mode === 'navigate') return;
    if (isExtensionMutation(event.request)) {
        event.respondWith(forwardMutation(event.request));
        return;
    }
    if (!isEligibleRequest(event.request)) return;
    event.respondWith(handlePotentialStaticRequest(event));
});

self.addEventListener('message', event => {
    const data = event.data || {};
    const reply = payload => event.ports?.[0]?.postMessage(payload);
    const run = promise => event.waitUntil(promise.then(payload => reply({ ok: true, ...payload })).catch(error => reply({ ok: false, error: String(error) })));
    if (data.type === 'WARM') run(warmUrls(data.urls).then(warmed => ({ warmed })));
    else if (data.type === 'STATS') run(getStats());
    else if (data.type === 'CLEAR') run(clearResourceCaches().then(cleared => ({ cleared })));
    else if (data.type === 'VERSION_SIGNATURE') run(acceptVersionSignature(data.signature).then(changed => ({ changed })));
});
`;
}
