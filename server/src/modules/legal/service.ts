import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import { badRequest, legalAgreementRequired, legalAgreementStale } from '../../lib/httpError.js'
import {
  LEGAL_DOCUMENT_SLUGS,
  getCurrentLegalSummary,
  type LegalDocumentSlug,
  type LegalDocumentSummary,
} from './registry.js'

/**
 * SPEC-LEGAL-001：协议同意证据的解析与落库。
 *
 * 两层语义：
 * - 页面开关（config.legalPages.enabled）关闭 → 一切同意输入被忽略，
 *   不落证、不报错（旧客户端零感知）。
 * - 开启后按 enforcement 分级：enforce = 注册/下单必须携带全部必备文档的
 *   当前版本（缺 → 400 REQUIRED，旧 → 409 STALE）；off = 只记录不强求，
 *   但携带的版本仍必须能解析（防伪造证据）。
 */

/** 注册必备：服务协议 + 隐私政策。 */
export const REGISTRATION_REQUIRED_DOCUMENTS: readonly LegalDocumentSlug[] = ['terms', 'privacy']
/** 下单必备：服务协议 + 退款政策。 */
export const ORDER_REQUIRED_DOCUMENTS: readonly LegalDocumentSlug[] = ['terms', 'refund']

/**
 * 证据中 IP/UA 的留存窗口：到期后 retention cron 置空匿名化，其余字段
 * （文档/版本/哈希/时间）长期留存作争议举证。窗口取值与《隐私政策》草案
 * 第三节的对外承诺一致，改这里必须同步改文档并 bump 版本。
 */
export const EVIDENCE_RETENTION_DAYS = 180

export interface LegalRequirementItem {
  document: LegalDocumentSlug
  version: string
  title: string
  contentHash: string
}

/** 前端渲染勾选区所需的最小信息；功能关闭时为 null（门禁感知）。 */
export interface LegalRequirement {
  required: LegalRequirementItem[]
}

export interface ConsentEvidence {
  document: string
  version: string
  contentHash: string
}

export function getLegalRequirement(kind: 'registration' | 'order'): LegalRequirement | null {
  if (!config.legalPages.enabled) return null
  const slugs = kind === 'registration' ? REGISTRATION_REQUIRED_DOCUMENTS : ORDER_REQUIRED_DOCUMENTS
  const required = slugs.map(slug => {
    const summary = getCurrentLegalSummary(slug)
    // 注册表启动期已 fail-closed 校验，这里缺失只能是测试接缝替换失误。
    if (!summary) throw new Error(`[Legal] required document missing from registry: ${slug}`)
    return {
      document: summary.slug,
      version: summary.version,
      title: summary.title,
      contentHash: summary.contentHash,
    }
  })
  return { required }
}

function isKnownSlug(document: string): document is LegalDocumentSlug {
  return (LEGAL_DOCUMENT_SLUGS as readonly string[]).includes(document)
}

/**
 * 解析客户端提交的协议确认 { document: version } 为可落库的证据数组。
 * agreements 为 undefined/空时：enforce → REQUIRED；off → 空数组。
 */
export function resolveConsentEvidence(
  kind: 'registration' | 'order',
  agreements: Record<string, string> | undefined,
): ConsentEvidence[] {
  if (!config.legalPages.enabled) return []

  const requirement = getLegalRequirement(kind)
  if (!requirement) return []

  const provided = agreements ?? {}
  for (const document of Object.keys(provided)) {
    if (!isKnownSlug(document)) {
      throw badRequest(`未知的协议文档：${document}`)
    }
  }

  const enforce = config.legalPages.enforcement === 'enforce'
  const stale: Array<{ document: string; version: string }> = []
  const missing: string[] = []
  const evidence: ConsentEvidence[] = []

  for (const item of requirement.required) {
    const version = provided[item.document]
    if (version == null || version === '') {
      if (enforce) missing.push(item.document)
      continue
    }
    if (version !== item.version) {
      stale.push({ document: item.document, version: item.version })
      continue
    }
    evidence.push({ document: item.document, version: item.version, contentHash: item.contentHash })
  }

  if (missing.length > 0) throw legalAgreementRequired()
  if (stale.length > 0) {
    // STALE 契约携带全部必备文档的当前版本（不只是过期的那份），前端
    // 一次刷新即可完整重确认，避免多轮 409。
    throw legalAgreementStale(requirement.required.map(r => ({ document: r.document, version: r.version })))
  }
  return evidence
}

const USER_AGENT_MAX_LENGTH = 512

type EvidenceTx = Pick<typeof prisma, 'userAgreementConsent' | 'orderAgreementAcceptance'>

/**
 * 注册同意落库（调用方事务内）：同一 (userId, document, version) 唯一，
 * 重复注册路径天然幂等；新版本重签产生新行，旧版本留存作审计。
 */
export async function recordUserConsents(
  tx: EvidenceTx,
  input: { userId: number; evidences: ConsentEvidence[]; ip?: string; userAgent?: string },
): Promise<void> {
  if (input.evidences.length === 0) return
  const retentionUntil = new Date(Date.now() + EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  await tx.userAgreementConsent.createMany({
    data: input.evidences.map(evidence => ({
      userId: input.userId,
      document: evidence.document,
      version: evidence.version,
      contentHash: evidence.contentHash,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
      retentionUntil,
    })),
  })
}

/**
 * 订单确认落库（下单事务内）：(orderId, document) 唯一 + 同事务创建，
 * 与订单同生共死；只插入不更新。
 */
export async function recordOrderAcceptances(
  tx: EvidenceTx,
  input: { orderId: number; userId: number; evidences: ConsentEvidence[]; ip?: string; userAgent?: string },
): Promise<void> {
  if (input.evidences.length === 0) return
  const retentionUntil = new Date(Date.now() + EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  await tx.orderAgreementAcceptance.createMany({
    data: input.evidences.map(evidence => ({
      orderId: input.orderId,
      userId: input.userId,
      document: evidence.document,
      version: evidence.version,
      contentHash: evidence.contentHash,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
      retentionUntil,
    })),
  })
}
