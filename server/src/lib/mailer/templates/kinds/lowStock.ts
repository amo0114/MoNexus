import type { MailMessage } from '../../types.js'
import {
  headingHtml,
  joinText,
  kvTableHtml,
  mutedParagraphHtml,
  paragraphHtml,
  wrapHtml,
} from '../layout.js'
import { resolveMailBrand, type MailBrandContext } from '../tokens.js'

export interface LowStockVars {
  to: string
  productName: string
  offerName: string
  available: number
  threshold: number
  brand?: Partial<MailBrandContext>
}

export function renderLowStock(vars: LowStockVars): MailMessage {
  const brand = resolveMailBrand(vars.brand)
  const subject = `【低库存预警】${vars.productName} - ${vars.offerName} 仅剩 ${vars.available} 件`
  const title = '低库存预警'
  const lead = '您好，您的商品有规格库存已跌至预警阈值以下：'

  const text = joinText(
    lead,
    [
      `商品：${vars.productName}`,
      `规格：${vars.offerName}`,
      `当前可用库存：${vars.available} 件`,
      `预警阈值：${vars.threshold} 件`,
    ].join('\n'),
    '请尽快登录商家后台补充库存或调整规格容量，避免影响买家下单。',
  )

  const bodyHtml = [
    headingHtml(title, 'center'),
    paragraphHtml(lead, 'left'),
    kvTableHtml([
      { label: '商品', value: vars.productName },
      { label: '规格', value: vars.offerName },
      { label: '当前可用库存', value: `${vars.available} 件` },
      { label: '预警阈值', value: `${vars.threshold} 件` },
    ]),
    mutedParagraphHtml('请尽快登录商家后台补充库存或调整规格容量，避免影响买家下单。', 'left'),
  ].join('\n')

  return {
    to: vars.to,
    subject,
    text,
    html: wrapHtml({ brand, bodyHtml, preheader: subject }),
  }
}
