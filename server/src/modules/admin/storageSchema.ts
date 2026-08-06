import { z } from 'zod'
import { STORAGE_PROVIDER_TYPES } from '../../lib/storage/providerPresets.js'

const publicConfigSchema = z.object({
  endpoint: z.string().url(),
  region: z.string().min(1).max(64).default('us-east-1'),
  publicBucket: z.string().min(1).max(128),
  privateBucket: z.string().min(1).max(128),
  publicUrlBase: z.string().url().optional().or(z.literal('')).transform(v => (v ? v : undefined)),
  deliveryPublicEndpoint: z.string().url().optional().or(z.literal('')).transform(v => (v ? v : undefined)),
  forcePathStyle: z.boolean().default(true),
})

export const createStorageProviderSchema = z.object({
  type: z.enum(STORAGE_PROVIDER_TYPES),
  name: z.string().min(1).max(80),
  publicConfig: publicConfigSchema,
  accessKey: z.string().min(1).max(256),
  secretKey: z.string().min(1).max(512),
})

export const updateStorageProviderSchema = z.object({
  type: z.enum(STORAGE_PROVIDER_TYPES).optional(),
  name: z.string().min(1).max(80).optional(),
  publicConfig: publicConfigSchema.optional(),
  accessKey: z.string().min(1).max(256).optional(),
  secretKey: z.string().min(1).max(512).optional(),
})

export type CreateStorageProviderInput = z.infer<typeof createStorageProviderSchema>
export type UpdateStorageProviderInput = z.infer<typeof updateStorageProviderSchema>
