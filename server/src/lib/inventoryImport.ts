import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from './prisma.js'
import { badRequest } from './httpError.js'
import {
  canonicalDeliveryText,
  parseStructuredImportRow,
  type DeliveryField,
  type StructuredDeliveryContent,
} from './deliveryFields.js'

/**
 * 卡密/账号类库存的导入边界。
 *
 * 限制必须同时在路由层与领域服务层生效：前者避免无效的大请求进入
 * 业务逻辑，后者保证其他调用方（预览、管理员、未来的任务脚本）不会
 * 绕过限制。
 */
export const INVENTORY_IMPORT_MAX_ROWS = 1_000
export const INVENTORY_IMPORT_MAX_ITEM_LENGTH = 5_000
export const INVENTORY_IMPORT_MAX_TOTAL_LENGTH = 500_000

export interface InventoryImportPayload {
  text?: string
  items?: string[]
}

export type InventoryImportAnalysis = {
  totalRows: number
  validRows: number
  emptyRows: number
  duplicateRows: number
  existingDuplicateRows: number
  canImport: boolean
  itemsToImport: string[]
}

type InventoryClient = typeof prisma | Prisma.TransactionClient

export function inventoryRowsFromPayload(payload: InventoryImportPayload) {
  const rows: string[] = []
  if (typeof payload.text === 'string') rows.push(...payload.text.split(/\r?\n/))
  if (Array.isArray(payload.items)) rows.push(...payload.items)
  return rows
}

export function validateInventoryImportLimits(payload: InventoryImportPayload) {
  const rows = inventoryRowsFromPayload(payload)
  if (rows.length > INVENTORY_IMPORT_MAX_ROWS) {
    throw badRequest(`单次最多导入 ${INVENTORY_IMPORT_MAX_ROWS} 条库存`)
  }

  let totalLength = 0
  for (const row of rows) {
    if (row.length > INVENTORY_IMPORT_MAX_ITEM_LENGTH) {
      throw badRequest(`单条库存内容不能超过 ${INVENTORY_IMPORT_MAX_ITEM_LENGTH} 个字符`)
    }
    totalLength += row.length
  }
  if (totalLength > INVENTORY_IMPORT_MAX_TOTAL_LENGTH) {
    throw badRequest(`单次库存内容总长度不能超过 ${INVENTORY_IMPORT_MAX_TOTAL_LENGTH} 个字符`)
  }
}

export async function analyzeInventoryImport(
  productId: number,
  payload: InventoryImportPayload,
  client: InventoryClient = prisma
): Promise<InventoryImportAnalysis> {
  validateInventoryImportLimits(payload)

  const rows = inventoryRowsFromPayload(payload)
  const seen = new Set<string>()
  const uniqueRows: string[] = []
  let emptyRows = 0
  let duplicateRows = 0

  for (const row of rows) {
    const normalized = row.trim()
    if (!normalized) {
      emptyRows += 1
      continue
    }
    if (seen.has(normalized)) {
      duplicateRows += 1
      continue
    }
    seen.add(normalized)
    uniqueRows.push(normalized)
  }

  const existingRows = uniqueRows.length > 0
    ? await client.inventoryItem.findMany({
        where: { productId, content: { in: uniqueRows } },
        select: { content: true },
      })
    : []
  const existingContents = new Set(existingRows.map(row => row.content))
  const itemsToImport = uniqueRows.filter(row => !existingContents.has(row))

  return {
    totalRows: rows.length,
    validRows: itemsToImport.length,
    emptyRows,
    duplicateRows,
    existingDuplicateRows: existingContents.size,
    canImport: itemsToImport.length > 0 && duplicateRows === 0 && existingContents.size === 0,
    itemsToImport,
  }
}

// ---- P4b：结构化导入（规格带交付字段模板时） ----

export type StructuredImportItem = {
  /** 规范化纯文本（权威形态；唯一约束与领取 SQL 作用于它）。 */
  content: string
  structuredContent: StructuredDeliveryContent
}

export type StructuredInventoryImportAnalysis = {
  totalRows: number
  validRows: number
  emptyRows: number
  duplicateRows: number
  existingDuplicateRows: number
  /** 行级解析错误（row 为 1 起的原始行号，含空行计数）。 */
  rowErrors: Array<{ row: number; message: string }>
  canImport: boolean
  itemsToImport: StructuredImportItem[]
}

/**
 * 模板化导入分析：每行按 `|` 分隔映射模板字段（\| 转义字面竖线）。
 * 去重仍作用于规范化文本——与纯文本导入共用同一唯一性语义。
 */
export async function analyzeStructuredInventoryImport(
  productId: number,
  payload: InventoryImportPayload,
  fields: DeliveryField[],
  client: InventoryClient = prisma
): Promise<StructuredInventoryImportAnalysis> {
  validateInventoryImportLimits(payload)

  const rows = inventoryRowsFromPayload(payload)
  const seen = new Set<string>()
  const parsed: StructuredImportItem[] = []
  const rowErrors: Array<{ row: number; message: string }> = []
  let emptyRows = 0
  let duplicateRows = 0

  for (const [index, row] of rows.entries()) {
    if (!row.trim()) {
      emptyRows += 1
      continue
    }
    const result = parseStructuredImportRow(fields, row)
    if ('error' in result) {
      rowErrors.push({ row: index + 1, message: result.error })
      continue
    }
    const content = canonicalDeliveryText(fields, result.values)
    if (seen.has(content)) {
      duplicateRows += 1
      continue
    }
    seen.add(content)
    parsed.push({ content, structuredContent: { fields, values: result.values } })
  }

  const contents = parsed.map(item => item.content)
  const existingRows = contents.length > 0
    ? await client.inventoryItem.findMany({
        where: { productId, content: { in: contents } },
        select: { content: true },
      })
    : []
  const existingContents = new Set(existingRows.map(row => row.content))
  const itemsToImport = parsed.filter(item => !existingContents.has(item.content))

  return {
    totalRows: rows.length,
    validRows: itemsToImport.length,
    emptyRows,
    duplicateRows,
    existingDuplicateRows: existingContents.size,
    rowErrors,
    canImport:
      itemsToImport.length > 0 &&
      duplicateRows === 0 &&
      existingContents.size === 0 &&
      rowErrors.length === 0,
    itemsToImport,
  }
}

export function duplicateInventoryImportDetails(
  analysis: Pick<InventoryImportAnalysis, 'duplicateRows' | 'existingDuplicateRows'>
) {
  return [
    { field: 'items', message: `duplicateRows=${analysis.duplicateRows}` },
    { field: 'items', message: `existingDuplicateRows=${analysis.existingDuplicateRows}` },
  ]
}

export function isInventoryContentUniqueViolation(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false

  const target = error.meta?.target
  const targetColumns = Array.isArray(target) ? target.map(String) : [String(target ?? '')]
  return targetColumns.includes('productId') && targetColumns.includes('content')
}

/** Shared API schema. Empty lines are intentionally accepted then ignored by analysis. */
export const inventoryImportPayloadSchema = z.object({
  text: z.string().max(INVENTORY_IMPORT_MAX_TOTAL_LENGTH).optional(),
  items: z.array(z.string().max(INVENTORY_IMPORT_MAX_ITEM_LENGTH))
    .max(INVENTORY_IMPORT_MAX_ROWS)
    .optional(),
}).superRefine((payload, ctx) => {
  if (typeof payload.text !== 'string' && !Array.isArray(payload.items)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '请提供库存文本或库存数组' })
    return
  }

  const rows = inventoryRowsFromPayload(payload)
  if (rows.length > INVENTORY_IMPORT_MAX_ROWS) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_big,
      type: 'array',
      maximum: INVENTORY_IMPORT_MAX_ROWS,
      inclusive: true,
      path: ['items'],
      message: `单次最多导入 ${INVENTORY_IMPORT_MAX_ROWS} 条库存`,
    })
  }

  const totalLength = rows.reduce((sum, row) => sum + row.length, 0)
  if (totalLength > INVENTORY_IMPORT_MAX_TOTAL_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_big,
      type: 'string',
      maximum: INVENTORY_IMPORT_MAX_TOTAL_LENGTH,
      inclusive: true,
      message: `单次库存内容总长度不能超过 ${INVENTORY_IMPORT_MAX_TOTAL_LENGTH} 个字符`,
    })
  }
})
