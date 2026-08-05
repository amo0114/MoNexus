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

export interface ProvisionDegradedVars {
  to: string
  orderId: number
  productLabel: string
  errorCode: string
  brand?: Partial<MailBrandContext>
}

export function renderProvisionDegraded(vars: ProvisionDegradedVars): MailMessage {
  const brand = resolveMailBrand(vars.brand)
  const subject = `【自动开通失败，请人工履约】订单 #${vars.orderId}`
  const title = '自动开通失败'
  const lead = '您好，以下订单的自动开通未能完成，已转为人工履约：'
  const tip =
    '请尽快在商家后台手动交付该订单，避免超出履约时限。如需恢复自动开通，请检查回调服务与 webhook 配置。'

  const text = joinText(
    lead,
    [
      `商品：${vars.productLabel}`,
      `订单号：#${vars.orderId}`,
      `失败原因代码：${vars.errorCode}`,
    ].join('\n'),
    tip,
  )

  const bodyHtml = [
    headingHtml(title, 'center'),
    warningBannerHtml('自动开通未能完成，已转为人工履约。'),
    paragraphHtml(lead, 'left'),
    kvTableHtml([
      { label: '商品', value: vars.productLabel },
      { label: '订单号', value: `#${vars.orderId}` },
      { label: '失败原因代码', value: vars.errorCode },
    ]),
    mutedParagraphHtml(tip, 'left'),
  ].join('\n')

  return {
    to: vars.to,
    subject,
    text,
    html: wrapHtml({ brand, bodyHtml, preheader: subject }),
  }
}
