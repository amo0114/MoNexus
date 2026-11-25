import { z } from 'zod'

const queryFlagSchema = z.enum(['true', 'false', '1', '0'])
  .transform(value => value === 'true' || value === '1')
  .default('false')

export const PRODUCT_LIST_SORTS = ['default', 'sales', 'price_asc', 'price_desc'] as const
export type ProductListSort = (typeof PRODUCT_LIST_SORTS)[number]

export const listProductsQuerySchema = z.object({
  q: z.string().optional(),
  categoryCode: z.string().trim().min(1).optional(),
  category: z.string().optional(),
  cursor: z.string().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(PRODUCT_LIST_SORTS).default('default'),
  inStock: queryFlagSchema,
  instant: queryFlagSchema,
  /** Price ceiling comes from the caller's own balance on the server; ignored for guests. */
  affordable: queryFlagSchema,
})

export const productSummariesQuerySchema = z.object({
  ids: z.string().max(150).transform(value => value.split(','))
    .pipe(z.array(z.coerce.number().int().positive().max(2147483647)).min(1).max(12)),
})
