import test from 'node:test';
import assert from 'node:assert/strict';

import { CLIENT_VERSION } from '../client-core.js';
import { CacheController, isIOSStandaloneEnvironment, serverVersionMatchesClient } from '../modules/cache-controller.js';

test('requires the server plugin to match the UI version exactly', () => {
    assert.equal(serverVersionMatchesClient(CLIENT_VERSION), true);
    assert.equal(serverVersionMatchesClient('1.5.0'), false);
    assert.equal(serverVersionMatchesClient('2.0.5'), false);
    assert.equal(serverVersionMatchesClient(undefined), false);
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
