import api from './client'
import { getApiErrorCode } from './error'

/**
 * SPEC-LEGAL-001：法律文档公开 API。
 *
 * 功能关闭时后端一律 404——前端把 404 翻译成 null（门禁感知）：footer
 * 隐藏链接组、登录页/结算弹窗隐藏勾选区，绝不渲染指向 404 的协议链接。
 */

export type LegalDocumentSlug = 'terms' | 'privacy' | 'refund' | 'points-rules' | 'about'

export interface LegalSection {
  heading?: string
  paragraphs: string[]
}

export interface LegalDocumentSummary {
  slug: LegalDocumentSlug
  title: string
  version: string
  updatedAt: string
  contentHash: string
}

export interface LegalDocument extends LegalDocumentSummary {
  sections: LegalSection[]
}

/** 注册/下单结算预览里下发的必备协议版本清单（功能关闭 = null）。 */
export interface LegalRequirement {
  required: Array<{
    document: LegalDocumentSlug
    version: string
    title: string
    contentHash: string
  }>
}

/** 把 requirement 摊平为下单/注册请求携带的 { document: version }。 */
export function agreementVersionsOf(requirement: LegalRequirement | null | undefined): Record<string, string> | undefined {
  if (!requirement || requirement.required.length === 0) return undefined
  return Object.fromEntries(requirement.required.map(item => [item.document, item.version]))
}

/** slug → 公开路由路径（footer/勾选链接/披露条共用，避免散落硬编码）。 */
export const LEGAL_PAGE_PATHS: Record<LegalDocumentSlug, string> = {
  terms: '/terms',
  privacy: '/privacy',
  refund: '/refund',
  'points-rules': '/points-rules',
  about: '/about',
}

/** slug → 展示标题（与注册表草案一致；权威标题以 API 返回为准）。 */
export const LEGAL_DOCUMENT_TITLES: Record<LegalDocumentSlug, string> = {
  terms: '服务协议',
  privacy: '隐私政策',
  refund: '退款政策',
  'points-rules': '积分规则',
  about: '关于我们',
}

// 模块级缓存（同 registry.ts 的单例去重模式）：文档随部署版本固定，
// 短缓存不会让用户看到过期的协议——版本变化必然伴随新版本号下发。
let summariesCache: Promise<LegalDocumentSummary[] | null> | null = null

/** 全部文档摘要；功能关闭（404）时返回 null。 */
export function getLegalDocumentSummaries(): Promise<LegalDocumentSummary[] | null> {
  if (!summariesCache) {
    summariesCache = api
      .get<{ documents: LegalDocumentSummary[] }>('/legal/documents', { skipAuthRefresh: true })
      .then(({ data }) => data.documents)
      .catch(error => {
        if (getApiErrorCode(error) === 'NOT_FOUND') return null
        summariesCache = null // 网络/5xx 不缓存失败，下次调用重试
        throw error
      })
  }
  return summariesCache
}

/** 单份文档全文；未找到/功能关闭时 reject（调用方渲染错误态）。 */
export async function getLegalDocument(slug: LegalDocumentSlug, version?: string): Promise<LegalDocument> {
  const { data } = await api.get<LegalDocument>(`/legal/documents/${slug}`, {
    params: version ? { version } : {},
    skipAuthRefresh: true,
  })
  return data
}
