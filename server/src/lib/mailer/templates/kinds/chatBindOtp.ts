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

export interface ChatBindOtpVars {
  to: string
  code: string
  expiresMinutes?: number
  brand?: Partial<MailBrandContext>
}

/**
 * SPEC-CHAT-BOT-001：把 QQ 群账号绑定到站内账号的验证码邮件。
 *
 * 与 provision_otp 的区别在于文案面向的用户动作不同：这里用户不是去某个
 * 网页输入，而是回到 QQ 群发送 `/确认 <码>`。文案必须把这一点说清楚，
 * 否则用户会去网站找输入框。
 */
export function renderChatBindOtp(vars: ChatBindOtpVars): MailMessage {
  const brand = resolveMailBrand(vars.brand)
  const minutes = vars.expiresMinutes ?? 10
  const title = '绑定 QQ 机器人'
  const lead = '您正在将 QQ 账号绑定到站内账号，请在群聊或私聊中发送下方验证码完成绑定。'
  const subject = `${brand.siteName} 绑定验证码`

  const text = joinText(
    lead,
    `验证码：/确认 ${vars.code}`,
    `有效期 ${minutes} 分钟。`,
    '如非本人操作，请忽略本邮件。未持有验证码时，他人无法将 QQ 绑定到您的账号。',
  )

  const bodyHtml = [
    headingHtml(title, 'center'),
    paragraphHtml(lead, 'center'),
    // 与群聊里的实际命令保持一致，用户直接照抄即可。
    otpCodeHtml(`/确认 ${vars.code}`),
    paragraphHtml(`有效期 ${minutes} 分钟，请在 QQ 群中发送上述命令。`, 'center'),
    mutedParagraphHtml(
      '如非本人操作，请忽略本邮件。未持有验证码时，他人无法将 QQ 绑定到您的账号。',
      'left',
    ),
  ].join('\n')

  return {
    to: vars.to,
    subject,
    text,
    html: wrapHtml({ brand, bodyHtml, preheader: `绑定验证码有效期 ${minutes} 分钟` }),
  }
}
