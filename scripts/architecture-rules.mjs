import { posix as path } from 'node:path'
import ts from 'typescript'

/** Parse module syntax, excluding type-only edges from the runtime graph. */
export function readDependencies(source, filename = 'source.ts') {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const dependencies = []
  const add = (node, specifier, runtime, dynamic = false) => dependencies.push({
    specifier, runtime, dynamic,
    line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
  })
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      const named = clause?.namedBindings
      const onlyNamedTypes = !clause?.name && named && ts.isNamedImports(named)
        && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly)
      add(node, node.moduleSpecifier.text, !clause?.isTypeOnly && !onlyNamedTypes)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.exportClause
      const onlyNamedTypes = named && ts.isNamedExports(named) && named.elements.length > 0
        && named.elements.every(element => element.isTypeOnly)
      add(node, node.moduleSpecifier.text, !node.isTypeOnly && !onlyNamedTypes)
    } else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0].text, true, true)
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node, node.arguments[0].text, true)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return dependencies
}

const modules = 'server/src/modules/'
const lib = 'server/src/lib/'
const facades = ['admin', 'merchant', 'auth', 'recharge', 'fakaBridge'].map(name => `${modules}${name}/service.ts`)
facades.push(`${modules}recharge/adminService.ts`)
const pureRules = new Set([
  `${modules}orders/statusPolicy.ts`, `${modules}orders/settlementPolicy.ts`,
  `${modules}catalog/offerPolicy.ts`, `${lib}paginationPolicy.ts`, `${lib}businessTime.ts`,
])
const pureDependencies = new Set([...pureRules, `${lib}httpError.ts`, `${lib}businessRegistry.ts`])

function resolveSource(file, specifier, sources) {
  if (!specifier.startsWith('.')) return null
  const base = path.normalize(path.join(path.dirname(file), specifier)).replace(/\.(?:js|mjs|cjs)$/, '')
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(target => sources.has(target)) ?? `${base}.ts`
}

export function checkBoundaries(sources) {
  const failures = []
  const graph = new Map([...sources.keys()].map(file => [file, []]))
  for (const [file, source] of sources) {
    for (const dependency of readDependencies(source, file)) {
      const target = resolveSource(file, dependency.specifier, sources)
      const fail = message => failures.push(`${file}:${dependency.line} ${message}: ${dependency.specifier}`)
      if (!target) {
        if (pureRules.has(file) && dependency.runtime && !dependency.specifier.startsWith('node:')) fail('pure rules must not import runtime packages')
        continue
      }
      if (file.startsWith(lib) && target.startsWith(modules)) fail('infrastructure must not import business modules')
      if (file.startsWith(modules) && !file.startsWith(`${modules}admin/`) && target.startsWith(`${modules}admin/`)) fail('imports admin internals')
      if (file.startsWith(modules) && !file.startsWith(`${modules}merchant/`)
        && target.startsWith(`${modules}merchant/`) && target !== `${modules}merchant/identity.ts`) fail('imports merchant self-service internals')
      for (const facade of facades) {
        const controller = path.join(path.dirname(facade), facade.endsWith('/adminService.ts') ? 'adminController.ts' : 'controller.ts')
        if (file !== controller && file.startsWith(path.dirname(facade) + '/') && target === facade) fail('implementation imports its own public service facade')
      }
      if (pureRules.has(file) && dependency.runtime && !pureDependencies.has(target)) fail('pure rules must not import workflows or database modules')
      if (dependency.runtime && !dependency.dynamic && sources.has(target)) graph.get(file).push(target)
    }
  }

  // Strongly connected components detect static initialization cycles. A lazy
  // import inside a use case is checked for boundaries, but is not a static edge.
  const indices = new Map(), low = new Map(), stack = [], active = new Set()
  function visit(file) {
    indices.set(file, indices.size)
    low.set(file, indices.get(file))
    stack.push(file)
    active.add(file)
    for (const target of graph.get(file)) {
      if (!indices.has(target)) { visit(target); low.set(file, Math.min(low.get(file), low.get(target))) }
      else if (active.has(target)) low.set(file, Math.min(low.get(file), indices.get(target)))
    }
    if (low.get(file) !== indices.get(file)) return
    const component = []
    let member
    do { member = stack.pop(); active.delete(member); component.push(member) } while (member !== file)
    if (component.length > 1 || graph.get(file).includes(file)) failures.push(`Static runtime dependency cycle: ${component.sort().join(', ')}`)
  }
  for (const file of graph.keys()) if (!indices.has(file)) visit(file)
  return failures
}
