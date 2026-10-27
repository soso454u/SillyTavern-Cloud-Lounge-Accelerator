import test from 'node:test';
import assert from 'node:assert/strict';
import { PresetEntryActions } from '../modules/preset-entry-actions.js';

const gate = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
    let sequence = 0;
    const prompt = { identifier: 'custom', name: '条目 <b>', content: '正文', role: 'assistant', system_prompt: false, marker: false,
        injection_position: 1, injection_depth: 3, injection_order: 22, injection_trigger: ['normal'], extension_data: { nested: true } };
    const settings = { prompts: [prompt, { identifier: 'main', system_prompt: true }, { identifier: 'marker', system_prompt: false, marker: true }],
        prompt_order: [{ character_id: 1, order: [{ identifier: 'main', enabled: true }, { identifier: 'custom', enabled: true }, { identifier: 'marker', enabled: true }] },
            { character_id: 2, order: [{ identifier: 'custom', enabled: false }] }] };
    const saveButton = { dataset: {} };
    const listeners = new Map();
    const documentRef = { addEventListener: (type, handler) => listeners.set(type, handler), removeEventListener: type => listeners.delete(type), getElementById: () => saveButton };
    const manager = { configuration: { prefix: 'completion_' }, serviceSettings: settings, activeCharacter: { id: 1 },
        renderPromptManagerListItems: async () => {}, getUuidv4: () => `new-${++sequence}`,
        getPromptById: id => manager.serviceSettings.prompts.find(item => item.identifier === id),
        getPromptOrderForCharacter: character => manager.serviceSettings.prompt_order.find(item => item.character_id === character.id)?.order,
        loadPromptIntoEditForm: p => { manager.form = structuredClone(p); saveButton.dataset.pmPrompt = p.identifier; },
        updatePromptWithPromptEditForm: p => Object.assign(p, manager.form),
        clearEditForm: () => { manager.form = {}; }, clearInspectForm() {}, showPopup: () => manager.visible = true, hidePopup: () => manager.visible = false,
        saves: 0, saveServiceSettings: async () => { manager.saves++; }, render: after => { assert.equal(after, false); manager.renders = (manager.renders || 0) + 1; },
        isPromptDeletionAllowed: p => p.system_prompt === false,
    };
    const adapter = new PresetEntryActions({ documentRef, loadApi: async () => ({ manager, confirm: async () => true }) });
    adapter.decorate = () => {};
    return { adapter, manager, prompt, settings, saveButton, listeners };
}

test('new/copy stay drafts until Save, preserve fields and insert disabled at the requested position', async () => {
    for (const action of ['new', 'before', 'after', 'copy']) {
        const f = fixture(); await f.adapter.start();
        f.adapter.openDraft(f.adapter.context(), action === 'new' ? undefined : 'custom', action);
        assert.equal(f.settings.prompts.length, 3); assert.equal(f.manager.saves, 0);
        if (action === 'copy') {
            assert.equal(f.manager.form.content, '正文'); assert.equal(f.manager.form.injection_depth, 3);
            assert.deepEqual(f.manager.form.injection_trigger, ['normal']);
            f.manager.form.extension_data.nested = false;
            assert.equal(f.prompt.extension_data.nested, true, 'copy must not alias custom metadata');
        }
        f.manager.form.name = '我的新条目';
        await f.adapter.saveDraft();
        const order = f.settings.prompt_order[0].order;
        const index = action === 'new' ? 3 : action === 'before' ? 1 : 2;
        assert.deepEqual(order[index], { identifier: 'new-1', enabled: false });
        assert.equal(f.settings.prompts.at(-1).name, '我的新条目');
        assert.equal(f.settings.prompts.at(-1).system_prompt, false);
        assert.equal(f.manager.saves, 1); assert.equal(f.manager.visible, false);
    }
});

test('cancel/stop discards drafts, restores wrapper and removes listeners; no preset write', async () => {
    const f = fixture(); const original = f.manager.renderPromptManagerListItems;
    await f.adapter.start(); await f.adapter.start();
    f.adapter.openDraft(f.adapter.context(), undefined, 'new');
    f.adapter.stop();
    assert.equal(f.manager.saves, 0); assert.equal(f.settings.prompts.length, 3);
    assert.equal(f.manager.renderPromptManagerListItems, original); assert.equal(f.listeners.size, 0);
    assert.equal(f.manager.visible, false); assert.equal(f.adapter.pending, null);
});

test('an empty current list accepts its first entry', async () => {
    const f = fixture(); f.settings.prompt_order[0].order = []; await f.adapter.start();
    f.adapter.openDraft(f.adapter.context(), undefined, 'new'); await f.adapter.saveDraft();
    assert.deepEqual(f.settings.prompt_order[0].order, [{ identifier: 'new-1', enabled: false }]);
});

test('successful in-flight save after stop does not reopen or rerender plugin UI', async () => {
    const f = fixture(); await f.adapter.start(); const waiting = gate(); f.manager.saveServiceSettings = () => waiting.promise;
    f.adapter.openDraft(f.adapter.context(), undefined, 'new'); const saving = f.adapter.saveDraft();
    f.adapter.stop(); waiting.resolve(); await saving;
    assert.equal(f.manager.visible, false); assert.equal(f.manager.renders, undefined); assert.equal(f.adapter.pending, null);
});

test('remove retains the library and other lists; delete removes the prompt and all its references', async () => {
    for (const permanent of [false, true]) {
        const f = fixture(); await f.adapter.start();
        await f.adapter.deleteEntry(f.adapter.context(), 'custom', permanent);
        assert.equal(f.settings.prompt_order[0].order.some(item => item.identifier === 'custom'), false);
        assert.equal(f.settings.prompts.includes(f.prompt), !permanent);
        assert.equal(f.settings.prompt_order[1].order.length, permanent ? 0 : 1);
        assert.equal(f.manager.saves, 1);
    }
});

test('built-in prompts and markers are protected from remove/delete, and markers cannot be copied', async () => {
    const f = fixture(); await f.adapter.start();
    for (const id of ['main', 'marker']) for (const permanent of [false, true]) await f.adapter.deleteEntry(f.adapter.context(), id, permanent);
    f.adapter.openDraft(f.adapter.context(), 'marker', 'copy');
    assert.equal(f.manager.saves, 0); assert.equal(f.adapter.pending, null);
});

test('confirmation cancel and context changes while confirming never write', async () => {
    for (const mode of ['cancel', 'preset', 'character', 'stop']) {
        const f = fixture(); await f.adapter.start(); const waiting = gate();
        f.adapter.confirm = () => waiting.promise;
        const deleting = f.adapter.deleteEntry(f.adapter.context(), 'custom', true);
        if (mode === 'preset') f.settings.prompts = [...f.settings.prompts];
        if (mode === 'character') f.manager.activeCharacter = { id: 2 };
        if (mode === 'stop') f.adapter.stop();
        waiting.resolve(mode !== 'cancel'); await deleting;
        assert.equal(f.manager.saves, 0); assert.equal(f.settings.prompts.length, 3);
    }
});

test('draft save rejects changed preset, changed character, missing anchor, blank name and generation', async () => {
    for (const mode of ['preset', 'character', 'anchor', 'blank', 'generation']) {
        const f = fixture(); await f.adapter.start(); f.adapter.openDraft(f.adapter.context(), 'custom', 'after');
        if (mode === 'preset') f.settings.prompts = [...f.settings.prompts];
        if (mode === 'character') f.manager.activeCharacter = { id: 2 };
        if (mode === 'anchor') f.settings.prompt_order[0].order.splice(1, 1);
        if (mode === 'blank') f.manager.form.name = '  ';
        if (mode === 'generation') f.adapter.isGenerating = () => true;
        await f.adapter.saveDraft(); assert.equal(f.manager.saves, 0); assert.equal(f.settings.prompts.length, 3);
    }
});

test('failed draft/delete writes restore arrays and keep draft for retry', async t => {
    const originalError = console.error; console.error = () => {}; t.after(() => console.error = originalError);
    for (const mode of ['new', 'delete']) {
        const f = fixture(); await f.adapter.start(); const prompts = f.settings.prompts; const order = f.settings.prompt_order[0].order;
        f.manager.saveServiceSettings = async () => { throw new Error('offline'); };
        if (mode === 'new') { f.adapter.openDraft(f.adapter.context(), 'custom', 'before'); await f.adapter.saveDraft(); }
        else await f.adapter.deleteEntry(f.adapter.context(), 'custom', true);
        assert.equal(f.settings.prompts, prompts); assert.equal(f.settings.prompt_order[0].order, order);
        assert.equal(f.settings.prompt_order[1].order.length, 1);
        if (mode === 'new') {
            assert.ok(f.adapter.pending); assert.equal(f.manager.visible, true);
            f.manager.saveServiceSettings = async () => f.manager.saves++;
            await f.adapter.saveDraft(); assert.equal(f.settings.prompts.length, 4);
        }
    }
});

test('saving twice while in flight writes once; newer edits stay open after successful creation', async () => {
    const f = fixture(); await f.adapter.start(); const waiting = gate();
    f.manager.saveServiceSettings = () => { f.manager.saves++; return waiting.promise; };
    f.adapter.openDraft(f.adapter.context(), undefined, 'new');
    const saving = f.adapter.saveDraft(); await f.adapter.saveDraft();
    f.manager.form.content = '继续写的新内容';
    waiting.resolve(); await saving;
    assert.equal(f.manager.saves, 1); assert.equal(f.manager.visible, true); assert.equal(f.adapter.pending, null);
    assert.equal(f.settings.prompts.at(-1).content, ''); assert.equal(f.manager.form.content, '继续写的新内容');
});

test('failure never overwrites a later external array replacement or a new preset', async t => {
    const originalError = console.error; console.error = () => {}; t.after(() => console.error = originalError);
    const f = fixture(); await f.adapter.start(); const waiting = gate();
    f.manager.saveServiceSettings = () => waiting.promise;
    const deleting = f.adapter.deleteEntry(f.adapter.context(), 'custom', true);
    await Promise.resolve();
    const external = [{ identifier: 'external' }]; f.settings.prompts = external;
    waiting.reject(new Error('offline')); await deleting;
    assert.equal(f.settings.prompts, external);
});

test('stopping during API import cannot install a late wrapper, and cleanup respects another extension', async () => {
    const f = fixture(); const waiting = gate(); f.adapter.loadApi = () => waiting.promise;
    const starting = f.adapter.start(); f.adapter.stop();
    waiting.resolve({ manager: f.manager, confirm: async () => true }); assert.equal(await starting, false);
    assert.equal(f.listeners.size, 0);
    await f.adapter.start(); const external = () => {}; f.manager.renderPromptManagerListItems = external;
    f.adapter.stop(); assert.equal(f.manager.renderPromptManagerListItems, external);
});
