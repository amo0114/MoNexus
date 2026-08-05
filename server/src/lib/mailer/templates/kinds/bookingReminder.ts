import type { MailMessage } from '../../types.js'
import {
  headingHtml,
  joinText,
  kvTableHtml,
  paragraphHtml,
  wrapHtml,
} from '../layout.js'
import { resolveMailBrand, type MailBrandContext } from '../tokens.js'

export interface BookingReminderVars {
  to: string
  orderId: number
  productLabel: string
  bookingDay: string
  role: 'buyer' | 'merchant'
  brand?: Partial<MailBrandContext>
}

export function renderBookingReminder(vars: BookingReminderVars): MailMessage {
  const brand = resolveMailBrand(vars.brand)
  const subject = `【预约提醒】订单 #${vars.orderId} 预约日期为 ${vars.bookingDay}`
  const title = '预约提醒'
  const roleLine =
    vars.role === 'buyer'
      ? '您预约的服务将于明天开始，请留意履约安排。'
      : '您有一笔预约服务订单将于明天到期，请按预约日期履约。'

  const text = joinText(
    roleLine,
    [
      `订单号：#${vars.orderId}`,
      `商品：${vars.productLabel}`,
      `预约日期：${vars.bookingDay}`,
    ].join('\n'),
  )

  const bodyHtml = [
    headingHtml(title, 'center'),
    paragraphHtml(roleLine, 'left'),
    kvTableHtml([
      { label: '订单号', value: `#${vars.orderId}` },
      { label: '商品', value: vars.productLabel },
      { label: '预约日期', value: vars.bookingDay },
    ]),
  ].join('\n')

  return {
    to: vars.to,
    subject,
    text,
    html: wrapHtml({ brand, bodyHtml, preheader: subject }),
  }
}
