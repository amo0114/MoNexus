import { z } from 'zod'

export const listProductsQuerySchema = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export const MAX_PRODUCT_IMAGES = 6

// 商品多图：最多 6 条，元素必须是非空 URL。
// 允许绝对 http(s) URL（S3 / 对象存储）或根相对路径（本地 /uploads/ 透传）。
const productImageItemSchema = z.string().trim()
  .min(1, '图片地址不能为空')
  .max(2048, '图片地址过长')
  .refine(
    value => /^https?:\/\/\S+$/.test(value) || /^\/\S+$/.test(value),
    '图片地址必须是有效 URL'
  )

export const productImagesSchema = z.array(productImageItemSchema)
  .max(MAX_PRODUCT_IMAGES, `商品图片最多 ${MAX_PRODUCT_IMAGES} 张`)
