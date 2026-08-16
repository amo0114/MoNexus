// B_CAT — catalog category application bootstrap (SPEC-CATALOG-OPS-001 §11.2).
//
// Idempotently materialises the SAME five frozen seed codes that migration
// 20260809020000 seeds on legacy upgrade: four active categories plus one
// inactive `legacy-unclassified`. This is create-if-missing only — it never
// overwrites runtime edits (D-CAT-07 governance) and never implements CRUD.
//
// On a brand-new database (zero users) the migration's seed block is skipped;
// the application bootstrap then creates the categories here, recording the
// caller as creator/updater (no synthetic user is ever inserted).

import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import {
  CATEGORY_SEED_CODES,
  CATEGORY_STATUS,
  SEED_CATEGORY_CODE,
  type SeedCategoryCode,
} from './constants.js'

type Client = typeof prisma | Prisma.TransactionClient

export interface SeedCategoryRow {
  code: SeedCategoryCode
  label: string
  normalizedLabel: string
  description: string | null
  sortOrder: number
  status: string
}

/**
 * Frozen seed rows — values MUST stay byte-identical to migration
 * 20260809020000 (normalizedLabel is the label for these Chinese labels).
 */
export const SEED_CATEGORY_ROWS: readonly SeedCategoryRow[] = [
  {
    code: SEED_CATEGORY_CODE.NETWORK_NODE,
    label: '网络节点',
    normalizedLabel: '网络节点',
    description: null,
    sortOrder: 10,
    status: CATEGORY_STATUS.ACTIVE,
  },
  {
    code: SEED_CATEGORY_CODE.SHARED_ACCOUNT,
    label: '共享账号',
    normalizedLabel: '共享账号',
    description: null,
    sortOrder: 20,
    status: CATEGORY_STATUS.ACTIVE,
  },
  {
    code: SEED_CATEGORY_CODE.RECHARGE_CARD,
    label: '充值卡密',
    normalizedLabel: '充值卡密',
    description: null,
    sortOrder: 30,
    status: CATEGORY_STATUS.ACTIVE,
  },
  {
    code: SEED_CATEGORY_CODE.INVITE_CODE,
    label: '邀请码',
    normalizedLabel: '邀请码',
    description: null,
    sortOrder: 40,
    status: CATEGORY_STATUS.ACTIVE,
  },
  {
    code: SEED_CATEGORY_CODE.LEGACY_UNCLASSIFIED,
    label: '待归类',
    normalizedLabel: '待归类',
    description: '历史数据中未映射到正式分类的商品归入此类',
    sortOrder: 0,
    status: CATEGORY_STATUS.INACTIVE,
  },
]

/**
 * Ensure the five frozen seed categories exist (create-if-missing by code).
 * Returns the current rows for the frozen seed codes (created or pre-existing).
 */
export async function ensureSeedCategories(
  actorId: number,
  db: Client = prisma,
) {
  for (const row of SEED_CATEGORY_ROWS) {
    const existing = await db.productCategory.findUnique({
      where: { code: row.code },
      select: { id: true },
    })
    if (existing) continue
    await db.productCategory.create({
      data: {
        code: row.code,
        label: row.label,
        normalizedLabel: row.normalizedLabel,
        description: row.description,
        sortOrder: row.sortOrder,
        status: row.status,
        createdByUserId: actorId,
        updatedByUserId: actorId,
      },
    })
  }

  return db.productCategory.findMany({
    where: { code: { in: [...CATEGORY_SEED_CODES] } },
    orderBy: { sortOrder: 'asc' },
  })
}
