/**
 * P7b：自动开通任务状态与脱敏诊断码的中文映射。商家/管理端徽标共用,
 * 语义与后端一致(server/src/modules/orders/provisionCron.ts 的状态机与
 * outboundWebhook.ts 的 classifyWebhookFailure)。诊断码只做人类可读翻译,
 * 不承载远端响应体——排障仍需商家在其回调服务侧查日志。
 */
import type { ProvisionTaskSummary } from '../types/merchant'

export type ProvisionTone = 'info' | 'success' | 'danger' | 'neutral'

/** 状态 → 徽标文案。 */
export function provisionStatusLabel(status: ProvisionTaskSummary['status']): string {
  switch (status) {
    case 'pending':
      return '开通中'
    case 'succeeded':
      return '已自动交付'
    case 'degraded':
      return '已降级人工'
    case 'cancelled':
      return '开通已取消'
    default:
      return '自动开通'
  }
}

/** 状态 → 徽标色调(与 RegistryPill 的 tone 词汇对齐)。 */
export function provisionStatusTone(status: ProvisionTaskSummary['status']): ProvisionTone {
  switch (status) {
    case 'succeeded':
      return 'success'
    case 'degraded':
      return 'danger'
    case 'pending':
      return 'info'
    default:
      return 'neutral'
  }
}

const ERROR_LABELS: Record<string, string> = {
  dns_blocked: '目标地址被安全策略拦截(疑似解析到内网)',
  dns_error: '域名解析失败',
  connect_error: '无法连接回调服务',
  tls_error: 'TLS 证书/握手失败',
  timeout: '回调请求超时',
  request_error: '请求发送失败',
  url_invalid: '回调地址不合法',
  bad_body: '回调响应格式不符(需 2xx + JSON {content})',
  config_revoked: 'webhook 配置已撤销',
}

/**
 * 脱敏诊断码 → 中文。`http_<code>` 归一为「回调返回 HTTP <code>」;
 * 未知码原样透出(便于对照后端日志)。
 */
export function provisionErrorLabel(code: string | null | undefined): string | null {
  if (!code) return null
  if (code in ERROR_LABELS) return ERROR_LABELS[code]
  const http = /^http_(\d{3})$/.exec(code)
  if (http) return `回调返回 HTTP ${http[1]}`
  return code
}
