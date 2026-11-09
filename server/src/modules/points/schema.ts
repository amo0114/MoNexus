import { z } from 'zod'
import { calendarDayToUtc, formatCalendarDay } from '../../lib/businessTime.js'

const calendarDay = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD')
  // 拒绝 2026-02-31 这类会被 Date 顺延的非法日期，避免写入不存在的日历日。
  .refine(v => formatCalendarDay(calendarDayToUtc(v)) === v, '日期不存在')

export const makeupBodySchema = z.object({
  date: calendarDay,
  // MK-02：必须携带用户确认过的价格，不一致时 409 PRICE_CHANGED。
  expectedPrice: z.number().int().positive(),
})

export const rewardParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
})
