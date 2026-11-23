import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv from 'ajv'
import { expect } from 'vitest'
import type { Response } from 'supertest'

// AG-09: validate real responses against the hand-written OpenAPI document so
// either side drifting fails a test instead of a client.
const spec = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../docs/superpowers/specs/monexus-api-openapi.json', import.meta.url)),
  'utf8',
)) as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> }

// OpenAPI 3.0 allows `nullable` beside $ref/allOf, which Ajv only accepts next
// to `type`; express those as JSON Schema `anyOf [schema, null]`.
function normalizeNullable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeNullable)
  if (!node || typeof node !== 'object') return node
  const { nullable, ...rest } = node as Record<string, unknown>
  const normalized = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, normalizeNullable(value)]))
  if (nullable !== true || 'type' in rest) return nullable === true ? { ...normalized, nullable } : normalized
  return { anyOf: [normalized, { type: 'null' }] }
}

// OpenAPI 3.0 schema objects carry doc-only keywords (example, deprecated, …)
// and formats Ajv does not ship; neither changes the shape being checked.
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false })
ajv.addSchema(normalizeNullable(spec) as object, 'openapi')

const pointer = (...segments: string[]) => segments.map(s => s.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')

export function expectOpenApiResponse(res: Response, method: string, pathTemplate: string) {
  const operation = spec.paths[pathTemplate]?.[method.toLowerCase()]
  expect(operation, `OpenAPI documents ${method} ${pathTemplate}`).toBeDefined()
  const status = String(res.status)
  let response = operation!.responses[status] as { $ref?: string; content?: Record<string, unknown> } | undefined
  expect(response, `OpenAPI documents ${status} for ${method} ${pathTemplate}`).toBeDefined()
  let ref = `#/${pointer('paths', pathTemplate, method.toLowerCase(), 'responses', status)}`
  if (response!.$ref) {
    ref = response!.$ref
    response = ref.slice(2).split('/').reduce<any>((node, key) => node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], spec)
  }
  expect(response?.content?.['application/json'], `${method} ${pathTemplate} ${status} has a JSON schema`).toBeDefined()
  const validate = ajv.getSchema(`openapi${ref}/content/application~1json/schema`)
  expect(validate, 'schema compiles').toBeDefined()
  const valid = validate!(res.body)
  expect(valid, `${method} ${pathTemplate} ${status}: ${ajv.errorsText(validate!.errors, { separator: '\n' })}`).toBe(true)
}
