import test from 'node:test';
import assert from 'node:assert/strict';

import { info, init } from '../server/index.js';

function createResponse() {
    return {
        headers: {},
        body: null,
        set(values) {
            Object.assign(this.headers, values);
            return this;
        },
        json(value) {
            this.body = value;
            return this;
        },
        send(value) {
            this.body = value;
            return this;
        },
    };
}

test('registers health and root-scoped worker endpoints', async () => {
    const routes = new Map();
    const router = {
        get(path, handler) {
            routes.set(path, handler);
        },
        post(path, handler) {
            routes.set(`POST ${path}`, handler);
        },
    };
    await init(router);

    assert.deepEqual([...routes.keys()], ['/health', '/performance', 'POST /performance', '/service-worker.js']);

    const health = createResponse();
    await routes.get('/health')({}, health);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.id, info.id);
    assert.equal(typeof health.body.basicAuthMode, 'boolean');
    assert.equal(typeof health.body.appSignature, 'string');
    assert.equal(health.headers['Cache-Control'], 'no-store');

    const worker = createResponse();
    routes.get('/service-worker.js')({}, worker);
    assert.equal(worker.headers['Service-Worker-Allowed'], '/');
    assert.equal(worker.headers['X-Content-Type-Options'], 'nosniff');
    assert.match(worker.headers['Content-Type'], /^application\/javascript/);
    assert.match(worker.body, /self\.addEventListener\('fetch'/);
});
