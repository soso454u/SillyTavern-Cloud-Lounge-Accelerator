// The published bundle is committed: installing/updating in SillyTavern needs no build step.
import { build, transform } from 'esbuild';
import { readFile, readdir, mkdir, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = path.join(root, 'dist');
const check = process.argv.includes('--check');
const analyze = process.argv.includes('--analyze');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
async function compactCss(file) {
    const input = await readFile(file, 'utf8');
    // Keep declaration values and rule order. Only strip formatting whitespace.
    return (await transform(input, { loader: 'css', minifyWhitespace: true })).code;
}

const result = await build({
    absWorkingDir: root,
    entryPoints: { index: 'index.js' },
    outdir: outputDirectory,
    bundle: true,
    splitting: true,
    format: 'esm',
    target: ['es2022'],
    minify: true,
    charset: 'utf8',
    legalComments: 'inline',
    banner: { js: `/* Cloud Lounge Accelerator ${version} | AGPL-3.0-only | Source: ../index.js */` },
    chunkNames: '[name]-[hash]',
    write: false,
    metafile: analyze,
    plugins: [{
        name: 'transfer-style-text',
        setup(build) {
            build.onLoad({ filter: /transfer\.css$/ }, async args => ({
                contents: await compactCss(args.path),
                loader: 'text',
            }));
        },
    }, {
        name: 'keep-native-sillytavern-modules',
        setup(build) {
            build.onResolve({ filter: /^\./ }, args => {
                if (!args.importer) return;
                const importer = path.relative(root, args.importer).split(path.sep).join('/');
                const relativePath = path.posix.normalize(path.posix.join(path.posix.dirname(importer), args.path));
                if (!relativePath.startsWith('../')) return;
                // All generated files are siblings in dist/. Native imports must
                // retain their original target for both global and user installs.
                return { path: `../${relativePath}`, external: true };
            });
        },
    }],
});
const outputs = new Map(result.outputFiles.map(file => [path.basename(file.path), file.contents]));
outputs.set('style.css', Buffer.from(await compactCss(path.join(root, 'style.css'))));
if (analyze) {
    for (const [name, output] of Object.entries(result.metafile.outputs)) {
        console.log(name, output.bytes, output.imports.map(({ kind, path }) => ({ kind, path })));
        console.log(Object.entries(output.inputs).sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput));
    }
}
const existing = await readdir(outputDirectory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
});
if (check) {
    for (const [name, contents] of outputs) {
        const actual = await readFile(path.join(outputDirectory, name)).catch(() => null);
        if (!actual || !actual.equals(Buffer.from(contents))) throw new Error(`Stale client bundle: dist/${name}; run npm run build`);
    }
    const extra = existing.filter(name => name.endsWith('.js') && !outputs.has(name));
    if (extra.length) throw new Error(`Stale client chunks: ${extra.join(', ')}`);
} else {
    await mkdir(outputDirectory, { recursive: true });
    for (const [name, contents] of outputs) await writeFile(path.join(outputDirectory, name), contents);
    for (const name of existing) {
        if (name.endsWith('.js') && !outputs.has(name)) await unlink(path.join(outputDirectory, name));
    }
}
for (const [name, contents] of outputs) console.log(`${check ? 'Verified' : 'Built'} dist/${name}: ${contents.byteLength} bytes`);
