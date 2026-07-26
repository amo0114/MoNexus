import { z } from 'zod'

export const RangeSchema = z.enum(['7d', '30d', '90d'])

export const TimeseriesQuerySchema = z.object({
  range: RangeSchema,
})

// P5.5 T2：/offers 缺省 30d（月视图）；显式传入仍必须是合法枚举，
// 非法值与 /timeseries 同文案 400。
export const OffersQuerySchema = z.object({
  range: RangeSchema.default('30d'),
})

export const DashboardSummarySchema = z.object({
  monthOrderCount: z.number().int().nonnegative(),
  monthPointsRevenue: z.number().int().nonnegative(),
  onSaleProductCount: z.number().int().nonnegative(),
  pendingSettlementPoints: z.number().int().nonnegative(),
})

export const DashboardSeriesPointSchema = z.object({
  date: z.string(),
  orderCount: z.number().int().nonnegative(),
  pointsRevenue: z.number().int().nonnegative(),
})

export const DashboardTopProductSchema = z.object({
  productId: z.number().int().positive(),
  name: z.string(),
  soldCount: z.number().int().nonnegative(),
  pointsRevenue: z.number().int().nonnegative(),
})

export const DashboardTopOfferSchema = z.object({
  offerId: z.number().int().positive().nullable(),
  offerName: z.string(),
  productId: z.number().int().positive(),
  productName: z.string(),
  soldCount: z.number().int().nonnegative(),
  pointsRevenue: z.number().int().nonnegative(),
})

export const DashboardTopOffersSchema = z.object({
  items: z.array(DashboardTopOfferSchema),
})

export const DashboardStatusBreakdownSchema = z.object({
  paid: z.number().int().nonnegative(),
  fulfilled: z.number().int().nonnegative(),
  refunded: z.number().int().nonnegative(),
})

export const DashboardTimeseriesSchema = z.object({
  range: RangeSchema,
  points: z.array(DashboardSeriesPointSchema),
  top10: z.array(DashboardTopProductSchema),
  statusBreakdown: DashboardStatusBreakdownSchema,
})

export type TimeseriesQuery = z.infer<typeof TimeseriesQuerySchema>
