import { z } from 'zod'

export const adjustPointsSchema = z.object({
  type: z.enum(['add', 'deduct']),
  amount: z.number().int().positive('调整数量必须为正整数'),
  reason: z.string().min(1, '请填写操作原因'),
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
