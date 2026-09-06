import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreNativeInputLayout } from '../modules/native-input.js';

function element() {
    const classes = new Set(['cla-keyboard-overlay', 'cla-keyboard-closing', 'user-theme']);
    const properties = new Map([['--cla-keyboard-shift', '-320px'], ['height', '70px'], ['translate', '0 2px']]);
    return {
        classes, properties,
        classList: { remove: (...names) => names.forEach(name => classes.delete(name)) },
        style: { removeProperty: name => properties.delete(name) },
    };
}

test('removes old keyboard compensation while preserving user styling, focus and scroll', () => {
    const form = element();
    const body = element();
    const textarea = { value: '未发送的正文', selectionStart: 2, selectionEnd: 5 };
    const doc = { body, activeElement: textarea, querySelector: () => form };
    restoreNativeInputLayout(doc);
    restoreNativeInputLayout(doc);
    for (const target of [form, body]) {
        assert.deepEqual([...target.classes], ['user-theme']);
        assert.deepEqual([...target.properties], [['height', '70px'], ['translate', '0 2px']]);
    }
    assert.equal(doc.activeElement, textarea);
    assert.equal(textarea.value, '未发送的正文');
    assert.equal(textarea.selectionStart, 2);
    assert.equal(textarea.selectionEnd, 5);
});

test('native input cleanup tolerates missing layout during initialization or teardown', () => {
    assert.doesNotThrow(() => restoreNativeInputLayout({ querySelector: () => null }));
});
