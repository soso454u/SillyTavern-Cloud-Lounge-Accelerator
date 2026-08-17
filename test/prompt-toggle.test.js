import test from 'node:test';
import assert from 'node:assert/strict';

import { PromptToggleAdapter } from '../adapters/prompt-toggle.js';

function createClassList(initial = []) {
    const values = new Set(initial);
    return {
        toggle(name, force) {
            if (force) values.add(name);
            else values.delete(name);
        },
        has(name) {
            return values.has(name);
        },
    };
}

test('optimistically updates only the clicked prompt row and toggle icon', () => {
    const adapter = new PromptToggleAdapter({});
    const row = { classList: createClassList() };
    const attributes = new Map();
    const toggle = {
        classList: createClassList(['fa-toggle-on']),
        setAttribute(name, value) {
            attributes.set(name, value);
        },
    };
    const manager = { configuration: { prefix: 'completion_' } };

    adapter.updateRow(row, toggle, manager, false);
    assert.equal(row.classList.has('completion_prompt_manager_prompt_disabled'), true);
    assert.equal(toggle.classList.has('fa-toggle-on'), false);
    assert.equal(toggle.classList.has('fa-toggle-off'), true);
    assert.equal(attributes.get('aria-pressed'), 'false');

    adapter.updateRow(row, toggle, manager, true);
    assert.equal(row.classList.has('completion_prompt_manager_prompt_disabled'), false);
    assert.equal(toggle.classList.has('fa-toggle-on'), true);
    assert.equal(toggle.classList.has('fa-toggle-off'), false);
    assert.equal(attributes.get('aria-pressed'), 'true');
});

test('intercepts a generating prompt toggle, saves it, and defers the full render', async () => {
    const originalElement = globalThis.Element;
    class FakeElement { }
    globalThis.Element = FakeElement;
    try {
        const row = new FakeElement();
        row.dataset = { pmIdentifier: 'main' };
        row.classList = createClassList();
        const toggle = new FakeElement();
        toggle.classList = createClassList(['fa-toggle-on']);
        toggle.setAttribute = () => {};
        toggle.closest = selector => selector === '.prompt-manager-toggle-action' ? toggle : row;
        const entry = { enabled: true };
        const counts = { main: 42 };
        let saves = 0;
        const manager = {
            activeCharacter: { id: 100001 },
            configuration: { prefix: 'completion_' },
            listElement: { contains: candidate => candidate === row },
            tokenHandler: { getCounts: () => counts },
            getPromptOrderEntry: () => entry,
            saveServiceSettings: () => {
                saves += 1;
                return Promise.resolve();
            },
        };
        const adapter = new PromptToggleAdapter({ isGenerating: () => true });
        adapter.started = true;
        adapter.openai = { promptManager: manager };
        let queued = 0;
        adapter.queueFlush = () => { queued += 1; };
        let prevented = 0;
        let stopped = 0;

        adapter.onClick({
            target: toggle,
            cancelable: true,
            preventDefault: () => { prevented += 1; },
            stopImmediatePropagation: () => { stopped += 1; },
        });
        await Promise.resolve();

        assert.equal(entry.enabled, false);
        assert.equal(counts.main, null);
        assert.equal(saves, 1);
        assert.equal(queued, 1);
        assert.equal(prevented, 1);
        assert.equal(stopped, 1);
        assert.equal(adapter.pendingManagers.has(manager), true);
        assert.equal(toggle.classList.has('fa-toggle-off'), true);
    } finally {
        if (originalElement === undefined) delete globalThis.Element;
        else globalThis.Element = originalElement;
    }
});

test('handles a generating touch pointer once and suppresses its ghost click', async () => {
    const originalElement = globalThis.Element;
    class FakeElement { }
    globalThis.Element = FakeElement;
    try {
        const row = new FakeElement();
        row.dataset = { pmIdentifier: 'main' };
        row.classList = createClassList();
        const toggle = new FakeElement();
        toggle.classList = createClassList(['fa-toggle-on']);
        toggle.setAttribute = () => {};
        toggle.closest = selector => selector === '.prompt-manager-toggle-action' ? toggle : row;
        const entry = { enabled: true };
        let saves = 0;
        const manager = {
            activeCharacter: { id: 100001 },
            configuration: { prefix: 'completion_' },
            listElement: { contains: candidate => candidate === row },
            tokenHandler: { getCounts: () => ({ main: 1 }) },
            getPromptOrderEntry: () => entry,
            saveServiceSettings: () => {
                saves += 1;
                return Promise.resolve();
            },
        };
        const adapter = new PromptToggleAdapter({ isGenerating: () => true });
        adapter.started = true;
        adapter.openai = { promptManager: manager };
        adapter.queueFlush = () => {};
        let pointerStops = 0;
        let clickStops = 0;

        adapter.onPointerUp({
            target: toggle,
            pointerType: 'touch',
            isPrimary: true,
            button: 0,
            cancelable: true,
            preventDefault: () => {},
            stopImmediatePropagation: () => { pointerStops += 1; },
        });
        adapter.onClick({
            target: toggle,
            cancelable: true,
            preventDefault: () => {},
            stopImmediatePropagation: () => { clickStops += 1; },
        });
        await Promise.resolve();

        assert.equal(entry.enabled, false);
        assert.equal(saves, 1);
        assert.equal(pointerStops, 1);
        assert.equal(clickStops, 1);
    } finally {
        if (originalElement === undefined) delete globalThis.Element;
        else globalThis.Element = originalElement;
    }
});

test('intercepts non-generating touch immediately while leaving mouse pointerup for click', () => {
    const adapter = new PromptToggleAdapter({ isGenerating: () => false });
    adapter.started = true;
    const toggle = {};
    let toggles = 0;
    adapter.getToggle = () => toggle;
    adapter.toggleEntry = () => {
        toggles += 1;
        return true;
    };

    adapter.onPointerUp({ pointerType: 'touch', isPrimary: true, button: 0 });
    assert.equal(toggles, 1);

    adapter.onPointerUp({ pointerType: 'mouse', isPrimary: true, button: 0 });
    assert.equal(toggles, 1);
    assert.ok(adapter.suppressClickUntil > 0);
});

test('does not schedule a full prompt-list render for a normal toggle', async () => {
    const originalElement = globalThis.Element;
    class FakeElement { }
    globalThis.Element = FakeElement;
    try {
        const row = new FakeElement();
        row.dataset = { pmIdentifier: 'instant' };
        row.classList = createClassList();
        const tokenNode = { dataset: { pmTokens: '42' }, textContent: '42' };
        row.querySelector = selector => selector === '.prompt_manager_prompt_tokens' ? tokenNode : null;
        const toggle = new FakeElement();
        toggle.classList = createClassList(['fa-toggle-on']);
        toggle.setAttribute = () => {};
        toggle.closest = selector => selector === '.prompt-manager-toggle-action' ? toggle : row;
        const entry = { enabled: true };
        const manager = {
            activeCharacter: { id: 100001 },
            configuration: { prefix: 'completion_' },
            listElement: { contains: candidate => candidate === row },
            tokenHandler: { getCounts: () => ({ instant: 42 }) },
            getPromptOrderEntry: () => entry,
            saveServiceSettings: () => Promise.resolve(),
        };
        const adapter = new PromptToggleAdapter({ isGenerating: () => false });
        adapter.started = true;
        adapter.openai = { promptManager: manager };
        adapter.queueFlush = () => assert.fail('normal toggles must not rebuild the full list');

        adapter.onClick({
            target: toggle,
            cancelable: true,
            preventDefault() {},
            stopImmediatePropagation() {},
        });
        await Promise.resolve();

        assert.equal(entry.enabled, false);
        assert.equal(toggle.classList.has('fa-toggle-off'), true);
        assert.equal(tokenNode.dataset.pmTokens, '-');
        assert.equal(tokenNode.textContent, '-');
        assert.equal(adapter.pendingManagers.size, 0);
    } finally {
        if (originalElement === undefined) delete globalThis.Element;
        else globalThis.Element = originalElement;
    }
});

test('restores the current row and token display when an instant save fails', async () => {
    const originalElement = globalThis.Element;
    class FakeElement { }
    globalThis.Element = FakeElement;
    try {
        const row = new FakeElement();
        row.dataset = { pmIdentifier: 'rollback' };
        row.classList = createClassList();
        const tokenNode = { dataset: { pmTokens: '73' }, textContent: '73' };
        row.querySelector = () => tokenNode;
        const toggle = new FakeElement();
        toggle.classList = createClassList(['fa-toggle-on']);
        toggle.setAttribute = () => {};
        toggle.closest = selector => selector === '.prompt-manager-toggle-action' ? toggle : row;
        const entry = { enabled: true };
        const manager = {
            activeCharacter: {},
            configuration: { prefix: 'completion_' },
            listElement: { contains: () => true },
            tokenHandler: { getCounts: () => ({ rollback: 73 }) },
            getPromptOrderEntry: () => entry,
            saveServiceSettings: () => Promise.reject(new Error('save failed')),
        };
        const adapter = new PromptToggleAdapter({ isGenerating: () => false });
        adapter.started = true;
        adapter.openai = { promptManager: manager };

        adapter.onClick({
            target: toggle,
            cancelable: true,
            preventDefault() {},
            stopImmediatePropagation() {},
        });
        await Promise.resolve();
        await Promise.resolve();

        assert.equal(entry.enabled, true);
        assert.equal(toggle.classList.has('fa-toggle-on'), true);
        assert.equal(tokenNode.dataset.pmTokens, '73');
        assert.equal(tokenNode.textContent, '73');
    } finally {
        if (originalElement === undefined) delete globalThis.Element;
        else globalThis.Element = originalElement;
    }
});
