import { z } from 'zod'

/** Bounded transport shape; the bound provider validates its own field semantics. */
export const extensionInputSchema = z.record(
  z.string().max(64),
  z.union([z.string().max(512), z.number().finite(), z.boolean()]),
).refine(value => Object.keys(value).length <= 16, '扩展参数过多')

/** GET uses JSON so primitive types and the POST input shape remain identical. */
export const extensionQueryInputSchema = z.preprocess(value => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}, extensionInputSchema)
