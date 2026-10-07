import test from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceConfigController } from '../modules/performance-config.js';

test('coalesces cloud status reads and reuses recent results during startup updates', async () => {
    let resolveResponse;
    let calls = 0;
    let time = 0;
    const controller = new PerformanceConfigController({
        now: () => time,
        fetchImpl: () => {
            calls += 1;
            return new Promise(resolve => { resolveResponse = resolve; });
        },
    });
    const first = controller.refresh();
    const concurrent = controller.refresh();
    assert.equal(calls, 1);
    resolveResponse(Response.json({ ok: true, restartRequired: true, settings: { lazyCharacters: true } }));
    assert.equal(await first, await concurrent);
    time = 1000;
    assert.equal((await controller.refresh()).settings.lazyCharacters, true);
    assert.equal(calls, 1);
    time = 5001;
    const expired = controller.refresh();
    assert.equal(calls, 2);
    resolveResponse(Response.json({ ok: true, settings: { lazyCharacters: false } }));
    assert.equal((await expired).restartRequired, true);
    const forced = controller.refresh({ force: true });
    assert.equal(calls, 3);
    resolveResponse(Response.json({ ok: true, settings: {} }));
    await forced;
});

test('does not repeatedly probe a missing server on each status update', async () => {
    let calls = 0;
    const controller = new PerformanceConfigController({ fetchImpl: async () => {
        calls += 1;
        return Response.json({ ok: false }, { status: 404 });
    } });
    await controller.refresh();
    assert.equal((await controller.refresh()).available, false);
    assert.equal(calls, 1);
});

test('a slow status read cannot overwrite a newer saved performance setting', async () => {
    let resolveRead;
    let calls = 0;
    const controller = new PerformanceConfigController({ fetchImpl: (_, options) => {
        calls += 1;
        if (options.method === 'POST') return Promise.resolve(Response.json({
            ok: true, restartRequired: true, settings: { lazyCharacters: true },
        }));
        return new Promise(resolve => { resolveRead = resolve; });
    } });
    const oldRead = controller.refresh();
    await controller.set('lazyCharacters', true);
    assert.equal((await controller.refresh()).settings.lazyCharacters, true);
    assert.equal(calls, 2);
    resolveRead(Response.json({ ok: true, settings: { lazyCharacters: false } }));
    assert.equal((await oldRead).settings.lazyCharacters, true);
    assert.equal(controller.status.restartRequired, true);
});
