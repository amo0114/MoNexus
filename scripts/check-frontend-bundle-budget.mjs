import { readFile, readdir } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const gzip = promisify(createGzip);
const root = process.cwd();
const config = JSON.parse(await readFile(resolve(root, 'config/frontend-bundle-budget.json'), 'utf8'));
const dist = resolve(root, 'dist/assets');
const entries = await readdir(dist, { withFileTypes: true });
const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
if (files.length === 0) throw new Error(`No emitted assets found in ${dist}; run npm run build first`);
let compressedBytes = 0;
for (const name of files) compressedBytes += (await gzip(await readFile(resolve(dist, name)), { level: 9 })).length;
const kib = compressedBytes / 1024;
const limit = Number(config.max_gzip_kib);
console.log(JSON.stringify({ scope: config.scope, files: files.length, gzip_kib: Number(kib.toFixed(2)), max_gzip_kib: limit }));
if (kib > limit) {
  console.error(`Frontend bundle budget exceeded: ${kib.toFixed(2)} KiB gzip > ${limit} KiB`);
  process.exit(1);
}
console.log('Frontend bundle budget: PASS');
