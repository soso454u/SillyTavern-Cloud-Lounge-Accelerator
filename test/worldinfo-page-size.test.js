import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldInfoPageSize, WORLD_INFO_PAGE_SIZES, WORLD_INFO_PAGER_SELECTOR } from '../modules/worldinfo-page-size.js';

function fixture(initial, { pagerValue, nativePersists = true } = {}) {
    let stored = initial;
    const writes = [];
    const events = [];
    const storage = {
        getItem(key) { assert.equal(key, 'WI_PerPage'); return stored; },
        setItem(key, value) { assert.equal(key, 'WI_PerPage'); writes.push(value); stored = value; },
    };
    const pager = pagerValue === undefined ? null : {
        value: String(pagerValue),
        options: WORLD_INFO_PAGE_SIZES.map(value => ({ value: String(value) })),
        dispatchEvent(event) {
            events.push([event.type, event.bubbles, this.value]);
            if (nativePersists) storage.setItem('WI_PerPage', this.value);
        },
    };
    const controller = new WorldInfoPageSize({
        documentRef: { querySelector(selector) { assert.equal(selector, WORLD_INFO_PAGER_SELECTOR); return pager; } },
        importStorage: async () => ({ accountStorage: storage }),
    });
    return { controller, writes, events, pager, storage };
}

test('default 25, all six native choices, and read existing settings without writing', async () => {
    const { controller, storage, writes } = fixture(null);
    assert.equal(await controller.read(), 25);
    assert.deepEqual(writes, []);
    for (const value of [10, 25, 50, 100, 500, 1000]) {
        storage.setItem('WI_PerPage', String(value));
        assert.equal(await controller.read(), value);
    }
    assert.equal(writes.length, 6);
});

test('persists a selection without an open world book; no duplicate writes or invalid sizes', async () => {
    const { controller, writes } = fixture(null);
    await controller.write(25);
    assert.deepEqual(writes, []);
    await controller.write(10);
    await controller.write(10);
    assert.equal(await controller.read(), 10);
    assert.deepEqual(writes, ['10']);
    await assert.rejects(controller.write(20), /无效/);
    assert.deepEqual(writes, ['10']);
});

test('uses the existing native paginator and does not duplicate its save', async () => {
    const { controller, writes, events, pager } = fixture('500', { pagerValue: 500 });
    await controller.write(25);
    assert.equal(pager.value, '25');
    assert.deepEqual(events, [['change', true, '25']]);
    assert.deepEqual(writes, ['25']);
    await controller.write(25);
    assert.equal(events.length, 1);
    assert.deepEqual(writes, ['25']);
});

test('falls back to account preference when the native change handler is unavailable', async () => {
    const { controller, writes } = fixture('10', { pagerValue: 10, nativePersists: false });
    await controller.write(1000);
    assert.deepEqual(writes, ['1000']);
});

test('an unsupported native storage API fails safely', async () => {
    const controller = new WorldInfoPageSize({ importStorage: async () => ({}) });
    await assert.rejects(controller.read(), /不支持/);
    await assert.rejects(controller.write(10), /不支持/);
});
