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
  /**
   * 复审 P2：强制语义随清单下发。enforce = 前端门控提交（未勾选禁用）；
   * off = 记录模式，勾选可选、提交不携带即不留证——灰度期不得阻断交易。
   */
  enforcement: 'off' | 'enforce'
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
  return { required, enforcement: config.legalPages.enforcement }
}

function isKnownSlug(document: string): document is LegalDocumentSlug {
  return (LEGAL_DOCUMENT_SLUGS as readonly string[]).includes(document)
}

/**
 * 解析客户端提交的协议确认 { document: version } 为可落库的证据数组。
 * agreements 为 undefined/空时：enforce → REQUIRED；off → 空数组。
 *
 * 复审 P2（LEG-06）：所有携带项逐项校验——slug 必须已知（400）、版本必须
 * 等于注册表当前版本（409 STALE），无论该文档是否属于本场景必备清单；
 * 否则携带旧版本的"同意"会被静默丢弃，证据失真。通过校验的携带项全部
 * 留证（含必备之外的文档——客户端确实确认了该文本）。
 */
export function resolveConsentEvidence(
  kind: 'registration' | 'order',
  agreements: Record<string, string> | undefined,
): ConsentEvidence[] {
  if (!config.legalPages.enabled) return []

  const requirement = getLegalRequirement(kind)
  if (!requirement) return []

  // 空串视为未携带（与幂等指纹的空值归一化口径一致）。
  const providedEntries = Object.entries(agreements ?? {}).filter(([, version]) => version !== '')
  for (const [document] of providedEntries) {
    if (!isKnownSlug(document)) {
      throw badRequest(`未知的协议文档：${document}`)
    }
  }

  const enforce = config.legalPages.enforcement === 'enforce'
  const stale: Array<{ document: string; version: string }> = []
  const evidence: ConsentEvidence[] = []

  for (const [document, version] of providedEntries) {
    // isKnownSlug 已过滤 → current 恒存在（注册表启动期 fail-closed）。
    const current = getCurrentLegalSummary(document)!
    if (version !== current.version) {
      stale.push({ document, version: current.version })
      continue
    }
    evidence.push({ document, version, contentHash: current.contentHash })
  }

  const missing = enforce
    ? requirement.required.filter(item => !providedEntries.some(([doc]) => doc === item.document))
    : []

  if (missing.length > 0) throw legalAgreementRequired()
  if (stale.length > 0) {
    // STALE 契约携带必备清单 ∪ 过期项的当前版本，前端一次刷新即可完整
    // 重确认，避免多轮 409。
    const detailVersions = new Map<string, string>()
    for (const item of requirement.required) detailVersions.set(item.document, item.version)
    for (const item of stale) detailVersions.set(item.document, item.version)
    throw legalAgreementStale([...detailVersions].map(([document, version]) => ({ document, version })))
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
