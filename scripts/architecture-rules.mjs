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
  `${modules}orders/statusPolicy.ts`, `${modules}merchantFinance/settlementPolicy.ts`,
  `${modules}catalog/offerPolicy.ts`, `${lib}paginationPolicy.ts`, `${lib}businessTime.ts`,
])
const pureDependencies = new Set([...pureRules, `${lib}httpError.ts`, `${lib}businessRegistry.ts`])
// Provider-neutral core: reaches fulfillment providers only through the registry
// (server/src/bootstrap/extensions.ts is the composition root).
const providerNeutral = [
  'server/src/extension-contracts/', `${modules}fulfillment/`, `${modules}orders/fulfillment.ts`,
  `${modules}admin/orderAdmin.ts`, `${modules}merchant/orderService.ts`,
  `${modules}orders/service.ts`, `${modules}orders/cancellation.ts`, `${modules}checkout/service.ts`,
]
const providerImplementations = [
  `${modules}fakaBridge/`, `${modules}trafficReset/`, `${modules}xboardAccounts/`, `${lib}fakaBridge/`,
  'server/src/plugins/',
]

function resolveSource(file, specifier, sources) {
  if (!specifier.startsWith('.')) return null
  const base = path.normalize(path.join(path.dirname(file), specifier)).replace(/\.(?:js|mjs|cjs)$/, '')
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(target => sources.has(target)) ?? `${base}.ts`
}


// wallet is the single writer of real balances, lots, allocations and PointLog
// rows; the dev seed is not financial history and is the only exception.
const walletWrites = /\.pointLog\.create(?:Many)?\(|\.pointAccount\.(?:update|updateMany|upsert)\(|UPDATE\s+"PointAccount"|\.pointLot\.(?:create|update|delete)|\.walletAllocation\.(?:create|update|delete)|\.walletOperation\.(?:create|update|delete)/
const walletOwners = [`${modules}wallet/`, 'server/src/prisma/seed.ts']

// AG-01: Prisma compiles a filtered relation _count into a GROUP BY over the
// whole related table (seq scan per read); count with an id-scoped groupBy.
const filteredRelationCount = /_count:\s*\{\s*select:\s*\{\s*\w+:\s*\{\s*where\b/

// AG-02: calendar math goes through lib/businessTime; production does not set TZ.
const hostLocalDateMethods = new Set([
  'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours',
  'setFullYear', 'setMonth', 'setDate', 'setHours', 'getTimezoneOffset', 'toDateString', 'toTimeString',
])
const localeDateMethods = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'])
const businessTimeOwner = `${lib}businessTime.ts`

// AG-03: interval loops are leased (lib/cronLease, lib/leasedCron) or claim rows
// themselves. These row-claim owners existed on 2026-11-23; new entries need review.
const intervalLeaseImport = /(?:lib|\.)\/(?:cronLease|leasedCron)\.js['"]/
const rowClaimIntervalOwners = new Set([
  `${lib}cronLease.ts`, // owns the lease heartbeat timer
  `${modules}adminExports/service.ts`, // export jobs claim rows with leaseToken
  `${modules}fakaBridge/worker.ts`, // provision tasks claim rows with leaseToken
  `${modules}fulfillment/jobProvider.ts`, // locks Order, then leases FulfillmentJob
  `${modules}orders/provisionCron.ts`, // FOR UPDATE SKIP LOCKED
  `${modules}payment/workers/index.ts`, // lease-conditioned UPDATE … RETURNING
  `${modules}xboardAccounts/cron.ts`, // backfill.ts acquires the cron lease
  `${modules}notifications/realtime/hub.ts`, // SSE heartbeat, no business writes
])

// AG-05: module-level static runtime import cycles as of 2026-11-23. Cycles may
// only shrink; shrink this baseline when a decoupling lands.
const moduleCycleBaseline = [
  ['accountGovernance', 'adminAuthorization', 'adminExports', 'auth', 'catalog', 'checkout', 'fakaBridge',
    'fulfillment', 'governance', 'invite', 'merchant', 'merchantFinance', 'merchantGovernance', 'orders', 'points',
    'portable-backups', 'productVideos', 'trafficReset', 'valuePolicy', 'wallet', 'xboardAccounts'],
  ['payment', 'recharge'],
].map(members => new Set(members))

function lineOf(ast, node) {
  return ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
}

function checkHostLocalDates(file, ast, failures) {
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const zoned = node.arguments.some(arg => ts.isObjectLiteralExpression(arg)
        && arg.properties.some(property => property.name && ts.isIdentifier(property.name) && property.name.text === 'timeZone'))
      if (hostLocalDateMethods.has(method) || (localeDateMethods.has(method) && !zoned)) {
        failures.push(`${file}:${lineOf(ast, node)} AG-02 host-local date API ${method}(); use lib/businessTime or pass timeZone`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
}

function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
}

function checkControllerAwaits(file, ast, failures) {
  const handlers = []
  for (const statement of ast.statements) {
    if (!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    if (ts.isFunctionDeclaration(statement)) handlers.push(statement)
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && isFunctionLike(declaration.initializer)) handlers.push(declaration.initializer)
      }
    }
  }
  for (const handler of handlers) {
    if (!handler.body || !handler.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) continue
    // A nested function owns its own awaits; only the handler's rejection path matters here.
    const visit = (node, guarded) => {
      if (node !== handler.body && isFunctionLike(node)) return
      if (ts.isAwaitExpression(node) && !guarded) {
        failures.push(`${file}:${lineOf(ast, node)} AG-04 await outside try/catch in an async handler; errors must reach next(err)`)
      }
      if (ts.isTryStatement(node) && node.catchClause) {
        visit(node.tryBlock, true)
        visit(node.catchClause, true)
        if (node.finallyBlock) visit(node.finallyBlock, guarded)
        return
      }
      ts.forEachChild(node, child => visit(child, guarded))
    }
    visit(handler.body, false)
  }
}

function moduleOf(file) {
  return file.startsWith(modules) ? file.slice(modules.length).split('/')[0] : null
}

function stronglyConnected(graph) {
  const indices = new Map(), low = new Map(), stack = [], active = new Set(), components = []
  function visit(node) {
    indices.set(node, indices.size)
    low.set(node, indices.get(node))
    stack.push(node)
    active.add(node)
    for (const target of graph.get(node)) {
      if (!indices.has(target)) { visit(target); low.set(node, Math.min(low.get(node), low.get(target))) }
      else if (active.has(target)) low.set(node, Math.min(low.get(node), indices.get(target)))
    }
    if (low.get(node) !== indices.get(node)) return
    const component = []
    let member
    do { member = stack.pop(); active.delete(member); component.push(member) } while (member !== node)
    components.push(component)
  }
  for (const node of graph.keys()) if (!indices.has(node)) visit(node)
  return components
}

export function checkBoundaries(sources) {
  const failures = []
  const graph = new Map([...sources.keys()].map(file => [file, []]))
  const moduleGraph = new Map()
  for (const [file, source] of sources) {
    if (file.startsWith('server/src/') && !walletOwners.some(owner => file.startsWith(owner)) && walletWrites.test(source)) {
      failures.push(`${file} writes point balances or ledger rows outside wallet`)
    }
    if (file.startsWith('server/src/')) {
      if (filteredRelationCount.test(source)) {
        failures.push(`${file} AG-01 filtered relation _count compiles to a whole-table GROUP BY; use lib/inventoryCounts or an id-scoped groupBy`)
      }
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
      if (file !== businessTimeOwner) checkHostLocalDates(file, ast, failures)
      if (/\bsetInterval\(/.test(source) && !intervalLeaseImport.test(source) && !rowClaimIntervalOwners.has(file)) {
        failures.push(`${file} AG-03 setInterval without cron lease; use lib/leasedCron (or claim rows with a lease token)`)
      }
      if (/ontroller[^/]*\.ts$/.test(file)) checkControllerAwaits(file, ast, failures)
    }
    const fromModule = moduleOf(file)
    if (fromModule && !moduleGraph.has(fromModule)) moduleGraph.set(fromModule, new Set())
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
      // Shared product definitions live in lib/productCatalog; the write side must
      // not reach back into the public read module.
      if (dependency.runtime && file.startsWith(`${modules}catalog/`)
        && target.startsWith(`${modules}products/`)) fail('catalog must not import the products read module')
      // Chat binding mounts its own routes from app.ts; points stays independent of the bot channel.
      if (file.startsWith(`${modules}points/`) && target.startsWith(`${modules}chatbot/`)) fail('points must not import chatbot')
      for (const facade of facades) {
        const controller = path.join(path.dirname(facade), facade.endsWith('/adminService.ts') ? 'adminController.ts' : 'controller.ts')
        if (file !== controller && file.startsWith(path.dirname(facade) + '/') && target === facade) fail('implementation imports its own public service facade')
      }
      if (pureRules.has(file) && dependency.runtime && !pureDependencies.has(target)) fail('pure rules must not import workflows or database modules')
      if (providerNeutral.some(prefix => file.startsWith(prefix))
        && providerImplementations.some(prefix => target.startsWith(prefix))) fail('provider-neutral core imports a fulfillment provider')
      if (dependency.runtime && !dependency.dynamic && sources.has(target)) {
        graph.get(file).push(target)
        const toModule = moduleOf(target)
        if (fromModule && toModule && toModule !== fromModule) moduleGraph.get(fromModule).add(toModule)
      }
    }
  }

  // Strongly connected components detect static initialization cycles. A lazy
  // import inside a use case is checked for boundaries, but is not a static edge.
  for (const component of stronglyConnected(graph)) {
    if (component.length > 1 || graph.get(component[0]).includes(component[0])) {
      failures.push(`Static runtime dependency cycle: ${component.sort().join(', ')}`)
    }
  }
  for (const node of moduleGraph.keys()) moduleGraph.set(node, [...moduleGraph.get(node)].filter(target => moduleGraph.has(target)))
  for (const component of stronglyConnected(moduleGraph)) {
    if (component.length < 2 || moduleCycleBaseline.some(baseline => component.every(member => baseline.has(member)))) continue
    failures.push(`AG-05 module dependency cycle grew: ${component.sort().join(', ')}`)
  }
  return failures
}
