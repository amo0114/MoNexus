import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import {
  TEMPLATE_KEYS,
  type AttributeFieldError,
  type TemplateAttributes,
  type TemplateKey,
} from './types.js'

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  // Schemas are compiled from the frozen local registry only. Remote $ref,
  // executable keywords, and JS expressions are not registered.
  loadSchema: undefined,
})

type CompiledPair = {
  publishProduct: ValidateFunction
  draftProduct: ValidateFunction
  publishOffer: ValidateFunction
  draftOffer: ValidateFunction
}

const compiled = new Map<string, CompiledPair>()

function schemaKey(templateKey: TemplateKey, version: number): string {
  return `${templateKey}:${version}`
}

function withoutRootRequired(schema: Record<string, unknown>): Record<string, unknown> {
  const next = { ...schema }
  delete next.required
  if (typeof next.$id === 'string') next.$id = `${next.$id}:draft`
  return next
}

function compilePair(
  templateKey: TemplateKey,
  version: number,
  productSchema: Record<string, unknown>,
  offerSchema: Record<string, unknown>,
): CompiledPair {
  return {
    publishProduct: ajv.compile(productSchema),
    draftProduct: ajv.compile(withoutRootRequired(productSchema)),
    publishOffer: ajv.compile(offerSchema),
    draftOffer: ajv.compile(withoutRootRequired(offerSchema)),
  }
}

export function compileTemplateValidators(templates: Array<{
  key: TemplateKey
  version: number
  productSchema: Record<string, unknown>
  offerSchema: Record<string, unknown>
}>): void {
  compiled.clear()
  for (const template of templates) {
    compiled.set(
      schemaKey(template.key, template.version),
      compilePair(template.key, template.version, template.productSchema, template.offerSchema),
    )
  }
}

function isTemplateKey(value: string): value is TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(value)
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined, pathPrefix: string): AttributeFieldError[] {
  if (!errors || errors.length === 0) {
    return [{ path: pathPrefix, message: '属性校验失败' }]
  }
  return errors.map(error => {
    const instancePath = error.instancePath || ''
    const path = `${pathPrefix}${instancePath}`
    return { path: path || pathPrefix, message: error.message ?? '属性校验失败' }
  })
}

function asAttributeRecord(value: unknown): TemplateAttributes | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null
  const record: TemplateAttributes = {}
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === 'string'
      || typeof entry === 'number'
      || typeof entry === 'boolean'
      || (Array.isArray(entry) && entry.every(item => typeof item === 'string'))
    ) {
      record[key] = entry
    } else {
      return null
    }
  }
  return record
}

export type AttributeValidationMode = 'draft' | 'publish'
export type AttributeTarget = 'product' | 'offer'

export type AttributeValidationResult =
  | { ok: true; value: TemplateAttributes }
  | { ok: false; errors: AttributeFieldError[] }

export function validateTemplateAttributes(input: {
  templateKey: string
  templateVersion: number
  attributes: unknown
  mode: AttributeValidationMode
  target: AttributeTarget
  pathPrefix: string
}): AttributeValidationResult {
  if (!isTemplateKey(input.templateKey) || input.templateVersion !== 1) {
    return {
      ok: false,
      errors: [{ path: input.pathPrefix, message: '未知的商品模板或版本' }],
    }
  }

  const pair = compiled.get(schemaKey(input.templateKey, input.templateVersion))
  if (!pair) {
    return {
      ok: false,
      errors: [{ path: input.pathPrefix, message: '未知的商品模板或版本' }],
    }
  }

  if (input.attributes == null || typeof input.attributes !== 'object' || Array.isArray(input.attributes)) {
    return {
      ok: false,
      errors: [{ path: input.pathPrefix, message: 'attributes 必须是对象' }],
    }
  }

  const validator = input.target === 'product'
    ? (input.mode === 'publish' ? pair.publishProduct : pair.draftProduct)
    : (input.mode === 'publish' ? pair.publishOffer : pair.draftOffer)

  const valid = validator(input.attributes)
  if (!valid) {
    return { ok: false, errors: formatAjvErrors(validator.errors, input.pathPrefix) }
  }

  const value = asAttributeRecord(input.attributes)
  if (!value) {
    return {
      ok: false,
      errors: [{ path: input.pathPrefix, message: 'attributes 包含不支持的值类型' }],
    }
  }
  return { ok: true, value }
}

export function assertTemplateValidatorsReady(): void {
  if (compiled.size === 0) {
    throw new Error('product template validators are not compiled')
  }
}
