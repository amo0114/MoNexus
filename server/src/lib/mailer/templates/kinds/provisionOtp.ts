import type { MailMessage } from '../../types.js'
import {
  headingHtml,
  joinText,
  mutedParagraphHtml,
  otpCodeHtml,
  paragraphHtml,
  wrapHtml,
} from '../layout.js'
import { resolveMailBrand, type MailBrandContext } from '../tokens.js'

export interface ProvisionOtpVars {
  to: string
  code: string
  expiresMinutes?: number
  brand?: Partial<MailBrandContext>
}

export function renderProvisionOtp(vars: ProvisionOtpVars): MailMessage {
  const brand = resolveMailBrand(vars.brand)
  const minutes = vars.expiresMinutes ?? 10
  const title = '开通邮箱验证码'
  const lead = `您正在验证 Xboard 开通邮箱，请使用下方验证码完成确认。`
  const subject = `${brand.siteName} 开通邮箱验证码`

  const text = joinText(
    lead,
    `验证码：${vars.code}`,
    `有效期 ${minutes} 分钟。`,
    '如非本人操作，请忽略本邮件。未持有验证码时，他人无法变更您的面板套餐。',
  )

  const bodyHtml = [
    headingHtml(title, 'center'),
    paragraphHtml(lead, 'center'),
    otpCodeHtml(vars.code),
    paragraphHtml(`有效期 ${minutes} 分钟，请在确认页输入该验证码。`, 'center'),
    mutedParagraphHtml(
      '如非本人操作，请忽略本邮件。未持有验证码时，他人无法变更您的面板套餐。',
      'left',
    ),
  ].join('\n')

  return {
    to: vars.to,
    subject,
    text,
    html: wrapHtml({ brand, bodyHtml, preheader: `验证码有效期 ${minutes} 分钟` }),
  }
}
