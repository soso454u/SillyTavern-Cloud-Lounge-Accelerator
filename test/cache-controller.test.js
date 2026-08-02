import test from 'node:test';
import assert from 'node:assert/strict';

import { CLIENT_VERSION } from '../client-core.js';
import { CacheController, serverVersionMatchesClient } from '../modules/cache-controller.js';

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
