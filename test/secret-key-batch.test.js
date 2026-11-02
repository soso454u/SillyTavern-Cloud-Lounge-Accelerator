import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretKeyBatchActions } from '../modules/secret-key-batch.js';

function fixture(t) {
    const previous = { document: globalThis.document, toastr: globalThis.toastr };
    const calls = [], notices = [], confirmations = [];
    globalThis.document = { createElement: () => ({ textContent: '' }), removeEventListener() {} };
    globalThis.toastr = Object.fromEntries(['success', 'warning', 'error'].map(level => [level, message => notices.push({ level, message })]));
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
    });
    const rows = ['one', 'active', 'three'].map(id => ({
        removed: false, querySelector: () => ({ dataset: { id } }),
        remove() { this.removed = true; },
    }));
    const adapter = new SecretKeyBatchActions();
    adapter.started = adapter.mode = true;
    adapter.root = { isConnected: true, checkVisibility: () => true };
    adapter.list = { isConnected: true, contains: row => rows.includes(row) && !row.removed };
    adapter.key = 'api_key_custom';
    adapter.getKey = () => adapter.key;
    adapter.rows = () => rows.filter(row => !row.removed);
    adapter.selected = new Set(['one', 'active', 'three']);
    adapter.refresh = () => {};
    adapter.syncNativeRows = () => {};
    adapter.secretApi = {
        secret_state: { api_key_custom: rows.map((_, index) => ({ id: ['one', 'active', 'three'][index], active: index === 1 })),
            api_key_openai: [{ id: 'unrelated', active: true }] },
        async deleteSecret(key, id) {
            calls.push({ key, id });
            this.secret_state = { ...this.secret_state, [key]: this.secret_state[key].filter(secret => secret.id !== id) };
            if (!this.secret_state[key].some(secret => secret.active) && this.secret_state[key].length) this.secret_state[key][0].active = true;
        },
    };
    adapter.popupApi = { POPUP_RESULT: { AFFIRMATIVE: 1 }, Popup: { show: { async confirm(header, content, options) {
        confirmations.push({ header, text: content.textContent, options });
        return 1;
    } } } };
    return { adapter, calls, notices, rows, confirmations };
}

test('one confirmation deletes exact selected IDs through native API and follows native active-key changes', async t => {
    const f = fixture(t);
    await f.adapter.deleteSelected();
    assert.deepEqual(f.calls, ['one', 'active', 'three'].map(id => ({ key: 'api_key_custom', id })));
    assert.equal(f.confirmations.length, 1);
    assert.equal(f.confirmations[0].header, null);
    assert.match(f.confirmations[0].text, /3 个密钥.*无法撤销.*当前使用/);
    assert.ok(f.rows.every(row => row.removed));
    assert.deepEqual(f.adapter.secretApi.secret_state.api_key_openai, [{ id: 'unrelated', active: true }]);
    assert.equal(f.adapter.selected.size, 0);
    assert.equal(f.adapter.busy, false);
    assert.match(f.notices[0].message, /已删除 3 个密钥$/);
});

for (const result of [0, null, undefined, 1001]) test(`non-affirmative result ${result} preserves every key`, async t => {
    const f = fixture(t);
    f.adapter.popupApi.Popup.show.confirm = async () => result;
    await f.adapter.deleteSelected();
    assert.equal(f.calls.length, 0);
    assert.equal(f.adapter.selected.size, 3);
    assert.ok(f.rows.every(row => !row.removed));
    assert.equal(f.notices.length, 0);
});

test('unselected and currently active keys are preserved when not selected', async t => {
    const f = fixture(t);
    f.adapter.selected = new Set(['one']);
    await f.adapter.deleteSelected();
    assert.deepEqual(f.calls, [{ key: 'api_key_custom', id: 'one' }]);
    assert.doesNotMatch(f.confirmations[0].text, /当前使用/);
    assert.deepEqual(f.rows.map(row => row.removed), [true, false, false]);
});

for (const failure of ['HTTP', 'network', 'state-read', 'malformed-state']) test(`${failure} stops after verified success and retains uncertain/unattempted rows`, async t => {
    const f = fixture(t);
    const native = f.adapter.secretApi.deleteSecret;
    f.adapter.secretApi.deleteSecret = async function (key, id) {
        if (id === 'one') return native.call(this, key, id);
        f.calls.push({ key, id });
        if (failure === 'network') throw new Error('offline');
        if (failure === 'HTTP') this.secret_state = { ...this.secret_state }; // refreshed, but ID remains
        if (failure === 'malformed-state') this.secret_state = { ...this.secret_state, [key]: true };
        // state-read simulates native swallowed read errors: unchanged state ref.
    };
    await f.adapter.deleteSelected();
    assert.equal(f.calls.length, 2);
    assert.deepEqual([...f.adapter.selected], ['active', 'three']);
    assert.deepEqual(f.rows.map(row => row.removed), [true, false, false]);
    assert.match(f.notices[0].message, /已删除 1.*剩余 2.*未确认/);
});

for (const change of ['stop', 'close', 'reopen', 'scope', 'list', 'row', 'active', 'hidden']) test(`${change} during confirmation invalidates the frozen queue`, async t => {
    const f = fixture(t);
    f.adapter.popupApi.Popup.show.confirm = async () => {
        if (change === 'stop') { f.adapter.started = false; f.adapter.generation++; }
        if (change === 'close') f.adapter.root.isConnected = false;
        if (change === 'reopen') f.adapter.generation++;
        if (change === 'scope') f.adapter.key = 'api_key_openai';
        if (change === 'list') f.adapter.list = { isConnected: true };
        if (change === 'row') f.rows[0].removed = true;
        if (change === 'active') f.adapter.secretApi.secret_state.api_key_custom.forEach(secret => { secret.active = secret.id === 'three'; });
        if (change === 'hidden') f.adapter.root.checkVisibility = () => false;
        return 1;
    };
    await f.adapter.deleteSelected();
    assert.equal(f.calls.length, 0);
});

test('closing during an in-flight native deletion stops the remaining queue', async t => {
    const f = fixture(t);
    const native = f.adapter.secretApi.deleteSecret;
    f.adapter.secretApi.deleteSecret = async function (...args) {
        await native.apply(this, args);
        f.adapter.root.isConnected = false;
    };
    await f.adapter.deleteSelected();
    assert.equal(f.calls.length, 1);
    assert.match(f.notices[0].message, /已删除 1.*剩余 2.*操作已停止/);
});

test('double submission cannot open another confirmation or send another delete', async t => {
    const f = fixture(t);
    let release;
    f.adapter.popupApi.Popup.show.confirm = () => new Promise(resolve => { release = resolve; });
    const pending = f.adapter.deleteSelected();
    await f.adapter.deleteSelected();
    assert.equal(f.calls.length, 0);
    release(1);
    await pending;
    assert.equal(f.calls.length, 3);
});

test('native state can omit an emptied key namespace after the final deletion', async t => {
    const f = fixture(t);
    const native = f.adapter.secretApi.deleteSecret;
    f.adapter.secretApi.deleteSecret = async function (...args) {
        await native.apply(this, args);
        if (!this.secret_state.api_key_custom.length) delete this.secret_state.api_key_custom;
    };
    await f.adapter.deleteSelected();
    assert.equal(f.notices[0].level, 'success');
    assert.equal(f.calls.length, 3);
});

test('stopping during API import prevents late observer/listener attachment', async t => {
    const f = fixture(t);
    f.adapter.started = false;
    f.adapter.removeUi = () => {};
    let release;
    f.adapter.loadApis = () => new Promise(resolve => { release = resolve; });
    const pending = f.adapter.start();
    f.adapter.stop();
    release([f.adapter.secretApi, f.adapter.popupApi]);
    await pending;
    assert.equal(f.adapter.started, false);
    assert.equal(f.adapter.observer, null);
});
