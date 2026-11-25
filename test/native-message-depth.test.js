import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const patch = await readFile(new URL('../patches/sillytavern-message-depth.patch', import.meta.url), 'utf8');
const block = prefix => patch.split('\n').filter(line => line.startsWith(prefix) && !line.startsWith(prefix.repeat(3))).map(line => line.slice(1)).join('\n');
const oldBlock = block('-'), newBlock = block('+');
const original = new Function('chat', 'messageId', `${oldBlock}\nreturn depth;`);
const optimized = new Function('chat', 'messageId', `${newBlock}\nreturn depth;`);

test('native patch preserves regex depth across system messages, invalid ids and sparse histories', () => {
    for (let length = 0; length < 120; length++) {
        const chat = Array.from({ length }, (_, index) => ({ is_system: index % 7 === 0 }));
        for (const sparse of [false, true]) {
            if (sparse && chat.length > 4) delete chat[3];
            for (const id of [-1, 0, 1, 3, length - 1, length, length + 1, '0', '1', undefined, null, NaN, 0.5, Infinity]) {
                assert.equal(optimized(chat, id), original(chat, id), `depth differs for ${length}/${id}/${sparse}`);
            }
        }
    }
});

test('formatting the tail no longer visits every historical message or changes chat data', () => {
    let reads = 0;
    const chat = Array.from({ length: 10000 }, () => ({ get is_system() { reads++; return false; } }));
    assert.equal(original(chat, 9999), 0);
    assert.equal(reads, 10000);
    reads = 0;
    assert.equal(optimized(chat, 9999), 0);
    assert.equal(reads, 1);
    const data = [{ mes: 'hello', extra: { variables: { value: 1 } } }, { is_system: true }, { mes: 'reply' }];
    const before = structuredClone(data);
    optimized(data, 0);
    assert.deepEqual(data, before);
});

test('patch matches the actual native reference source', { skip: !process.env.CLA_NATIVE_SCRIPT }, async () => {
    const source = await readFile(process.env.CLA_NATIVE_SCRIPT, 'utf8');
    assert.ok(source.includes(oldBlock), 'native source must match before applying this patch');
});
