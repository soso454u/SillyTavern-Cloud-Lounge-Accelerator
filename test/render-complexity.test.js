import test from 'node:test';
import assert from 'node:assert/strict';
import { getComplexityInterval, measureRenderComplexity } from '../modules/render-complexity.js';

const text = length => ({ nodeType: 3, length });
const element = nodeName => ({ nodeType: 1, nodeName });

function sample(nodes) {
    const root = {
        get innerHTML() { assert.fail('must not serialize HTML'); },
        get textContent() { assert.fail('must not concatenate text'); },
        getBoundingClientRect() { assert.fail('must not force layout'); },
    };
    let visits = 0;
    const documentRef = { createTreeWalker(target, mask) {
        assert.equal(target, root);
        assert.equal(mask, 5);
        return { nextNode: () => nodes[visits++] || null };
    } };
    return { result: measureRenderComplexity(root, documentRef), get visits() { return visits; } };
}

test('normal text retains the native device budget; long text and rendered frames reserve extra time', () => {
    const ordinary = sample([element('P'), text(8000)]).result;
    assert.equal(ordinary.tier, 'normal');
    assert.equal(getComplexityInterval(ordinary, 'webkit'), 0);
    for (const nodes of [[text(16000)], [element('IFRAME')], Array.from({ length: 160 }, () => element('SPAN'))]) {
        const large = sample(nodes).result;
        assert.equal(large.tier, 'large');
        assert.equal(getComplexityInterval(large, 'desktop'), 100);
        assert.equal(getComplexityInterval(large, 'balanced'), 250);
    }
});

test('large HTML code replacements and dense output stop sampling at a fixed bound', () => {
    // A small raw placeholder can become a large escaped HTML code block.
    const code = sample([element('PRE'), element('CODE'), text(86518), element('SPAN')]);
    assert.deepEqual(code.result, { tier: 'heavy', nodes: 3, chars: 64000, frames: 0 });
    assert.equal(code.visits, 3);
    assert.equal(getComplexityInterval(code.result, 'webkit'), 500);
    const dense = sample(Array.from({ length: 10000 }, () => element('SPAN')));
    assert.equal(dense.visits, 400);
    assert.equal(dense.result.tier, 'heavy');
    const frames = sample(Array.from({ length: 100 }, () => element('IFRAME')));
    assert.equal(frames.visits, 3);
    assert.equal(getComplexityInterval(frames.result, 'desktop'), 250);
});

test('absent DOM capabilities leave native timing available', () => {
    assert.equal(measureRenderComplexity(null, {}).tier, 'normal');
    assert.equal(measureRenderComplexity({}, {}).tier, 'normal');
});
