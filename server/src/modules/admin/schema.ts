import { z } from 'zod'
import { systemConfigKeys } from '../../lib/systemConfig.js'
import { businessRegistry } from '../../lib/businessRegistry.js'
import { ORDER_STATUSES } from '../orders/fulfillment.js'

export const adjustPointsSchema = z.object({
  type: z.enum(['add', 'deduct']),
  amount: z.number().int().positive('调整数量必须为正整数'),
  reason: z.string().min(1, '请填写操作原因'),
})

export const banUserSchema = z.object({
  reason: z.string().min(1, '请填写封禁原因'),
})

export const systemConfigKeyParamSchema = z.object({
  key: z.enum(systemConfigKeys),
})

export const updateSystemConfigSchema = z.object({
  value: z.number().int('配置值必须是整数').min(0, '配置值必须是非负整数'),
})

export const createProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  richDescription: z.string().optional(),
  type: z.string().min(1),
  icon: z.string().default('package'),
  imageUrl: z.string().optional(),
  price: z.number().int().positive(),
  originalPrice: z.number().int().positive().optional(),
  isHot: z.boolean().default(false),
})

export const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  richDescription: z.string().optional(),
  type: z.string().optional(),
  icon: z.string().optional(),
  imageUrl: z.string().optional(),
  price: z.number().int().positive().optional(),
  originalPrice: z.number().int().positive().optional(),
  isHot: z.boolean().optional(),
  status: z.enum(['active', 'inactive']).optional(),
})

export const importInventorySchema = z.object({
  items: z.array(z.string().min(1)).min(1, '至少提供一条库存'),
})

export const listUsersQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().positive('page 必须是正整数').optional(),
  pageSize: z.coerce.number().int().positive('pageSize 必须是正整数')
    .max(businessRegistry.pagination.maxPageSize, 'pageSize 超出最大分页限制')
    .optional(),
}).strict()

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>

export const listOrdersQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().positive('page 必须是正整数').optional(),
  pageSize: z.coerce.number().int().positive('pageSize 必须是正整数')
    .max(businessRegistry.pagination.maxPageSize, 'pageSize 超出最大分页限制')
    .optional(),
}).strict()

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>

export const listAdminAuditQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  adminId: z.coerce.number().int().positive().optional(),
  action: z.string().min(1).optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '必须是 ISO 日期').optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '必须是 ISO 日期').optional(),
}).strict()

export type ListAdminAuditQuery = z.infer<typeof listAdminAuditQuerySchema>

export const listMerchantsQuerySchema = z.object({
  status: z.enum(['pending', 'active', 'suspended', 'rejected']).optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export const reviewMerchantSchema = z.object({
  reason: z.string().optional(),
})

export const updateCommissionSchema = z.object({
  commissionRate: z.number().min(0).max(1),
})

export const listSettlementsQuerySchema = z.object({
  status: z.enum(['pending', 'settled']).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export const batchSettleSchema = z.object({
  settlementIds: z.array(z.number().int().positive()).min(1, '至少选择一条结算记录'),
})
