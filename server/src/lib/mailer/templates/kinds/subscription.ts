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

export interface SubscriptionMailVars {
  to: string
  orderId: number
  productLabel: string
  expiresAtLabel: string
  brand?: Partial<MailBrandContext>
}

export function renderSubscriptionExpiring(vars: SubscriptionMailVars): MailMessage {
  const brand = resolveMailBrand(vars.brand)
  const subject = `【订阅即将到期】${vars.productLabel}`
  const title = '订阅即将到期'
  const lead = '您好，您购买的订阅即将到期：'
  const tip = '如需继续使用，请到订单详情点击「续费」，避免服务中断。'

  const text = joinText(
    lead,
    [
      `商品：${vars.productLabel}`,
      `订单号：#${vars.orderId}`,
      `到期时间：${vars.expiresAtLabel}`,
    ].join('\n'),
    tip,
  )

  const bodyHtml = [
    headingHtml(title, 'center'),
    paragraphHtml(lead, 'left'),
    kvTableHtml([
      { label: '商品', value: vars.productLabel },
      { label: '订单号', value: `#${vars.orderId}` },
      { label: '到期时间', value: vars.expiresAtLabel },
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

export function renderSubscriptionExpired(vars: SubscriptionMailVars): MailMessage {
  const brand = resolveMailBrand(vars.brand)
  const subject = `【订阅已到期】${vars.productLabel}`
  const title = '订阅已到期'
  const lead = '您好，您购买的订阅已经到期：'
  const tip = '如需恢复使用，请到订单详情点击「续费」重新开通。'

  const text = joinText(
    lead,
    [
      `商品：${vars.productLabel}`,
      `订单号：#${vars.orderId}`,
      `到期时间：${vars.expiresAtLabel}`,
    ].join('\n'),
    tip,
  )

  const bodyHtml = [
    headingHtml(title, 'center'),
    paragraphHtml(lead, 'left'),
    kvTableHtml([
      { label: '商品', value: vars.productLabel },
      { label: '订单号', value: `#${vars.orderId}` },
      { label: '到期时间', value: vars.expiresAtLabel },
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
