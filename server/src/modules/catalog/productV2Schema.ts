import { z } from 'zod'
import { deliveryFieldsSchema } from '../../lib/deliveryFields.js'
import { purchaseFormSchema } from '../../lib/purchaseForm.js'
import {
  productDescriptionSchema,
  productNameSchema,
  productPriceSchema,
  productRichDescriptionSchema,
} from '../products/schema.js'
import { PRODUCT_VISIBILITY } from './constants.js'
import { productDetailsSchema } from './templates/productDetails.js'
import { TEMPLATE_KEYS } from './templates/types.js'

export const platformMediaRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upload'), objectKey: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('static'), path: z.string().regex(/^\/assets\//) }).strict(),
])

export const descriptionImageRefSchema = z.object({
  src: z.string().min(1).max(2000),
  ref: platformMediaRefSchema,
}).strict()

const draftOfferV2Schema = z.object({
  name: z.string().trim().min(1).max(50),
  price: productPriceSchema,
  originalPrice: productPriceSchema.nullable(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
  deliveryMode: z.enum(['instant_inventory', 'instant_fixed', 'manual_service']),
  stockMode: z.enum(['limited', 'unlimited']),
  validityDays: z.number().int().min(1).max(3650).nullable(),
  fixedContentType: z.enum(['text', 'url', 'file']),
  fixedContent: z.string().trim().min(1).max(5000).nullable(),
  fixedFileId: z.number().int().positive().nullable(),
  fixedStructuredContent: z.unknown().nullable(),
  deliveryFields: deliveryFieldsSchema.nullable(),
  autoProvision: z.boolean(),
}).strict()

export const createProductV2Schema = z.object({
  editorVersion: z.literal(2),
  templateKey: z.enum(TEMPLATE_KEYS),
  templateVersion: z.literal(1),
  name: productNameSchema,
  categoryId: z.number().int().positive(),
  description: productDescriptionSchema,
  richDescription: productRichDescriptionSchema.nullable(),
  descriptionImages: z.array(descriptionImageRefSchema).max(12),
  images: z.array(platformMediaRefSchema).max(12),
  visibility: z.enum([PRODUCT_VISIBILITY.PUBLIC, PRODUCT_VISIBILITY.MEMBERS_ONLY]),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
  details: productDetailsSchema,
  purchaseForm: purchaseFormSchema,
  offers: z.array(draftOfferV2Schema).min(1).max(20),
}).strict()

export type CreateProductV2Input = z.infer<typeof createProductV2Schema>

export const patchProductContentSchema = z.object({
  expectedContentVersion: z.number().int().positive(),
  name: productNameSchema.optional(),
  categoryId: z.number().int().positive().optional(),
  description: productDescriptionSchema.optional(),
  richDescription: productRichDescriptionSchema.nullable().optional(),
  descriptionImages: z.array(descriptionImageRefSchema).max(12).optional(),
  images: z.array(platformMediaRefSchema).max(12).optional(),
  visibility: z.enum([PRODUCT_VISIBILITY.PUBLIC, PRODUCT_VISIBILITY.MEMBERS_ONLY]).optional(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
  details: productDetailsSchema.optional(),
  purchaseForm: purchaseFormSchema.optional(),
}).strict()

export type PatchProductContentInput = z.infer<typeof patchProductContentSchema>

export const draftOfferV2WriteSchema = draftOfferV2Schema
export type DraftOfferV2Input = z.infer<typeof draftOfferV2Schema>
