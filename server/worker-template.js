export const ACCELERATOR_VERSION = '1.3.0';
export const CACHE_PREFIX = 'cloud-lounge-static-';

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

/**
 * Only immutable-ish application resources are allowed into Cache Storage.
 * User data and all API paths are deliberately excluded.
 * @param {string} pathname URL pathname
 * @returns {boolean}
 */
export function isSafeStaticPath(pathname, { allowThirdParty = false } = {}) {
    if (typeof pathname !== 'string' || !pathname.startsWith('/')) return false;
    if (pathname === '/css/user.css') return false;
    if (!allowThirdParty && pathname.startsWith('/scripts/extensions/third-party/')) return false;
    if (PRIVATE_PATH_PREFIXES.some(prefix => pathname.startsWith(prefix))) return false;
    return STATIC_EXACT_PATHS.includes(pathname)
        || STATIC_PATH_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

/**
 * Build a standalone worker because the plugin endpoint is the worker's only
 * server-side dependency. Keeping the policy embedded also avoids extra RTTs.
 * @returns {string}
 */
export function createServiceWorkerSource() {
    const policyFunction = isSafeStaticPath.toString();
    return `/* Cloud Lounge Accelerator ${ACCELERATOR_VERSION} */
'use strict';

const VERSION = ${JSON.stringify(ACCELERATOR_VERSION)};
const CACHE_PREFIX = ${JSON.stringify(CACHE_PREFIX)};
const CACHE_NAME = CACHE_PREFIX + VERSION;
const METADATA_CACHE = CACHE_PREFIX + 'metadata';
const NAVIGATION_SIGNATURE_KEY = '/.cloud-lounge-navigation-signature';
const CONFIG_KEY = '/.cloud-lounge-config';
const MAX_ENTRIES = 700;
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const STATIC_EXACT_PATHS = ${JSON.stringify(STATIC_EXACT_PATHS)};
const STATIC_PATH_PREFIXES = ${JSON.stringify(STATIC_PATH_PREFIXES)};
const PRIVATE_PATH_PREFIXES = ${JSON.stringify(PRIVATE_PATH_PREFIXES)};
let runtimeHits = 0;
let runtimeMisses = 0;
let runtimeWrites = 0;
let writesSinceTrim = 0;
let allowThirdPartyAssets = false;

${policyFunction}

const configReady = (async () => {
    try {
        const metadata = await caches.open(METADATA_CACHE);
        const stored = await metadata.match(new Request(new URL(CONFIG_KEY, self.location.origin)));
        if (stored) {
            const config = await stored.json();
            allowThirdPartyAssets = config.allowThirdPartyAssets === true;
        }
    } catch {
        allowThirdPartyAssets = false;
    }
})();

function isEligibleRequest(request, { allowThirdParty = allowThirdPartyAssets } = {}) {
    if (!request || request.method !== 'GET') return false;
    if (request.cache === 'no-store' || request.headers.has('range')) return false;
    const url = new URL(request.url);
    return url.origin === self.location.origin && isSafeStaticPath(url.pathname, { allowThirdParty });
}

async function trimCache(cache) {
    const keys = await cache.keys();
    const overflow = keys.length - MAX_ENTRIES;
    if (overflow > 0) {
        await Promise.all(keys.slice(0, overflow).map(key => cache.delete(key)));
    }
}

async function fetchAndCache(request, cacheMode = 'no-cache') {
    const networkRequest = new Request(request, { cache: cacheMode });
    const response = await fetch(networkRequest);
    const contentLength = Number(response.headers.get('content-length') || 0);
    const withinSizeLimit = !Number.isFinite(contentLength) || contentLength <= 0 || contentLength <= MAX_RESOURCE_BYTES;
    if (response.ok && response.type === 'basic' && withinSizeLimit) {
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
    await configReady;
    if (!isEligibleRequest(event.request)) return fetch(event.request);
    return cacheFirst(event.request);
}

async function handleNavigation(request) {
    const response = await fetch(request);
    const url = new URL(request.url);
    if (!response.ok || url.pathname !== '/' || response.redirected) return response;

    const signature = response.headers.get('etag') || response.headers.get('last-modified');
    if (!signature) return response;

    const metadata = await caches.open(METADATA_CACHE);
    const signatureRequest = new Request(new URL(NAVIGATION_SIGNATURE_KEY, self.location.origin));
    const previous = await metadata.match(signatureRequest);
    const previousSignature = previous ? await previous.text() : '';
    if (previousSignature === signature) return response;
    if (previousSignature && previousSignature !== signature) {
        await caches.delete(CACHE_NAME);
    }
    await metadata.put(signatureRequest, new Response(signature));
    return response;
}

function isExtensionMutation(request) {
    if (!request || request.method === 'GET') return false;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return false;
    return [
        '/api/extensions/install',
        '/api/extensions/update',
        '/api/extensions/delete',
        '/api/extensions/move',
        '/api/extensions/switch',
    ].includes(url.pathname);
}

async function forwardMutation(request) {
    const response = await fetch(request);
    if (response.ok) await caches.delete(CACHE_NAME);
    return response;
}

async function warmUrls(urls) {
    const unique = [...new Set(Array.isArray(urls) ? urls : [])].slice(0, MAX_ENTRIES);
    let warmed = 0;
    const queue = unique.filter(rawUrl => {
        try {
            return isEligibleRequest(new Request(new URL(rawUrl, self.location.origin)));
        } catch {
            return false;
        }
    });

    // Keep warm-up deliberately below normal browser connection concurrency so
    // it cannot compete with SillyTavern's visible UI, fonts and chat render.
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length) {
            const rawUrl = queue.shift();
            try {
                const request = new Request(new URL(rawUrl, self.location.origin), { credentials: 'same-origin' });
                const cache = await caches.open(CACHE_NAME);
                if (await cache.match(request)) continue;
                // These URLs were loaded by the current page already. Reuse the
                // browser HTTP cache instead of downloading all of them again.
                await fetchAndCache(request, 'force-cache');
                warmed += 1;
            } catch {
                // A failed optional asset must not abort the remaining warm-up.
            }
        }
    });
    await Promise.all(workers);
    await trimCache(await caches.open(CACHE_NAME));
    return warmed;
}

async function getStats() {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    return {
        version: VERSION,
        entries: keys.length,
        hits: runtimeHits,
        misses: runtimeMisses,
        writes: runtimeWrites,
        allowThirdPartyAssets,
    };
}

async function saveConfig(allowThirdParty) {
    allowThirdPartyAssets = allowThirdParty === true;
    const metadata = await caches.open(METADATA_CACHE);
    const configRequest = new Request(new URL(CONFIG_KEY, self.location.origin));
    await metadata.put(configRequest, new Response(JSON.stringify({ allowThirdPartyAssets }), {
        headers: { 'Content-Type': 'application/json' },
    }));

    if (!allowThirdPartyAssets) {
        const cache = await caches.open(CACHE_NAME);
        const keys = await cache.keys();
        await Promise.all(keys
            .filter(key => new URL(key.url).pathname.startsWith('/scripts/extensions/third-party/'))
            .map(key => cache.delete(key)));
    }
    return allowThirdPartyAssets;
}

async function clearAcceleratorResourceCaches() {
    const names = await caches.keys();
    const ownNames = names.filter(name => name.startsWith(CACHE_PREFIX) && name !== METADATA_CACHE);
    const results = await Promise.all(ownNames.map(name => caches.delete(name)));
    return results.filter(Boolean).length;
}

self.addEventListener('install', event => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
            .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME && name !== METADATA_CACHE)
            .map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    if (event.request.mode === 'navigate') {
        event.respondWith(handleNavigation(event.request));
        return;
    }
    if (isExtensionMutation(event.request)) {
        event.respondWith(forwardMutation(event.request));
        return;
    }
    if (!isEligibleRequest(event.request, { allowThirdParty: true })) return;
    event.respondWith(handlePotentialStaticRequest(event));
});

self.addEventListener('message', event => {
    const data = event.data || {};
    const reply = payload => event.ports?.[0]?.postMessage(payload);
    if (data.type === 'WARM') {
        event.waitUntil(warmUrls(data.urls).then(warmed => reply({ ok: true, warmed })).catch(error => reply({ ok: false, error: String(error) })));
    } else if (data.type === 'STATS') {
        event.waitUntil(getStats().then(stats => reply({ ok: true, ...stats })).catch(error => reply({ ok: false, error: String(error) })));
    } else if (data.type === 'CLEAR') {
        event.waitUntil(clearAcceleratorResourceCaches().then(cleared => reply({ ok: true, cleared })).catch(error => reply({ ok: false, error: String(error) })));
    } else if (data.type === 'CONFIG') {
        event.waitUntil(saveConfig(data.allowThirdParty).then(allowThirdParty => reply({ ok: true, allowThirdParty })).catch(error => reply({ ok: false, error: String(error) })));
    }
});
`;
}
