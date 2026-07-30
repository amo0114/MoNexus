import api from './client'

export async function sendProvisionEmailCode(email: string): Promise<{
  sent: boolean
  alreadyTrusted: boolean
  email: string
  expiresInSec?: number
}> {
  const { data } = await api.post('/faka-bridge/provision-email/send-code', { email })
  return data
}

export async function confirmProvisionEmailCode(
  email: string,
  code: string
): Promise<{ email: string; verified: boolean; bound: boolean; proofExpiresAt: string | null }> {
  const { data } = await api.post('/faka-bridge/provision-email/confirm', { email, code })
  return data
}

export async function getProvisionEmailStatus(email: string): Promise<{
  email: string
  trusted: boolean
  bound: boolean
  source: 'account' | 'otp' | null
  proofExpiresAt: string | null
}> {
  const { data } = await api.get('/faka-bridge/provision-email/status', { params: { email } })
  return data
}

/** 已与本账号绑定的 Xboard 邮箱（永久，无需重复验证） */
export async function listBoundProvisionEmails(): Promise<{
  items: Array<{ email: string; verifiedAt: string; permanent: boolean }>
}> {
  const { data } = await api.get('/faka-bridge/provision-email/bound')
  return data
}
