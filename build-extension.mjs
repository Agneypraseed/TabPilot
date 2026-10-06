import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

const outputDirectory = join(process.cwd(), 'dist');
await mkdir(outputDirectory, { recursive: true });

await Promise.all([
  build({
    entryPoints: ['sidepanel.js'],
    outfile: join(outputDirectory, 'sidepanel.bundle.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome116'],
    minify: true,
    sourcemap: false,
    legalComments: 'none'
  }),
  build({
    entryPoints: ['lib/local-model-worker.js'],
    outfile: join(outputDirectory, 'local-model-worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome116'],
    minify: true,
    sourcemap: false,
    legalComments: 'none'
  }),
  build({
    entryPoints: ['lib/local-cpu-worker.js'],
    outfile: join(outputDirectory, 'local-cpu-worker.js'),
    bundle: true, format: 'esm', platform: 'browser', target: ['chrome116'],
    minify: true, sourcemap: false, legalComments: 'none'
  })
]);

await mkdir(join(outputDirectory, 'vendor'), { recursive: true });
for (const asset of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.jspi.mjs', 'ort-wasm-simd-threaded.jspi.wasm']) {
  await copyFile(join('node_modules', 'onnxruntime-web', 'dist', asset), join(outputDirectory, 'vendor', asset));
}

await mkdir(join(outputDirectory, 'lib'), { recursive: true });
for (const file of ['manifest.json', 'sidepanel.html', 'sidepanel.css', 'background.js', 'lib/downloads.js']) {
  const target = file.startsWith('lib/') ? join(outputDirectory, 'lib', 'downloads.js') : join(outputDirectory, file);
  await copyFile(file, target);
}

console.log('Built the unpacked Chrome extension in dist/.');
