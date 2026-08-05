import type { MailMessage } from '../../types.js'
import {
  headingHtml,
  joinText,
  kvTableHtml,
  mutedParagraphHtml,
  paragraphHtml,
  warningBannerHtml,
  wrapHtml,
} from '../layout.js'
import { resolveMailBrand, type MailBrandContext } from '../tokens.js'

export interface SlaOverdueVars {
  to: string
  orderId: number
  productLabel: string
  deadlineLabel: string
  waitDurationLabel: string
  brand?: Partial<MailBrandContext>
}

export function renderSlaOverdue(vars: SlaOverdueVars): MailMessage {
  const brand = resolveMailBrand(vars.brand)
  const subject = `【履约超时提醒】订单 #${vars.orderId} 已超过履约截止时间`
  const title = '履约超时提醒'
  const lead = '您好，您有一笔人工服务订单已超过履约截止时间，买家仍在等待：'

  const text = joinText(
    lead,
    [
      `订单号：#${vars.orderId}`,
      `商品：${vars.productLabel}`,
      `履约截止时间：${vars.deadlineLabel}`,
      `买家已等待：${vars.waitDurationLabel}`,
    ].join('\n'),
    '请尽快登录商家后台，在「订单管理」待处理列表中接单/交付；\n长时间未履约可能引发买家争议，影响店铺信誉与结算。',
  )

  const bodyHtml = [
    headingHtml(title, 'center'),
    warningBannerHtml('该订单已超过履约截止时间，请尽快处理。'),
    paragraphHtml(lead, 'left'),
    kvTableHtml([
      { label: '订单号', value: `#${vars.orderId}` },
      { label: '商品', value: vars.productLabel },
      { label: '履约截止时间', value: vars.deadlineLabel },
      { label: '买家已等待', value: vars.waitDurationLabel },
    ]),
    mutedParagraphHtml(
      '请尽快登录商家后台，在「订单管理」待处理列表中接单/交付。长时间未履约可能引发买家争议，影响店铺信誉与结算。',
      'left',
    ),
  ].join('\n')

  return {
    to: vars.to,
    subject,
    text,
    html: wrapHtml({ brand, bodyHtml, preheader: subject }),
  }
}
