import { z } from 'zod'
import { EMPTY_PRODUCT_DETAILS, type ProductDetails } from './types.js'

const utf16 = (max: number, label: string) =>
  z.string().superRefine((value, ctx) => {
    if (value.length > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label}最多 ${max} 个字符`,
      })
    }
  })

const highlightSchema = z.string().superRefine((value, ctx) => {
  if (value.length < 1 || value.length > 40) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '亮点每项 1..40 个字符',
    })
  }
})

export const productDetailsSchema: z.ZodType<ProductDetails> = z.object({
  highlights: z.array(highlightSchema).max(4, '亮点最多 4 项'),
  usageInstructions: utf16(4000, '使用说明'),
  purchaseNotes: utf16(2000, '购买须知'),
  afterSalesInstructions: utf16(2000, '售后说明'),
  faq: z.array(z.object({
    question: z.string().superRefine((value, ctx) => {
      if (value.length < 1 || value.length > 100) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FAQ 问题 1..100 个字符' })
      }
    }),
    answer: z.string().superRefine((value, ctx) => {
      if (value.length < 1 || value.length > 1000) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FAQ 回答 1..1000 个字符' })
      }
    }),
  })).max(8, 'FAQ 最多 8 项'),
}).strict()

export function emptyProductDetails(): ProductDetails {
  return {
    highlights: [],
    usageInstructions: '',
    purchaseNotes: '',
    afterSalesInstructions: '',
    faq: [],
  }
}

export function parseProductDetails(value: unknown): ProductDetails {
  if (value == null) return emptyProductDetails()
  const parsed = productDetailsSchema.safeParse(value)
  if (!parsed.success) {
    throw parsed.error
  }
  return parsed.data
}

export { EMPTY_PRODUCT_DETAILS }
