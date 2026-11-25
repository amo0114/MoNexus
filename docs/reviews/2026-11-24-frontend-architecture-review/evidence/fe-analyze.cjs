const S = process.argv[2]
const r = require(S + '/fe.json')
const F = r.files
const prod = Object.keys(F).filter((f) => !F[f].test)
const prodSet = new Set(prod)
const E = r.edges.filter((e) => prodSet.has(e.from) && prodSet.has(e.to))
const top = (f) => f.split('/').length === 2 ? 'src(root)' : f.split('/')[1]
const p = (...a) => console.log(...a)

p('## size by top dir (prod)')
const byTop = {}
for (const f of prod) { const t = top(f); byTop[t] ??= { files: 0, loc: 0 }; byTop[t].files++; byTop[t].loc += F[f].loc }
p(Object.entries(byTop).sort((a, b) => b[1].loc - a[1].loc).map(([k, v]) => `${k}: ${v.files} files / ${v.loc} loc`).join('\n'))

p('\n## top-level dir dependency matrix (runtime edges, count)')
const m = {}
for (const e of E) { if (e.typeOnly) continue; const a = top(e.from), b = top(e.to); if (a === b) continue; m[a + ' -> ' + b] = (m[a + ' -> ' + b] || 0) + 1 }
p(Object.entries(m).sort().map(([k, v]) => `${k}: ${v}`).join('\n'))

p('\n## type-only cross-dir edges')
const mt = {}
for (const e of E) { if (!e.typeOnly) continue; const a = top(e.from), b = top(e.to); if (a === b) continue; mt[a + ' -> ' + b] = (mt[a + ' -> ' + b] || 0) + 1 }
p(Object.entries(mt).sort().map(([k, v]) => `${k}: ${v}`).join('\n'))

// suspicious directions
const rank = { types: 0, utils: 1, data: 1, lib: 2, api: 3, auth: 3, realtime: 4, stores: 4, hooks: 5, extensions: 6, components: 6, pages: 7, 'src(root)': 8, styles: 0, assets: 0 }
p('\n## upward edges (lower layer importing higher layer), runtime+type')
const up = {}
for (const e of E) { const a = top(e.from), b = top(e.to); if (a === b) continue; if ((rank[a] ?? 9) < (rank[b] ?? 9)) { const k = `${a} -> ${b}`; (up[k] ??= []).push(`${e.from} -> ${e.to}${e.typeOnly ? ' (type)' : ''}`) } }
for (const [k, v] of Object.entries(up)) { p(`${k}: ${v.length}`); v.slice(0, 8).forEach((x) => p('   ' + x)) }

p('\n## components -> pages and pages -> pages (other page dir)')
for (const e of E) {
  if (e.from.startsWith('src/components/') && e.to.startsWith('src/pages/')) p('  C->P', e.from, '->', e.to, e.typeOnly ? '(type)' : '')
}
let pp = 0
for (const e of E) {
  if (e.from.startsWith('src/pages/') && e.to.startsWith('src/pages/') && F[e.from].layer !== F[e.to].layer && !e.dynamic) { pp++; if (pp <= 15) p('  P->P', e.from, '->', e.to, e.typeOnly ? '(type)' : '') }
}
p('  page->other-page-dir edges', pp)

p('\n## cross-domain component edges (components/X -> components/Y, X!=Y, Y not ui)')
const cd = {}
for (const e of E) {
  const a = F[e.from].layer, b = F[e.to].layer
  if (a.startsWith('components/') && b.startsWith('components/') && a !== b && b !== 'components/ui' && b !== 'components/(root)') cd[a + ' -> ' + b] = (cd[a + ' -> ' + b] || 0) + 1
}
p(Object.entries(cd).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}: ${v}`).join('\n'))

// SCC on runtime non-dynamic edges
const adj = {}
for (const f of prod) adj[f] = []
for (const e of E) if (!e.typeOnly && !e.dynamic) adj[e.from].push(e.to)
let idx = 0; const st = []; const on = new Set(); const ix = {}; const low = {}; const sccs = []
function sc(v) { ix[v] = low[v] = idx++; st.push(v); on.add(v); for (const w of adj[v]) { if (ix[w] === undefined) { sc(w); low[v] = Math.min(low[v], low[w]) } else if (on.has(w)) low[v] = Math.min(low[v], ix[w]) } if (low[v] === ix[v]) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w) } while (w !== v); if (c.length > 1) sccs.push(c) } }
for (const f of prod) if (ix[f] === undefined) sc(f)
p('\n## file-level import cycles (runtime static):', sccs.length)
sccs.sort((a, b) => b.length - a.length).forEach((c) => p(`  [${c.length}] ` + c.slice(0, 12).join(', ')))

p('\n## fan-in top 20 (prod importers)')
const fin = {}
for (const e of E) fin[e.to] = (fin[e.to] || 0) + 1
Object.entries(fin).sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, v]) => p(`  ${v}  ${k}  (${F[k].loc} loc)`))
p('\n## fan-out top 15')
const fout = {}
for (const e of E) fout[e.from] = (fout[e.from] || 0) + 1
Object.entries(fout).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => p(`  ${v}  ${k}  (${F[k].loc} loc)`))

p('\n## largest prod files')
prod.sort((a, b) => F[b].loc - F[a].loc).slice(0, 30).forEach((f) => p(`  ${F[f].loc}  ${f}  useState=${F[f].useState} useEffect=${F[f].useEffect}`))
const over = (n) => prod.filter((f) => F[f].loc > n).length
p(`  files >300: ${over(300)}  >500: ${over(500)}  >800: ${over(800)}  total prod: ${prod.length}`)

p('\n## most useState per file')
prod.sort((a, b) => F[b].useState - F[a].useState).slice(0, 15).forEach((f) => p(`  ${F[f].useState} state / ${F[f].useEffect} effects  ${f}`))

p('\n## longest / most complex functions')
const fns = []
for (const f of prod) for (const fn of F[f].fns) fns.push({ f, ...fn })
fns.sort((a, b) => b.len - a.len).slice(0, 20).forEach((x) => p(`  len=${x.len} cc=${x.cc}  ${x.f}:${x.line} ${x.name}`))
p('  by cc:')
fns.sort((a, b) => b.cc - a.cc).slice(0, 15).forEach((x) => p(`  cc=${x.cc} len=${x.len}  ${x.f}:${x.line} ${x.name}`))
p(`  functions len>=150: ${fns.filter((x) => x.len >= 150).length}, cc>=30: ${fns.filter((x) => x.cc >= 30).length}`)

p('\n## type-safety & escape hatches (prod)')
const sum = (k) => prod.reduce((s, f) => s + F[f][k], 0)
p(`  any=${sum('anyCount')} as=${sum('asCount')} nonNull=${sum('nonNull')} tsIgnore=${sum('tsIgnore')} eslintDisable=${sum('eslintDisable')}`)
p('  top as-cast files:', prod.sort((a, b) => F[b].asCount - F[a].asCount).slice(0, 8).map((f) => `${f}(${F[f].asCount})`).join(', '))
p('  axios imported outside api/client:', prod.filter((f) => F[f].axiosImport && f !== 'src/api/client.ts').join(', '))
p('  fetch() callers:', prod.filter((f) => F[f].fetchCall).join(', '))
p('  storage callers:', prod.filter((f) => F[f].storageCall).length, prod.filter((f) => F[f].storageCall).slice(0, 25).join(', '))

p('\n## who imports api/ (by importer top dir)')
const apiUse = {}
for (const e of E) if (e.to.startsWith('src/api/') && !e.typeOnly) { const k = F[e.from].layer; apiUse[k] = (apiUse[k] || 0) + 1 }
p(Object.entries(apiUse).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(', '))

p('\n## test coverage by dir (test files / prod files)')
const tests = Object.keys(F).filter((f) => F[f].test)
const tcount = {}
for (const f of tests) { const k = top(f); tcount[k] = (tcount[k] || 0) + 1 }
p(Object.keys(byTop).map((k) => `${k}: ${tcount[k] || 0}/${byTop[k].files}`).join(', '), `| total tests ${tests.length}`)
const untestedBig = prod.filter((f) => F[f].loc > 400 && !tests.some((t) => t.replace(/\.test\.tsx?$/, '').replace('/__tests__', '') === f.replace(/\.tsx?$/, '')))
p('  >400 loc prod files without same-name test:', untestedBig.length, '/', prod.filter((f) => F[f].loc > 400).length)
