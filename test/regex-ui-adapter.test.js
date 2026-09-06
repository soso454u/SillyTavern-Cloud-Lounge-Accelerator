import test from 'node:test';
import assert from 'node:assert/strict';
import { RegexUiAdapter } from '../modules/regex-ui-adapter.js';

const LIST_SELECTOR = '#saved_regex_scripts, #saved_scoped_scripts, #saved_preset_scripts';

function fixture(t, { typeKey = 'PRESET', scopeOnly = false, known = true, disabled = true } = {}) {
    class Element {
        closest(selector) { return this.matchesBySelector?.[selector] || null; }
    }
    class Input extends Element {
        matches(selector) { return selector === '.disable_regex' && !scopeOnly; }
    }
    const originals = { Element: globalThis.Element, HTMLInputElement: globalThis.HTMLInputElement };
    globalThis.Element = Element;
    globalThis.HTMLInputElement = Input;
    t.after(() => {
        for (const [name, value] of Object.entries(originals)) {
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
        }
    });
    const list = { id: { GLOBAL: 'saved_regex_scripts', SCOPED: 'saved_scoped_scripts', PRESET: 'saved_preset_scripts' }[typeKey] };
    const checkbox = new Input();
    checkbox.checked = disabled;
    const label = new Element();
    label.id = 'imported-regex';
    label.querySelector = selector => selector === '.disable_regex' ? checkbox : null;
    const icon = new Element();
    icon.classList = { contains: name => name === (disabled ? 'regex-toggle-off' : 'regex-toggle-on') };
    for (const element of [icon, checkbox, label]) {
        element.matchesBySelector = {
            '.regex-script-label[id]': scopeOnly ? null : label,
            [LIST_SELECTOR]: scopeOnly ? null : list,
        };
    }
    icon.matchesBySelector['.regex-toggle-on, .regex-toggle-off'] = icon;
    let scripts = known ? [{ id: label.id, disabled }] : [];
    const saved = [];
    let notifications = 0;
    const adapter = new RegexUiAdapter({ onSaved: () => { notifications += 1; } });
    adapter.started = true;
    adapter.popupApi = {};
    adapter.scriptApi = {};
    adapter.engine = {
        SCRIPT_TYPES: { GLOBAL: 0, SCOPED: 1, PRESET: 2 },
        getScriptsByType: () => scripts,
        saveScriptsByType: async (next, type) => { scripts = next; saved.push({ next, type }); },
    };
    function event(target) {
        return {
            target, prevented: false, stopped: false,
            preventDefault() { this.prevented = true; },
            stopImmediatePropagation() { this.stopped = true; },
        };
    }
    return { adapter, icon, checkbox, event, saved, notifications: () => notifications };
}

for (const typeKey of ['PRESET', 'SCOPED']) {
    for (const disabled of [true, false]) {
        test(`${typeKey} permission icon (${disabled ? 'off' : 'on'}) retains native label activation`, async t => {
            const f = fixture(t, { typeKey, scopeOnly: true, disabled });
            const click = f.event(f.icon);
            f.adapter.onClick(click);
            assert.equal(click.prevented, false);
            assert.equal(click.stopped, false);
            const input = f.event(f.checkbox);
            f.adapter.onInput(input);
            assert.equal(input.stopped, false);
            await f.adapter.saveQueue;
            assert.equal(f.saved.length, 0);
        });
    }
}

for (const typeKey of ['GLOBAL', 'SCOPED', 'PRESET']) {
    test(`${typeKey} individual script can be enabled and disabled with optimization active`, async t => {
        const f = fixture(t, { typeKey });
        const click = f.event(f.icon);
        f.adapter.onClick(click);
        await f.adapter.saveQueue;
        assert.equal(click.prevented, true);
        assert.equal(click.stopped, true);
        assert.equal(f.checkbox.checked, false);
        assert.equal(f.saved[0].next[0].disabled, false);
        assert.equal(f.saved[0].type, f.adapter.engine.SCRIPT_TYPES[typeKey]);
        f.icon.classList.contains = name => name === 'regex-toggle-on';
        f.adapter.onClick(f.event(f.icon));
        await f.adapter.saveQueue;
        assert.equal(f.checkbox.checked, true);
        assert.equal(f.saved[1].next[0].disabled, true);
        assert.equal(f.notifications(), 2);
    });
}

test('unknown script rows fall through without swallowing clicks or input', async t => {
    const f = fixture(t, { known: false });
    const click = f.event(f.icon);
    f.adapter.onClick(click);
    const input = f.event(f.checkbox);
    f.adapter.onInput(input);
    assert.equal(click.prevented, false);
    assert.equal(click.stopped, false);
    assert.equal(input.stopped, false);
    await f.adapter.saveQueue;
    assert.equal(f.saved.length, 0);
});

test('queued checkbox changes preserve each input event value', async t => {
    const f = fixture(t);
    f.checkbox.checked = false;
    f.adapter.onInput(f.event(f.checkbox));
    f.checkbox.checked = true;
    f.adapter.onInput(f.event(f.checkbox));
    await f.adapter.saveQueue;
    assert.deepEqual(f.saved.map(call => call.next[0].disabled), [false, true]);
});
