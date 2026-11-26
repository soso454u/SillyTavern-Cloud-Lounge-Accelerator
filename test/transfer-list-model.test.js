import test from 'node:test';
import assert from 'node:assert/strict';
import { TransferListFilter, transferPage } from '../utils/transfer-list-model.js';

test('search covers entry bodies and options but serializes each snapshot entry only once', () => {
    let reads = 0;
    const items = Array.from({ length: 283 }, (_, i) => ({ id: String(i), value: {
        comment: `条目 ${i}`, get content() { reads++; return i === 282 ? '最后一项的特殊内容' : '其他正文'; }, disable: i === 282,
    } }));
    const model = new TransferListFilter();
    assert.equal(model.filter(items, 'world'), items);
    assert.equal(reads, 0, 'opening a list needs no serialization');
    const found = model.filter(items, 'world', '特殊内容');
    assert.deepEqual(found.map(item => item.id), ['282']);
    assert.equal(reads, 283);
    assert.equal(model.filter(items, 'world', '特殊内容'), found);
    model.filter(items, 'world', '最后一项');
    assert.equal(reads, 283);
    assert.equal(model.filter(items, 'world', '', 'disabled').length, 1);
    assert.equal(model.filter([{ id: 'new', value: { content: '新内容' } }], 'world', '特殊内容').length, 0);
});

test('all pages keep every entry in order without exceeding forty mounted items', () => {
    const items = Array.from({ length: 283 }, (_, i) => ({ id: String(i) }));
    const pages = Array.from({ length: 8 }, (_, i) => transferPage(items, i));
    assert.deepEqual(pages.flatMap(page => page.items), items);
    assert.ok(pages.every(page => page.items.length <= 40));
    assert.equal(pages[7].start, 280);
    assert.equal(pages[7].end, 283);
    assert.equal(transferPage(items, 999).index, 7);
    assert.equal(transferPage(items, -1).index, 0);
    assert.equal(transferPage([]).items.length, 0);
    assert.equal(transferPage(items, 0, 20).items.length, 20);
});

test('search text retention stays bounded and closing can release its snapshot', () => {
    const model = new TransferListFilter();
    const items = Array.from({ length: 20 }, (_, i) => ({ id: String(i), value: { content: 'x'.repeat(200000) } }));
    assert.equal(model.filter(items, 'world', 'x').length, 20);
    assert.ok(model.cachedChars <= 2000000);
    model.clear();
    assert.equal(model.last, null);
    assert.equal(model.cachedChars, 0);
});
