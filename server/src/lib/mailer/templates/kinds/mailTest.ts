import type { MailMessage } from '../../types.js'
import {
  headingHtml,
  joinText,
  kvTableHtml,
  mutedParagraphHtml,
  paragraphHtml,
  wrapHtml,
} from '../layout.js'
import { MAIL_SITE_NAME, resolveMailBrand, type MailBrandContext } from '../tokens.js'

/** Must stay in sync with admin mailOperations MAIL_TEST_SUBJECT. */
export const MAIL_TEST_SUBJECT = 'MoNexus 邮件投递测试'

export interface MailTestVars {
  to: string
  /** ISO timestamp string for the trigger time (UTC). */
  triggeredAtIso: string
  brand?: Partial<MailBrandContext>
}

export function renderMailTest(vars: MailTestVars): MailMessage {
  const brand = resolveMailBrand({ siteName: MAIL_SITE_NAME, ...vars.brand })
  const title = '邮件投递测试'
  const lead = `这是一封由 ${brand.siteName} 管理员在后台手动触发的邮件投递测试。`

  const text = joinText(
    lead,
    `站点：${brand.siteName}`,
    `触发时间（UTC）：${vars.triggeredAtIso}`,
    '本邮件不包含任何账号、订单或配置信息，无需回复。',
  )

  const bodyHtml = [
    headingHtml(title, 'center'),
    paragraphHtml(lead, 'center'),
    kvTableHtml([
      { label: '站点', value: brand.siteName },
      { label: '触发时间（UTC）', value: vars.triggeredAtIso },
    ]),
    mutedParagraphHtml('本邮件不包含任何账号、订单或配置信息，无需回复。', 'left'),
  ].join('\n')

  return {
    to: vars.to,
    subject: MAIL_TEST_SUBJECT,
    text,
    html: wrapHtml({ brand, bodyHtml, preheader: '邮件投递测试（无业务数据）' }),
  }
}
