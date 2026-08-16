import { z } from 'zod'
import { businessRegistry } from '../../lib/businessRegistry.js'

const productTypeValues = businessRegistry.productTypes.map(type => type.value)

// Keep product text fields bounded at the API boundary.  These limits are
// intentionally about storage and response safety rather than presentation;
// the UI can choose smaller visual limits where appropriate.
export const MAX_PRODUCT_NAME_LENGTH = 120
export const MAX_PRODUCT_DESCRIPTION_LENGTH = 2_000
export const MAX_PRODUCT_RICH_DESCRIPTION_LENGTH = 20_000
export const MAX_PRODUCT_ICON_LENGTH = 64
export const MAX_PRODUCT_PRICE = 2_000_000_000

export const productNameSchema = z.string().trim()
  .min(1, '商品名称不能为空')
  .max(MAX_PRODUCT_NAME_LENGTH, `商品名称最多 ${MAX_PRODUCT_NAME_LENGTH} 字`)

export const productDescriptionSchema = z.string().trim()
  .max(MAX_PRODUCT_DESCRIPTION_LENGTH, `商品简介最多 ${MAX_PRODUCT_DESCRIPTION_LENGTH} 字`)

export const productRichDescriptionSchema = z.string()
  .max(MAX_PRODUCT_RICH_DESCRIPTION_LENGTH, `商品详情最多 ${MAX_PRODUCT_RICH_DESCRIPTION_LENGTH} 字`)

// Icons are application identifiers, not arbitrary display content.  The
// frontend currently uses kebab-case Lucide-style names (for example
// `message-square`), so accept that portable subset only.
export const productIconSchema = z.string().trim()
  .min(1, '商品图标不能为空')
  .max(MAX_PRODUCT_ICON_LENGTH, `商品图标最多 ${MAX_PRODUCT_ICON_LENGTH} 字`)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/, '商品图标只能使用字母、数字和连字符')

export const productPriceSchema = z.number().int('价格必须是整数')
  .positive('价格必须大于 0')
  .max(MAX_PRODUCT_PRICE, '价格超出允许范围')

export const productTypeSchema = z.string().trim().min(1).refine(
  value => productTypeValues.includes(value as typeof productTypeValues[number]),
  '商品类型不在可用范围内'
)

const productDeliveryModeValues = businessRegistry.deliveryModes.map(mode => mode.value)

export const productDeliveryModeSchema = z.string().trim().refine(
  value => productDeliveryModeValues.includes(value as typeof productDeliveryModeValues[number]),
  '履约模式不在可用范围内'
)

export const productStockModeSchema = z.enum(['limited', 'unlimited'])
export const productFixedContentTypeSchema = z.enum(['text', 'url'])

export const listProductsQuerySchema = z.object({
  q: z.string().optional(),
  categoryCode: z.string().trim().min(1).optional(),
  category: z.string().optional(),
  cursor: z.string().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export const MAX_PRODUCT_IMAGES = 6

// 商品多图：最多 6 条，元素必须是非空 URL。
// 允许绝对 http(s) URL（S3 / 对象存储）或根相对路径（本地 /uploads/ 透传）。
export const productImageItemSchema = z.string().trim()
  .min(1, '图片地址不能为空')
  .max(2048, '图片地址过长')
  .refine(
    value => /^https?:\/\/\S+$/.test(value) || /^\/\S+$/.test(value),
    '图片地址必须是有效 URL'
  )

export const productImagesSchema = z.array(productImageItemSchema)
  .max(MAX_PRODUCT_IMAGES, `商品图片最多 ${MAX_PRODUCT_IMAGES} 张`)

/** Shared request-level checks for all product authoring endpoints. */
export function validateProductCommercialFields(
  data: { price?: number; originalPrice?: number | null; imageUrl?: string | null; images?: string[] },
  ctx: z.RefinementCtx
) {
  if (data.originalPrice != null && data.price != null && data.originalPrice < data.price) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['originalPrice'],
      message: '原价不能低于售价',
    })
  }

  // `imageUrl` is the legacy cover alias. Receiving two conflicting covers
  // would otherwise cause different clients to render different products.
  if (data.imageUrl !== undefined && data.images !== undefined && data.imageUrl !== (data.images[0] ?? null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['imageUrl'],
      message: '封面图必须与图片列表第一张一致',
    })
  }
}
