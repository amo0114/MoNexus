/**
 * Admin catalog v2 create client (SPEC-PRODUCT-COMMERCE-002 §9.1).
 *
 * POST /admin/products with editorVersion: 2. The legacy DTO (no
 * editorVersion) stays on `createAdminPlatformProduct` in admin.ts for the
 * compatibility window and must not be used by the new admin wizard.
 */
import api from './client'
import {
  buildCreateProductV2Request,
  type CreateProductV2Input,
  type CreateProductV2Request,
  type CreateProductV2Result,
} from './catalog'

export type AdminCreateProductV2Input = CreateProductV2Input & {
  purchaseForm?: unknown[]
}

/**
 * Build the admin editorVersion:2 create body. Reuses the merchant v2
 * sanitizer, then overlays create-time `purchaseForm` (merchant create
 * always sends []). Forbidden keys never reach the wire.
 */
export function buildAdminCreateProductV2Request(
  input: AdminCreateProductV2Input,
): CreateProductV2Request {
  const payload = buildCreateProductV2Request(input)
  return {
    ...payload,
    purchaseForm: Array.isArray(input.purchaseForm) ? input.purchaseForm : [],
  }
}

export async function createAdminPlatformProductV2(
  payload: CreateProductV2Request,
): Promise<CreateProductV2Result> {
  const { data } = await api.post<CreateProductV2Result>('/admin/products', payload)
  return data
}
