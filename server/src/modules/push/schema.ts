import { z } from 'zod'

// PW-04：endpoint 由浏览器推送服务签发，只接受 https；长度上限防止滥用存储。
export const subscribeBodySchema = z.object({
  endpoint: z.string().url().max(2048).refine(v => v.startsWith('https://'), 'endpoint 必须是 https 地址'),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
})

export const unsubscribeBodySchema = z.object({
  endpoint: z.string().max(2048),
})

export type SubscribeBody = z.infer<typeof subscribeBodySchema>
