import test from 'node:test';
import assert from 'node:assert/strict';

import { CLIENT_VERSION } from '../client-core.js';
import {
    CacheController,
    hasReliableNativeHttpCache,
    isIOSStandaloneEnvironment,
    serverVersionMatchesClient,
} from '../modules/cache-controller.js';

test('requires the server plugin to match the UI version exactly', () => {
    assert.equal(serverVersionMatchesClient(CLIENT_VERSION), true);
    assert.equal(serverVersionMatchesClient('1.5.0'), false);
    assert.equal(serverVersionMatchesClient('2.0.5'), false);
    assert.equal(serverVersionMatchesClient(undefined), false);
});

test('recognizes only HTTP cache policies with useful browser freshness', () => {
    assert.equal(hasReliableNativeHttpCache({ 'Cache-Control': 'private, max-age=3600' }), true);
    assert.equal(hasReliableNativeHttpCache({ 'Cache-Control': 'public, max-age=600', Age: '250' }), true);
    assert.equal(hasReliableNativeHttpCache({ 'Cache-Control': 'max-age=300', Age: '1' }), false);
    assert.equal(hasReliableNativeHttpCache({ 'Cache-Control': 'no-cache, max-age=86400' }), false);
    assert.equal(hasReliableNativeHttpCache({ 'Cache-Control': 'no-store' }), false);
    assert.equal(hasReliableNativeHttpCache({ ETag: 'abc123' }), false);
    assert.equal(hasReliableNativeHttpCache({
        Date: 'Wed, 09 Sep 2026 00:00:00 GMT',
        Expires: 'Wed, 09 Sep 2026 01:00:00 GMT',
    }), true);
});

test('probes representative CSS and JavaScript without passing through a GET worker route', async () => {
    const requests = [];
    const controller = new CacheController({
        fetchImpl: async (url, init) => {
            requests.push({ url, init });
            return {
                ok: true,
                headers: new Headers({ 'Cache-Control': 'private, max-age=3600' }),
            };
        },
    });

    assert.equal(await controller.probeNativeHttpCache(), true);
    assert.deepEqual(requests.map(request => request.url), ['/style.css', '/script.js']);
    assert.equal(requests.every(request => request.init.method === 'HEAD'), true);
    assert.equal(requests.every(request => request.init.cache === 'no-store'), true);
});

test('keeps worker caching unless every representative asset has a fresh native policy', async () => {
    const controller = new CacheController({
        fetchImpl: async url => ({
            ok: true,
            headers: new Headers({ 'Cache-Control': url.endsWith('style.css') ? 'max-age=3600' : 'no-cache' }),
        }),
    });

    assert.equal(await controller.probeNativeHttpCache(), false);
});

test('retires its worker when the reverse proxy already provides native browser caching', async () => {
    let retired = 0;
    let registered = 0;
    let cacheStatus = '';

    class NativeCacheController extends CacheController {
        async probe() {
            this.health = { ok: true, version: CLIENT_VERSION, appSignature: 'app-v1' };
            this.state = 'available';
            return this.health;
        }

        async probeNativeHttpCache() {
            return true;
        }

        async retireIncompatibleWorker() {
            retired += 1;
            return 1;
        }

        async register() {
            registered += 1;
            return {};
        }
    }

    const controller = new NativeCacheController({
        detectIOSStandalone: () => false,
        onStatus(key, value) {
            if (key === 'cache') cacheStatus = value;
        },
    });

    assert.equal(await controller.startAfterLogin(), null);
    assert.equal(retired, 1);
    assert.equal(registered, 0);
    assert.equal(cacheStatus, '原生缓存');
    assert.deepEqual(controller.getStatus(), {
        state: 'native-http-cache',
        cache: '原生缓存',
        server: '正常',
        entries: null,
        warning: false,
        overall: '浏览器原生缓存',
    });
});

test('retires the worker instead of registering an outdated server worker', async () => {
    let retired = 0;
    let registered = 0;
    let cacheStatus = '';

    class VersionMismatchController extends CacheController {
        async probe() {
            this.health = { ok: true, version: '1.5.0' };
            this.state = 'version-mismatch';
            return this.health;
        }

        async retireIncompatibleWorker() {
            retired += 1;
            return 1;
        }

        async register() {
            registered += 1;
            return {};
        }
    }

    const controller = new VersionMismatchController({
        onStatus(key, value) {
            if (key === 'cache') cacheStatus = value;
        },
    });

    assert.equal(await controller.startAfterLogin(), null);
    assert.equal(retired, 1);
    assert.equal(registered, 0);
    assert.equal(cacheStatus, '已停用（服务端需更新）');
    assert.deepEqual(controller.getStatus(), {
        state: 'version-mismatch',
        cache: '已停用（服务端需更新）',
        server: '需更新（1.5.0）',
        entries: null,
        warning: true,
        overall: '服务端插件需更新',
    });
});

test('detects only standalone iOS and iPadOS web apps', () => {
    assert.equal(isIOSStandaloneEnvironment({ userAgent: 'iPhone', standalone: true }), true);
    assert.equal(isIOSStandaloneEnvironment({ platform: 'MacIntel', maxTouchPoints: 5, displayModeStandalone: true }), true);
    assert.equal(isIOSStandaloneEnvironment({ userAgent: 'iPhone', standalone: false }), false);
    assert.equal(isIOSStandaloneEnvironment({ platform: 'MacIntel', maxTouchPoints: 0, standalone: true }), false);
    assert.equal(isIOSStandaloneEnvironment({ userAgent: 'Android', standalone: true }), false);
});

test('retires root worker for standalone iOS with Basic Auth but keeps other acceleration enabled', async () => {
    let retired = 0;
    let registered = 0;
    let cacheStatus = '';

    class IOSBasicAuthController extends CacheController {
        async probe() {
            this.health = { ok: true, version: CLIENT_VERSION, basicAuthMode: true, appSignature: 'app-v1' };
            this.state = 'available';
            return this.health;
        }

        async retireIncompatibleWorker() {
            retired += 1;
            return 1;
        }

        async register() {
            registered += 1;
            return {};
        }
    }

    const controller = new IOSBasicAuthController({
        detectIOSStandalone: () => true,
        onStatus(key, value) {
            if (key === 'cache') cacheStatus = value;
        },
    });

    assert.equal(await controller.startAfterLogin(), null);
    assert.equal(retired, 1);
    assert.equal(registered, 0);
    assert.equal(cacheStatus, '已停用（iOS 主屏幕 + Basic Auth）');
    assert.deepEqual(controller.getStatus(), {
        state: 'ios-basic-auth',
        cache: '已停用',
        server: '正常',
        entries: null,
        compatibility: 'iOS 主屏幕 + Basic Auth',
        warning: false,
        overall: 'iOS 兼容模式',
    });
});

test('uses the server app signature without probing the authenticated root page', () => {
    const controller = new CacheController();
    controller.health = { appSignature: 'server-app-signature' };
    assert.equal(controller.readVersionSignature(), 'server-app-signature');
    controller.health = {};
    assert.equal(controller.readVersionSignature(), CLIENT_VERSION);
});
