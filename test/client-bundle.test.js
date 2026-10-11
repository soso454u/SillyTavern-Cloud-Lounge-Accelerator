import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const installRoot = new URL('https://example.test/scripts/extensions/third-party/cloud-lounge-accelerator/');
const imports = source => [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)].map(match => match[1]);

async function graph(entry, { staticOnly = false } = {}) {
    const own = new Map();
    const native = new Set();
    async function visit(relativePath) {
        if (own.has(relativePath)) return;
        const source = await readFile(new URL(relativePath, root), 'utf8');
        own.set(relativePath, source);
        const content = staticOnly ? source.replace(/\bimport\s*\(\s*['"][^'"]+['"]\s*\)/g, '') : source;
        for (const specifier of imports(content)) {
            const resolved = new URL(specifier, new URL(relativePath, installRoot));
            if (resolved.href.startsWith(installRoot.href)) await visit(resolved.href.slice(installRoot.href.length));
            else native.add(resolved.href);
        }
    }
    await visit(entry);
    return { own, native };
}

test('published client preserves native module locations across bundling', async () => {
    const [source, bundled] = await Promise.all([graph('index.js'), graph('dist/index.js')]);
    assert.deepEqual([...bundled.native].sort(), [...source.native].sort());
    assert.ok(bundled.own.size <= 3, 'all own modules should fit in entry, shared and deferred bundles');
});

test('manifest loads the published bundle and keeps optional runtime off the initial request path', async () => {
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    assert.equal(manifest.js, 'dist/index.js');
    const { own } = await graph(manifest.js, { staticOnly: true });
    assert.equal(own.size, 2, 'activation downloads only entry and shared helpers');
    assert.ok([...own.values()].reduce((sum, source) => sum + Buffer.byteLength(source), 0) < 46000);
    assert.ok(![...own.keys()].some(path => path.includes('deferred-runtime')));
    const entry = own.get(manifest.js);
    for (const hook of Object.values(manifest.hooks)) assert.match(entry, new RegExp(`\\b${hook}\\b`));
});
