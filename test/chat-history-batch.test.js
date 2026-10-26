import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatHistoryBatchActions } from '../modules/chat-history-batch.js';

function fixture(t, { group = false } = {}) {
    const previous = { document: globalThis.document, toastr: globalThis.toastr };
    const requests = [], events = [], notices = [];
    globalThis.document = { removeEventListener() {} };
    globalThis.toastr = Object.fromEntries(['success', 'warning', 'error'].map(level => [level, message => notices.push({ level, message })]));
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
    });
    const character = { avatar: 'character-A.png', chat: 'active' };
    const groupRecord = { id: 'group-A', chat_id: 'active', chats: ['active', 'one', 'two', 'three'], past_metadata: {} };
    const scriptApi = {
        characters: [character], this_chid: 0, getCurrentChatId: () => group ? groupRecord.chat_id : character.chat,
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture' }), isGenerating: () => false,
        event_types: { CHAT_DELETED: 'deleted', GROUP_CHAT_DELETED: 'group-deleted', CHAT_CHANGED: 'changed' },
        eventSource: { async emit(...args) { events.push(args); }, removeListener() {} },
    };
    const adapter = new ChatHistoryBatchActions({ scriptApi, fetchImpl: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body), headers: options.headers });
        return { ok: true };
    } });
    adapter.groupApi = { selected_group: group ? 'group-A' : null, groups: [groupRecord] };
    adapter.popupApi = { Popup: { show: { confirm: async () => 1 } } };
    adapter.started = adapter.mode = true;
    adapter.scope = adapter.getScope();
    adapter.list = { isConnected: true, classList: { remove() {} } };
    const rows = ['active', 'one', 'two', 'three'].map(name => ({
        name, removed: false, getAttribute: () => name, closest() { return this; },
        remove() { this.removed = true; }, querySelector: () => null, classList: { remove() {} },
    }));
    adapter.rows = () => rows.filter(row => !row.removed);
    adapter.selected = new Set(['one', 'two', 'three']);
    adapter.refresh = () => {};
    return { adapter, character, groupRecord, requests, events, notices, rows, scriptApi };
}

test('deletes selected character files with one confirmation and native notifications, keeping the active chat', async t => {
    const f = fixture(t);
    let confirms = 0;
    f.adapter.popupApi.Popup.show.confirm = async () => { confirms++; return 1; };
    await f.adapter.deleteSelected();
    assert.equal(confirms, 1);
    assert.deepEqual(f.requests.map(r => r.body), ['one', 'two', 'three'].map(name => ({ chatfile: name + '.jsonl', avatar_url: 'character-A.png' })));
    assert.ok(f.requests.every(r => r.headers['X-CSRF-Token'] === 'fixture'));
    assert.deepEqual(f.events, ['one', 'two', 'three'].map(name => ['deleted', name]));
    assert.deepEqual(f.rows.map(r => r.removed), [false, true, true, true]);
    assert.equal(f.character.chat, 'active');
    assert.equal(f.adapter.selected.size, 0);
    assert.equal(f.adapter.busy, false);
});

for (const result of [0, null, 1001]) test(`non-affirmative popup result ${result} performs no writes and retains selection`, async t => {
    const f = fixture(t);
    f.adapter.popupApi.Popup.show.confirm = async () => result;
    await f.adapter.deleteSelected();
    assert.equal(f.requests.length, 0);
    assert.equal(f.adapter.selected.size, 3);
    assert.ok(f.rows.every(r => !r.removed));
});

test('HTTP failure reports partial completion and preserves failed and unattempted rows', async t => {
    const f = fixture(t);
    const request = f.adapter.fetchImpl;
    f.adapter.fetchImpl = async (...args) => {
        await request(...args);
        return { ok: f.requests.length < 2, status: 500 };
    };
    await f.adapter.deleteSelected();
    assert.equal(f.requests.length, 2);
    assert.deepEqual([...f.adapter.selected], ['two', 'three']);
    assert.deepEqual(f.rows.map(r => r.removed), [false, true, false, false]);
    assert.match(f.notices[0].message, /已删除 1.*剩余 2.*请求失败/);
});

test('network rejection stops the queue without falsely removing an unconfirmed row', async t => {
    const f = fixture(t);
    f.adapter.fetchImpl = async () => { throw new Error('network disconnected'); };
    await f.adapter.deleteSelected();
    assert.equal(f.adapter.selected.size, 3);
    assert.ok(f.rows.every(r => !r.removed));
    assert.match(f.notices[0].message, /已删除 0.*剩余 3/);
});

for (const change of ['character', 'chat', 'stop', 'close', 'generating', 'hidden', 'replaced-character']) {
    test(`changing ${change} during confirmation prevents deletion`, async t => {
        const f = fixture(t);
        f.adapter.popupApi.Popup.show.confirm = async () => {
            if (change === 'character') f.scriptApi.this_chid = 1;
            if (change === 'chat') f.character.chat = 'two';
            if (change === 'stop') f.adapter.stop();
            if (change === 'close') f.adapter.mode = false;
            if (change === 'generating') f.scriptApi.isGenerating = () => true;
            if (change === 'hidden') f.adapter.root = { checkVisibility: () => false };
            if (change === 'replaced-character') f.scriptApi.characters[0] = { ...f.character };
            return 1;
        };
        await f.adapter.deleteSelected();
        assert.equal(f.requests.length, 0);
        assert.ok(f.rows.every(r => !r.removed));
    });
}

test('double submission shares the existing busy lock', async t => {
    const f = fixture(t);
    let release;
    f.adapter.popupApi.Popup.show.confirm = () => new Promise(resolve => { release = resolve; });
    const first = f.adapter.deleteSelected();
    await f.adapter.deleteSelected();
    assert.equal(f.requests.length, 0);
    release(1);
    await first;
    assert.equal(f.requests.length, 3);
});

test('a context change during an in-flight request prevents subsequent requests and leaves the new list intact', async t => {
    const f = fixture(t);
    const request = f.adapter.fetchImpl;
    f.adapter.fetchImpl = async (...args) => {
        await request(...args);
        f.scriptApi.characters[1] = { avatar: 'character-B.png', chat: 'different' };
        f.scriptApi.this_chid = 1;
        return { ok: true };
    };
    await f.adapter.deleteSelected();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].body.avatar_url, 'character-A.png');
    assert.ok(f.rows.every(r => !r.removed));
    assert.match(f.notices[0].message, /已删除 1.*剩余 2/);
});

for (const action of ['search', 'close-reopen']) test(`${action} during an in-flight request cancels the rest of the confirmed queue`, async t => {
    const f = fixture(t);
    const request = f.adapter.fetchImpl;
    f.adapter.fetchImpl = async (...args) => {
        await request(...args);
        if (action === 'search') f.adapter.onInput({ target: { id: 'select_chat_search' } });
        else {
            f.adapter.onClick({ target: { closest: selector => selector === '#select_chat_cross' ? {} : null } });
            f.adapter.mode = true;
        }
        return { ok: true };
    };
    await f.adapter.deleteSelected();
    assert.equal(f.requests.length, 1);
    assert.equal(f.rows[1].removed, true, 'a confirmed in-flight removal is still reflected');
    assert.equal(f.rows[2].removed, false);
    assert.match(f.notices[0].message, /已删除 1.*剩余 2.*操作已停止/);
});

test('group deletion persists one final group list and keeps unrelated metadata and active chat', async t => {
    const f = fixture(t, { group: true });
    await f.adapter.deleteSelected();
    assert.deepEqual(f.requests.map(r => r.url), [...Array(3).fill('/api/chats/group/delete'), '/api/groups/edit']);
    assert.deepEqual(f.requests.slice(0, 3).map(r => r.body), ['one', 'two', 'three'].map(id => ({ id })));
    assert.deepEqual(f.groupRecord.chats, ['active']);
    assert.deepEqual(f.requests[3].body, { ...f.groupRecord, chats: ['active'] });
    assert.deepEqual(f.events, ['one', 'two', 'three'].map(name => ['group-deleted', name]));
});

test('group partial failure saves only confirmed removals', async t => {
    const f = fixture(t, { group: true });
    const request = f.adapter.fetchImpl;
    f.adapter.fetchImpl = async (...args) => {
        await request(...args);
        return { ok: f.requests.length !== 2, status: 503 };
    };
    await f.adapter.deleteSelected();
    assert.deepEqual(f.groupRecord.chats, ['active', 'two', 'three']);
    assert.deepEqual(f.requests.at(-1).body.chats, ['active', 'two', 'three']);
});

test('group list persistence failure is reported separately from confirmed file deletion', async t => {
    const f = fixture(t, { group: true });
    const request = f.adapter.fetchImpl;
    f.adapter.fetchImpl = async (...args) => { await request(...args); return { ok: args[0] !== '/api/groups/edit', status: 500 }; };
    await f.adapter.deleteSelected();
    assert.equal(f.notices.at(-1).level, 'error');
    assert.match(f.notices.at(-1).message, /文件已删除.*列表未保存/);
});

test('literal .jsonl in a native chat name is preserved when appending the storage extension', async t => {
    const f = fixture(t);
    f.adapter.selected = new Set(['literal.jsonl']);
    await f.adapter.deleteSelected();
    assert.equal(f.requests[0].body.chatfile, 'literal.jsonl.jsonl');
});

test('stopping during native API import prevents attaching observers or handlers', async t => {
    const f = fixture(t);
    f.adapter.started = false;
    let release;
    f.adapter.loadApis = () => new Promise(resolve => { release = resolve; });
    const pending = f.adapter.start();
    f.adapter.stop();
    release([{}, {}]);
    await pending;
    assert.equal(f.adapter.started, false);
    assert.equal(f.adapter.observer, null);
});
