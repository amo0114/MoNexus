import api from './client'

/**
 * SPEC-OPS-REGMAIL-001 §4.3：邮件投递状态 DTO 的**封闭**字段集合。
 * 后端承诺只返回这 5 个非敏感字段（MAIL-01）；前端也只声明这 5 个，
 * 组件必须显式解构渲染，绝不整体展开未知字段到 DOM。
 */
export interface AdminMailStatus {
  mode: 'smtp' | 'console'
  /** 实际生效 mailer 是否具备可用发件地址（含 SMTP_USER 兜底），驱动测试发送开关 */
  deliveryReady: boolean
  /** 仅显式配置 SMTP_FROM 时返回；否则为 null（不回显 SMTP_USER 兜底值） */
  from: string | null
  authConfigured: boolean
  configuredVia: 'environment'
}

export async function getAdminMailStatus(): Promise<AdminMailStatus> {
  const { data } = await api.get<AdminMailStatus>('/admin/mail/status')
  // 只投影白名单字段，避免后端将来多返回字段时被组件透传渲染。
  return {
    mode: data.mode,
    deliveryReady: data.deliveryReady,
    from: data.from ?? null,
    authConfigured: data.authConfigured,
    configuredVia: data.configuredVia,
  }
}

export async function sendAdminMailTest(email: string): Promise<{ message: string }> {
  // 收件地址只随本次请求出网，调用方不得持久化（规格 §5.2）。
  const { data } = await api.post<{ message: string }>('/admin/mail/test', { email })
  return data
}
