// One-off frontend metrics: import graph, layering, cycles, complexity.
// Usage: node fe-metrics.cjs <repoRoot> <outJson>
const ts = require(require.resolve('typescript', { paths: [process.argv[2]] }))
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const root = process.argv[2]
const out = process.argv[3]
const files = execSync('git ls-files src', { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => /\.(ts|tsx)$/.test(f))
const isTest = (f) => /\.test\.|\/__tests__\/|^src\/test\//.test(f) || /\.fixtures\.ts$/.test(f)
const fileSet = new Set(files)

function resolve(from, spec) {
  let base
  if (spec.startsWith('@/')) base = path.posix.join('src', spec.slice(2))
  else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
  else return null
  base = base.replace(/\.(js|jsx)$/, '')
  for (const c of [base, base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx']) {
    if (fileSet.has(c)) return c
  }
  if (/\.(css|svg|png|json|webp|jpg)$/.test(spec)) return null
  return 'UNRESOLVED:' + base
}

function layer(f) {
  const p = f.split('/')
  if (p[1] === 'components' || p[1] === 'pages') return p.length > 3 ? `${p[1]}/${p[2]}` : `${p[1]}/(root)`
  if (p.length === 2) return 'src(root)'
  return p[1]
}

const result = { files: {}, edges: [], unresolved: [] }
for (const f of files) {
  const text = fs.readFileSync(path.join(root, f), 'utf8')
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const imports = []
  const fns = []
  let anyCount = 0, asCount = 0, nonNull = 0, useState = 0, useEffect = 0, exportsCount = 0
  let axiosImport = false, fetchCall = 0, storageCall = 0
  const tsIgnore = (text.match(/@ts-(ignore|expect-error|nocheck)/g) || []).length
  const eslintDisable = (text.match(/eslint-disable/g) || []).length

  function complexity(node) {
    let c = 1
    function walk(n) {
      switch (n.kind) {
        case ts.SyntaxKind.IfStatement: case ts.SyntaxKind.ForStatement: case ts.SyntaxKind.ForInStatement:
        case ts.SyntaxKind.ForOfStatement: case ts.SyntaxKind.WhileStatement: case ts.SyntaxKind.DoStatement:
        case ts.SyntaxKind.CaseClause: case ts.SyntaxKind.CatchClause: case ts.SyntaxKind.ConditionalExpression:
          c++; break
        case ts.SyntaxKind.BinaryExpression: {
          const k = n.operatorToken.kind
          if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) c++
        }
      }
      // nested functions are measured separately
      if (n !== node && (ts.isFunctionLike(n))) return
      ts.forEachChild(n, walk)
    }
    walk(node)
    return c
  }

  function visit(n) {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text
      if (spec === 'axios') axiosImport = true
      const typeOnly = ts.isImportDeclaration(n) ? !!(n.importClause && n.importClause.isTypeOnly) : !!n.isTypeOnly
      imports.push({ spec, typeOnly })
    }
    if (ts.isCallExpression(n) && ts.isImportKeyword?.(n.expression) === false) {}
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      imports.push({ spec: n.arguments[0].text, typeOnly: false, dynamic: true })
    }
    if (n.kind === ts.SyntaxKind.AnyKeyword) anyCount++
    if (ts.isAsExpression(n) && !(n.type.kind === ts.SyntaxKind.TypeReference && n.type.getText() === 'const')) asCount++
    if (ts.isNonNullExpression(n)) nonNull++
    if (ts.isCallExpression(n)) {
      const t = n.expression.getText()
      if (/^(React\.)?useState$/.test(t)) useState++
      if (/^(React\.)?use(Layout)?Effect$/.test(t)) useEffect++
      if (t === 'fetch' || t === 'window.fetch') fetchCall++
      if (/(localStorage|sessionStorage)\.(getItem|setItem|removeItem)/.test(t)) storageCall++
    }
    if (ts.canHaveModifiers?.(n) && (ts.getModifiers(n) || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) exportsCount++
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      const start = sf.getLineAndCharacterOfPosition(n.getStart()).line
      const end = sf.getLineAndCharacterOfPosition(n.getEnd()).line
      let name = n.name ? n.name.getText() : ''
      if (!name && n.parent && ts.isVariableDeclaration(n.parent)) name = n.parent.name.getText()
      const len = end - start + 1
      if (len >= 15) fns.push({ name: name || '<anon>', line: start + 1, len, cc: complexity(n) })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)

  const loc = text.split('\n').length
  const resolved = []
  for (const im of imports) {
    const r = resolve(f, im.spec)
    if (r && r.startsWith('UNRESOLVED:')) result.unresolved.push([f, im.spec])
    else if (r) resolved.push({ to: r, typeOnly: im.typeOnly, dynamic: !!im.dynamic })
  }
  result.files[f] = { test: isTest(f), layer: layer(f), loc, anyCount, asCount, nonNull, tsIgnore, eslintDisable, useState, useEffect, exportsCount, axiosImport, fetchCall, storageCall, fns, ext: imports.filter((i) => !i.spec.startsWith('.') && !i.spec.startsWith('@/')).map((i) => i.spec) }
  for (const r of resolved) result.edges.push({ from: f, ...r })
}
fs.writeFileSync(out, JSON.stringify(result))
console.log('files', files.length, 'edges', result.edges.length, 'unresolved', result.unresolved.length)
