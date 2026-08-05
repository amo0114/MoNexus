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

export interface EmailVerificationVars {
  to: string
  verifyUrl: string
  expiresHours?: number
  brand?: Partial<MailBrandContext>
}

export function renderEmailVerification(vars: EmailVerificationVars): MailMessage {
  const brand = resolveMailBrand(vars.brand)
  const hours = vars.expiresHours ?? 24
  const title = '验证您的邮箱'
  const lead = `请在 ${hours} 小时内完成邮箱验证。验证后即可购买、签到等。`
  const subject = `${brand.siteName} 邮箱验证`

  const text = joinText(
    `请验证您的 ${brand.siteName} 邮箱`,
    lead,
    `验证链接：\n${vars.verifyUrl}`,
    '如非本人操作，请忽略本邮件。',
  )

  const bodyHtml = [
    headingHtml(title, 'center'),
    paragraphHtml(lead, 'center'),
    ctaButtonHtml('验证邮箱', vars.verifyUrl),
    linkFallbackHtml(vars.verifyUrl),
    mutedParagraphHtml('如非本人操作，请忽略本邮件。', 'left'),
  ].join('\n')

  return {
    to: vars.to,
    subject,
    text,
    html: wrapHtml({ brand, bodyHtml, preheader: lead }),
  }
}
