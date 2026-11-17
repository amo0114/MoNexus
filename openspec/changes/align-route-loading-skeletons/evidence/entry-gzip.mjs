// Entry-chunk size for one build: the script referenced by dist/index.html,
// gzipped with Node zlib at level 9. Run from the repository root after
// `npm run build`, once per revision, in the same Node/npm environment.
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const html = readFileSync('dist/index.html', 'utf8')
const entry = html.match(/<script[^>]+src="\/(assets\/index-[^"]+\.js)"/)?.[1]
if (!entry) throw new Error('entry script not found in dist/index.html')
const raw = readFileSync(`dist/${entry}`)
console.log(JSON.stringify({ entry, rawBytes: raw.length, gzipLevel9Bytes: gzipSync(raw, { level: 9 }).length }))
