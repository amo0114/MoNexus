import type { MailMessage } from '../../types.js'
import {
  ctaButtonHtml,
  headingHtml,
  joinText,
  linkFallbackHtml,
  mutedParagraphHtml,
  paragraphHtml,
  wrapHtml,
} from '../layout.js'
import { resolveMailBrand, type MailBrandContext } from '../tokens.js'

export interface PasswordResetVars {
  to: string
  resetUrl: string
  expiresMinutes?: number
  brand?: Partial<MailBrandContext>
}

export function renderPasswordReset(vars: PasswordResetVars): MailMessage {
  const brand = resolveMailBrand(vars.brand)
  const minutes = vars.expiresMinutes ?? 30
  const title = '重置账户密码'
  const lead = `您正在重置 ${brand.siteName} 账户密码，请在 ${minutes} 分钟内完成。`
  const subject = `${brand.siteName} 密码重置`

  const text = joinText(
    lead,
    `重置链接：\n${vars.resetUrl}`,
    '如非本人操作，请忽略本邮件，密码不会被更改。',
  )

  const bodyHtml = [
    headingHtml(title, 'center'),
    paragraphHtml(lead, 'center'),
    ctaButtonHtml('重置密码', vars.resetUrl),
    linkFallbackHtml(vars.resetUrl),
    mutedParagraphHtml('如非本人操作，请忽略本邮件，密码不会被更改。', 'left'),
  ].join('\n')

  return {
    to: vars.to,
    subject,
    text,
    html: wrapHtml({ brand, bodyHtml, preheader: lead }),
  }
}
