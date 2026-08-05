import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { config } from '../../config/index.js'
import { BUILTIN_LEGAL_DOCUMENTS } from './documents.js'

/**
 * SPEC-LEGAL-001：法律文档注册表。
 *
 * 五份文档（terms/privacy/refund/points-rules/about）以结构化草案内置于
 * documents.js，启动时经 zod 校验、slug 唯一性检查、当前版本解析后冻结为
 * 不可变注册表——任何一步失败都直接 throw 使进程无法启动（fail-closed，
 * 宁可拒启也不提供未校验的协议文本）。
 *
 * contentHash 约定：对"公开返回的规范化文档 JSON"（slug/title/version/
 * updatedAt/sections，键序固定）做 sha256（hex, 64）。同意证据表锚定该
 * 哈希，任何人可用公开响应重算验证——文档一字之差哈希即不同。
 */

export const LEGAL_DOCUMENT_SLUGS = ['terms', 'privacy', 'refund', 'points-rules', 'about'] as const
export type LegalDocumentSlug = (typeof LEGAL_DOCUMENT_SLUGS)[number]

export interface LegalSection {
  heading?: string
  paragraphs: string[]
}

export interface LegalDocumentVersion {
  version: string
  updatedAt: string
  sections: LegalSection[]
}

export interface LegalDocumentDefinition {
  slug: LegalDocumentSlug
  title: string
  currentVersion: string
  versions: LegalDocumentVersion[]
}

/** 公开响应形状（含哈希）。GET /api/legal/documents/:slug 的返回体。 */
export interface PublicLegalDocument {
  slug: LegalDocumentSlug
  title: string
  version: string
  updatedAt: string
  contentHash: string
  sections: LegalSection[]
}

export interface LegalDocumentSummary {
  slug: LegalDocumentSlug
  title: string
  version: string
  updatedAt: string
  contentHash: string
}

const legalSectionSchema = z.object({
  heading: z.string().trim().min(1).max(200).optional(),
  paragraphs: z.array(z.string().trim().min(1).max(5000)).min(1).max(50),
}).strict()

const legalDocumentVersionSchema = z.object({
  // 语义化两段式版本（1.0 → 1.1 → 2.0），草案期不引入三段。
  version: z.string().regex(/^\d+\.\d+$/, '版本必须为 MAJOR.MINOR 形式'),
  updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'updatedAt 必须为 YYYY-MM-DD'),
  sections: z.array(legalSectionSchema).min(1).max(100),
}).strict()

const legalDocumentDefinitionSchema = z.object({
  slug: z.enum(LEGAL_DOCUMENT_SLUGS),
  title: z.string().trim().min(1).max(100),
  currentVersion: z.string().regex(/^\d+\.\d+$/),
  versions: z.array(legalDocumentVersionSchema).min(1),
}).strict()

/**
 * 规范化公开载荷：键序固定（slug → title → version → updatedAt →
 * sections），JSON.stringify 按插入序输出，哈希输入因此逐字节确定。
 * 公开响应在此载荷之上仅追加 contentHash 本身。
 */
function canonicalPayload(
  definition: LegalDocumentDefinition,
  version: LegalDocumentVersion,
): string {
  return JSON.stringify({
    slug: definition.slug,
    title: definition.title,
    version: version.version,
    updatedAt: version.updatedAt,
    sections: version.sections,
  })
}

export function computeContentHash(
  definition: LegalDocumentDefinition,
  version: LegalDocumentVersion,
): string {
  return createHash('sha256').update(canonicalPayload(definition, version), 'utf8').digest('hex')
}

interface ResolvedRegistryEntry {
  definition: LegalDocumentDefinition
  byVersion: Map<string, { version: LegalDocumentVersion; contentHash: string }>
}

export interface LegalRegistry {
  entries: ReadonlyMap<LegalDocumentSlug, ResolvedRegistryEntry>
}

/** LEGAL_PAGES_FIXTURE_PATH 覆盖：目录下每份 slug 一个 <slug>.json。 */
function loadFixtureDefinitions(fixturePath: string): LegalDocumentDefinition[] {
  return LEGAL_DOCUMENT_SLUGS.map(slug => {
    const file = path.join(fixturePath, `${slug}.json`)
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      throw new Error(`[Legal] failed to load fixture document ${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
    // fixture 文件可省略 slug（由文件名锚定），其余字段与内置定义同构。
    const withSlug = typeof raw === 'object' && raw !== null ? { slug, ...raw } : raw
    return withSlug as LegalDocumentDefinition
  })
}

function buildRegistry(definitions: LegalDocumentDefinition[]): LegalRegistry {
  const entries = new Map<LegalDocumentSlug, ResolvedRegistryEntry>()

  for (const candidate of definitions) {
    const parsed = legalDocumentDefinitionSchema.safeParse(candidate)
    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      throw new Error(`[Legal] invalid document definition for ${candidate?.slug ?? 'unknown'}: ${issues}`)
    }
    const definition = parsed.data as LegalDocumentDefinition

    if (entries.has(definition.slug)) {
      throw new Error(`[Legal] duplicate document slug: ${definition.slug}`)
    }

    const byVersion = new Map<string, { version: LegalDocumentVersion; contentHash: string }>()
    for (const version of definition.versions) {
      if (byVersion.has(version.version)) {
        throw new Error(`[Legal] duplicate version ${version.version} in ${definition.slug}`)
      }
      byVersion.set(version.version, {
        version,
        contentHash: computeContentHash(definition, version),
      })
    }
    if (!byVersion.has(definition.currentVersion)) {
      throw new Error(`[Legal] currentVersion ${definition.currentVersion} of ${definition.slug} is not in versions[]`)
    }

    entries.set(definition.slug, { definition, byVersion })
  }

  // fail-closed：五份文档缺一不可（fixture 目录漏文件在这里现形）。
  for (const slug of LEGAL_DOCUMENT_SLUGS) {
    if (!entries.has(slug)) {
      throw new Error(`[Legal] missing required document: ${slug}`)
    }
  }

  return { entries }
}

function initRegistry(): LegalRegistry {
  const fixturePath = config.legalPages.fixturePath
  const definitions = fixturePath ? loadFixtureDefinitions(fixturePath) : BUILTIN_LEGAL_DOCUMENTS
  return buildRegistry(definitions)
}

let registry: LegalRegistry = initRegistry()

/** 解析文档版本；slug 或 version 未知返回 null（路由层映射 404）。 */
export function resolveLegalDocument(
  slug: string,
  version?: string,
): PublicLegalDocument | null {
  const entry = registry.entries.get(slug as LegalDocumentSlug)
  if (!entry) return null
  const resolved = entry.byVersion.get(version ?? entry.definition.currentVersion)
  if (!resolved) return null
  return {
    slug: entry.definition.slug,
    title: entry.definition.title,
    version: resolved.version.version,
    updatedAt: resolved.version.updatedAt,
    contentHash: resolved.contentHash,
    sections: resolved.version.sections,
  }
}

/** 全部文档的当前版本摘要（列表/页脚/同意 UI 用）。 */
export function listLegalDocumentSummaries(): LegalDocumentSummary[] {
  return LEGAL_DOCUMENT_SLUGS
    .map(slug => resolveLegalDocument(slug))
    .filter((doc): doc is PublicLegalDocument => doc !== null)
    .map(({ sections: _sections, ...summary }) => summary)
}

/** 某文档当前版本的摘要；slug 未知返回 null。 */
export function getCurrentLegalSummary(slug: string): LegalDocumentSummary | null {
  const doc = resolveLegalDocument(slug)
  return doc ? { slug: doc.slug, title: doc.title, version: doc.version, updatedAt: doc.updatedAt, contentHash: doc.contentHash } : null
}

/**
 * 测试接缝：替换/还原注册表（等价于 __setRedisForTests 模式）。
 * 传入非法定义同样会 throw——测试可借此验证 fail-closed 行为。
 */
export function __setLegalRegistryForTests(definitions: LegalDocumentDefinition[]): void {
  registry = buildRegistry(definitions)
}

export function __resetLegalRegistryForTests(): void {
  registry = initRegistry()
}
