import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { EMPTY_PRODUCT_DETAILS } from '../modules/catalog/templates/types.js'
import { getActiveCategoryIdByLabel } from './catalogFixture.js'

const V2_MIGRATION = '20260909120000_product_commerce_v2_foundation'
const BUYER_EMAIL = 'pcv2-upgrade-conservation@test.local'
const PRODUCT_NAME = 'pcv2-upgrade-baseline-product'

type ColumnRow = {
  table_name: string
  column_name: string
  is_nullable: string
  column_default: string | null
}

function columnMap(rows: ColumnRow[]) {
  return new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row]))
}

async function cleanupUpgradeRows() {
  await prisma.order.deleteMany({ where: { user: { email: BUYER_EMAIL } } })
  await prisma.inventoryItem.deleteMany({ where: { product: { name: PRODUCT_NAME } } })
  await prisma.offer.deleteMany({ where: { product: { name: PRODUCT_NAME } } })
  await prisma.product.deleteMany({ where: { name: PRODUCT_NAME } })
  await prisma.user.deleteMany({ where: { email: BUYER_EMAIL } })
}

describe('product commerce v2 upgrade conservation (SPEC-PRODUCT-COMMERCE-002 AC-15)', () => {
  afterEach(cleanupUpgradeRows)

  it('records the v2 foundation migration and exposes additive columns/tables', async () => {
    const applied = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name
      FROM _prisma_migrations
      WHERE migration_name = ${V2_MIGRATION}
        AND finished_at IS NOT NULL
    `
    expect(applied).toEqual([{ migration_name: V2_MIGRATION }])

    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'ProductShareLink',
          'ProductAssuranceApplication',
          'ProductAssuranceGrant',
          'InventoryItem',
          'InventoryLog',
          'Order',
          'DeliveryFile',
          'ExternalCatalogLink'
        )
      ORDER BY table_name
    `
    expect(tables.map((row) => row.table_name)).toEqual([
      'DeliveryFile',
      'ExternalCatalogLink',
      'InventoryItem',
      'InventoryLog',
      'Order',
      'ProductAssuranceApplication',
      'ProductAssuranceGrant',
      'ProductShareLink',
    ])

    const columns = columnMap(await prisma.$queryRaw<ColumnRow[]>`
      SELECT table_name, column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'Product' AND column_name IN (
            'visibility', 'contentVersion', 'templateKey', 'templateVersion',
            'attributes', 'details', 'stock', 'sales'
          ))
          OR (table_name = 'Offer' AND column_name IN ('attributes', 'fixedStructuredContent'))
          OR (table_name = 'Order' AND column_name IN ('productContentSnapshot', 'price', 'status'))
          OR (table_name = 'DeliveryFile' AND column_name IN ('merchantId', 'uploadedByUserId', 'key'))
          OR (table_name = 'ExternalCatalogLink' AND column_name IN (
            'latestDescriptionHash', 'latestDescriptionHtml', 'latestDescriptionText',
            'descriptionCheckedAt', 'acceptedDescriptionHash'
          ))
        )
    `)

    expect(columns.get('Product.visibility')).toEqual(expect.objectContaining({
      is_nullable: 'NO',
      column_default: expect.stringContaining('members_only'),
    }))
    expect(columns.get('Product.contentVersion')).toEqual(expect.objectContaining({
      is_nullable: 'NO',
      column_default: expect.stringMatching(/\b1\b/),
    }))
    expect(columns.get('Product.templateKey')?.is_nullable).toBe('YES')
    expect(columns.get('Product.templateVersion')?.is_nullable).toBe('YES')
    expect(columns.get('Product.attributes')?.is_nullable).toBe('NO')
    expect(columns.get('Product.attributes')?.column_default).toContain('{}')
    expect(columns.get('Product.details')?.is_nullable).toBe('NO')
    expect(columns.get('Product.details')?.column_default).toContain('highlights')
    expect(columns.get('Product.stock')).toBeDefined()
    expect(columns.get('Product.sales')).toBeDefined()

    expect(columns.get('Offer.attributes')?.is_nullable).toBe('NO')
    expect(columns.get('Offer.fixedStructuredContent')?.is_nullable).toBe('YES')

    expect(columns.get('Order.productContentSnapshot')).toEqual({
      table_name: 'Order',
      column_name: 'productContentSnapshot',
      is_nullable: 'YES',
      column_default: null,
    })
    expect(columns.get('Order.price')).toBeDefined()
    expect(columns.get('Order.status')).toBeDefined()

    expect(columns.get('DeliveryFile.merchantId')?.is_nullable).toBe('YES')
    expect(columns.get('DeliveryFile.uploadedByUserId')?.is_nullable).toBe('YES')
    expect(columns.get('DeliveryFile.key')).toBeDefined()

    for (const column of [
      'latestDescriptionHash',
      'latestDescriptionHtml',
      'latestDescriptionText',
      'descriptionCheckedAt',
      'acceptedDescriptionHash',
    ] as const) {
      expect(columns.get(`ExternalCatalogLink.${column}`)?.is_nullable).toBe('YES')
    }

    const constraints = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname
      FROM pg_constraint
      WHERE conname IN (
        'Product_visibility_check',
        'Product_template_key_version_check',
        'Product_contentVersion_positive_check',
        'DeliveryFile_owner_actor_check'
      )
      ORDER BY conname
    `
    expect(constraints.map((row) => row.conname)).toEqual([
      'DeliveryFile_owner_actor_check',
      'Product_contentVersion_positive_check',
      'Product_template_key_version_check',
      'Product_visibility_check',
    ])
  })

  it('defaults a product inserted without visibility to members_only', async () => {
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    await prisma.user.create({
      data: { email: BUYER_EMAIL, password: 'x', role: 'user' },
    })

    const [inserted] = await prisma.$queryRaw<Array<{
      id: number
      visibility: string
      contentVersion: number
      templateKey: string | null
      templateVersion: number | null
      attributes: unknown
      details: unknown
    }>>`
      INSERT INTO "Product" ("name", "type", "price", "categoryId")
      VALUES (${PRODUCT_NAME}, '充值卡密', 100, ${categoryId})
      RETURNING
        id,
        visibility,
        "contentVersion",
        "templateKey",
        "templateVersion",
        attributes,
        details
    `

    expect(inserted).toMatchObject({
      visibility: 'members_only',
      contentVersion: 1,
      templateKey: null,
      templateVersion: null,
      attributes: {},
      details: EMPTY_PRODUCT_DETAILS,
    })

    const stored = await prisma.product.findUniqueOrThrow({ where: { id: inserted.id } })
    expect(stored.visibility).toBe('members_only')
    expect(stored.contentVersion).toBe(1)
    expect(stored.templateKey).toBeNull()
    expect(await prisma.productAssuranceGrant.count({ where: { productId: stored.id } })).toBe(0)
    expect(await prisma.productShareLink.count({ where: { productId: stored.id } })).toBe(0)
  })

  it('keeps historical order content snapshots nullable and unfilled', async () => {
    const categoryId = await getActiveCategoryIdByLabel('充值卡密')
    const buyer = await prisma.user.create({
      data: { email: BUYER_EMAIL, password: 'x', role: 'user' },
    })
    const [product] = await prisma.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "Product" ("name", "type", "price", "categoryId")
      VALUES (${PRODUCT_NAME}, '充值卡密', 100, ${categoryId})
      RETURNING id
    `
    const offer = await prisma.offer.create({
      data: { productId: product.id, name: '默认规格', isDefault: true, price: 100 },
    })
    const inventory = await prisma.inventoryItem.create({
      data: {
        productId: product.id,
        offerId: offer.id,
        content: 'PCV2-UPGRADE-CARD-0001',
        status: 'available',
      },
    })

    const [order] = await prisma.$queryRaw<Array<{
      id: number
      productContentSnapshot: unknown
    }>>`
      INSERT INTO "Order" ("userId", "productId", "offerId", "price", "status")
      VALUES (${buyer.id}, ${product.id}, ${offer.id}, 100, 'delivered')
      RETURNING id, "productContentSnapshot"
    `

    expect(order.productContentSnapshot).toBeNull()
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(stored.productContentSnapshot).toBeNull()
    expect(stored.offerId).toBe(offer.id)
    expect(inventory.status).toBe('available')
    expect(await prisma.inventoryItem.count({ where: { productId: product.id } })).toBe(1)
  })
})
