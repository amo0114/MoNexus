import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ASSURANCE_POLICY_CODE, ASSURANCE_POLICY_TEXT } from './constants.js'
import { parseProductDetails } from './templates/productDetails.js'
import type { ProductDetails, TemplateAttributes, TemplateKey } from './templates/types.js'

type Client = typeof prisma | Prisma.TransactionClient

export type ProductContentSnapshot = {
  version: 1
  contentVersion: number
  templateKey: TemplateKey | null
  templateVersion: number | null
  productAttributes: TemplateAttributes
  offerAttributes: TemplateAttributes
  details: ProductDetails
  assurance: null | {
    grantId: number
    policyCode: typeof ASSURANCE_POLICY_CODE
    policyText: string
    validUntil: string
  }
}

function asTemplateAttributes(value: Prisma.JsonValue | null | undefined): TemplateAttributes {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return {}
  const attributes: TemplateAttributes = {}
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === 'string'
      || typeof entry === 'number'
      || typeof entry === 'boolean'
      || (Array.isArray(entry) && entry.every(item => typeof item === 'string'))
    ) {
      attributes[key] = entry
    }
  }
  return attributes
}

export function buildProductContentSnapshot(input: {
  contentVersion: number
  templateKey: string | null
  templateVersion: number | null
  productAttributes: Prisma.JsonValue | null
  offerAttributes: Prisma.JsonValue | null
  details: Prisma.JsonValue | null
  assurance: null | { grantId: number; validUntil: Date }
}): ProductContentSnapshot {
  return {
    version: 1,
    contentVersion: input.contentVersion,
    templateKey: (input.templateKey as TemplateKey | null) ?? null,
    templateVersion: input.templateVersion,
    productAttributes: asTemplateAttributes(input.productAttributes),
    offerAttributes: asTemplateAttributes(input.offerAttributes),
    details: parseProductDetails(input.details ?? undefined),
    assurance: input.assurance
      ? {
          grantId: input.assurance.grantId,
          policyCode: ASSURANCE_POLICY_CODE,
          policyText: ASSURANCE_POLICY_TEXT,
          validUntil: input.assurance.validUntil.toISOString(),
        }
      : null,
  }
}

export async function loadEffectiveAssuranceGrant(
  tx: Client,
  productId: number,
): Promise<{ grantId: number; validUntil: Date } | null> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CLOCK_TIMESTAMP() AS now`
  const now = rows[0]?.now ?? new Date()
  const grant = await tx.productAssuranceGrant.findFirst({
    where: {
      productId,
      status: 'active',
      validFrom: { lte: now },
      validUntil: { gt: now },
    },
    select: { id: true, validUntil: true },
    orderBy: { id: 'desc' },
  })
  return grant ? { grantId: grant.id, validUntil: grant.validUntil } : null
}
