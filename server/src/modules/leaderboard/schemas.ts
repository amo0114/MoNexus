import { z } from 'zod'

export const LeaderboardScopeSchema = z.enum(['total', 'month', 'week'])

/** 缺省总榜；显式传入必须是合法枚举，否则 validate 中间件 400 VALIDATION_ERROR。 */
export const LeaderboardQuerySchema = z.object({
  scope: LeaderboardScopeSchema.default('total'),
})

/**
 * LB-07 白名单：`.strict()` 让「多下发一个字段」成为 schema 失败而不是
 * 静默泄漏，测试用它扫描响应形状。
 */
export const LeaderboardTopRowSchema = z
  .object({
    rank: z.number().int().positive(),
    displayName: z.string(),
    points: z.number().int(),
    isMe: z.boolean(),
    /** 上一轮快照名次；首次入榜为 null。 */
    prevRank: z.number().int().positive().nullable(),
  })
  .strict()

export const LeaderboardMeSchema = z
  .object({
    rank: z.number().int().positive(),
    points: z.number().int(),
    prevRank: z.number().int().positive().nullable(),
  })
  .strict()

export const LeaderboardResponseSchema = z
  .object({
    scope: LeaderboardScopeSchema,
    periodKey: z.string(),
    periodLabel: z.string(),
    dataThrough: z.string().nullable(),
    updatedAt: z.string().nullable(),
    top: z.array(LeaderboardTopRowSchema).max(100),
    me: LeaderboardMeSchema.nullable(),
  })
  .strict()

export type LeaderboardQuery = z.infer<typeof LeaderboardQuerySchema>
