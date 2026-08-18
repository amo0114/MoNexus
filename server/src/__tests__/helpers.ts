import request from 'supertest'
import bcrypt from 'bcryptjs'
import { app } from '../app.js'
import { generateInviteCode } from '../lib/inviteCode.js'
import { prisma } from '../lib/prisma.js'
import { decryptMfaSecret, generateTotp } from '../modules/auth/mfa.js'
import { ensureSeedCategories } from '../modules/catalog/bootstrap.js'
import { getActiveCategoryIdByLabel, getActiveNetworkNodeCategoryId } from './catalogFixture.js'
import type { ValuePolicyStatus } from '@prisma/client'
import { provisionValuePolicy } from '../modules/valuePolicy/governance.js'

export const api = request(app)

export async function createTestUser(
  email = 'test@monexus.local',
  password = 'testpass123',
  role: 'user' | 'admin' | 'merchant' = 'user',
  balance = 5000
) {
  const hashed = await bcrypt.hash(password, 10)
  const user = await prisma.user.create({
    data: {
      email,
      password: hashed,
      role,
    },
  })
  // B_CAT：resolver 驱动的建品/导入 API 需要 frozen seed categories 在场；
  // 用本测试用户作 actor 惰性补齐（create-if-missing），不引入额外 fixture 用户。
  await ensureSeedCategories(user.id)
  await prisma.pointAccount.create({
    data: { userId: user.id, balance },
  })
  await prisma.pointLog.create({
    data: {
      userId: user.id,
      type: 'in',
      amount: balance,
      balanceAfter: balance,
      reason: '测试初始积分',
    },
  })
  return { user, password }
}

/**
 * SPEC-INVITE-001：直插一枚可用的一次性邀请码（绕过发码资格与名额），
 * 供注册链路用例造数。默认 active、14 天有效。
 */
export async function issueTestInviteCode(
  issuerId: number,
  options: {
    code?: string
    status?: 'active' | 'used' | 'expired' | 'revoked'
    expiresAt?: Date
    createdAt?: Date
  } = {}
) {
  return prisma.inviteCode.create({
    data: {
      code: options.code ?? generateInviteCode(),
      issuerId,
      status: options.status ?? 'active',
      expiresAt: options.expiresAt ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    },
  })
}

export async function createTestMerchant(
  email = 'merchant@test.local',
  password = 'merchant123',
  options?: {
    role?: 'user' | 'merchant'
    balance?: number
    name?: string
    status?: 'pending' | 'active' | 'suspended' | 'rejected'
    commissionRate?: number
    contactEmail?: string
    contactPhone?: string
  }
) {
  const role = options?.role ?? (options?.status === 'active' ? 'merchant' : 'user')
  const { user } = await createTestUser(email, password, role, options?.balance ?? 5000)
  const merchant = await prisma.merchant.create({
    data: {
      userId: user.id,
      name: options?.name ?? '测试商家',
      status: options?.status ?? 'active',
      commissionRate: options?.commissionRate ?? 0.1,
      contactEmail: options?.contactEmail ?? email,
      contactPhone: options?.contactPhone,
      approvedAt: options?.status === 'active' ? new Date() : null,
    },
  })

  return { user, merchant, password }
}

export async function createTestProduct(
  name = '测试商品',
  price = 100,
  stock = 5,
  items: string[] = ['item-1', 'item-2', 'item-3', 'item-4', 'item-5'],
  merchantId?: number
) {
  // B_CAT：type 恒为 网络节点 → 注入对应 ACTIVE categoryId（D-CAT-09）。
  const categoryId = await getActiveNetworkNodeCategoryId()
  const product = await prisma.product.create({
    data: {
      name,
      type: '网络节点',
      categoryId,
      price,
      status: 'active',
      stock: items.length || stock,
      merchantId,
    },
  })
  // P4a：Offer 是价格/履约配置真相源；测试商品同步建一条默认 Offer。
  const offer = await prisma.offer.create({
    data: {
      productId: product.id,
      name: '默认规格',
      isDefault: true,
      price,
      stock: items.length || stock,
    },
  })
  for (const content of items) {
    await prisma.inventoryItem.create({
      data: { productId: product.id, offerId: offer.id, content, status: 'available' },
    })
  }
  return product
}

export async function createTestCnyValuePolicy(options?: {
  id?: string
  version?: number
  status?: ValuePolicyStatus
  numerator?: bigint
  denominator?: bigint
  effectiveAt?: Date
  createdAt?: Date
  referenceAssetCode?: string
  pointAssetCode?: string
}) {
  const version = options?.version ?? 1
  return prisma.$transaction(tx => provisionValuePolicy(tx, {
    id: options?.id ?? `vp_cny_${version}`,
    version,
    pointAssetCode: options?.pointAssetCode,
    referenceAssetCode: options?.referenceAssetCode,
    numerator: options?.numerator,
    denominator: options?.denominator,
    effectiveAt: options?.effectiveAt ?? new Date('2020-01-01T00:00:00.000Z'),
    createdAt: options?.createdAt,
    status: options?.status ?? 'active',
  }))
}

export interface AuthCookies {
  accessToken: string
  cookies: string[]
}

export async function loginAs(
  email: string,
  password: string
): Promise<AuthCookies> {
  const initial = await api
    .post('/api/auth/login')
    .send({ email, password })

  let res = initial
  if (initial.status === 202) {
    const challengeId = initial.body.challengeId
    if (typeof challengeId !== 'string') throw new Error('Expected an MFA challenge')

    if (initial.body.status === 'mfa_enrollment_required') {
      const enrollment = await api
        .post('/api/auth/mfa/enrollment/start')
        .send({ challengeId })
        .expect(200)
      if (typeof enrollment.body.manualKey !== 'string') throw new Error('Expected an MFA enrollment key')
      res = await api
        .post('/api/auth/mfa/enrollment/confirm')
        .send({ challengeId, code: generateTotp(enrollment.body.manualKey) })
        .expect(201)
    } else if (initial.body.status === 'mfa_required') {
      const user = await prisma.user.findUnique({
        where: { email },
        select: { mfaSecretEncrypted: true },
      })
      if (!user?.mfaSecretEncrypted) throw new Error('Expected an enrolled test administrator')
      const code = generateTotp(decryptMfaSecret(user.mfaSecretEncrypted))
      res = await api
        .post('/api/auth/mfa/verify')
        .send({ challengeId, method: 'totp', code })
        .expect(200)
    } else {
      throw new Error('Unexpected MFA challenge state')
    }
  }

  if (res.status !== 200 && res.status !== 201) throw new Error('Expected a successful login')

  const cookies = (res.headers['set-cookie'] as unknown) as string[] | undefined
  return {
    accessToken: res.body.accessToken,
    cookies: cookies ?? [],
  }
}

export async function loginAsMerchant(email: string, password: string) {
  return loginAs(email, password)
}

export function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` }
}

/** P4a：取商品默认 Offer id（测试里手工造库存条目时挂载用）。 */
export async function getDefaultOfferId(productId: number): Promise<number> {
  const offer =
    (await prisma.offer.findFirst({
      where: { productId, isDefault: true },
      select: { id: true },
    })) ??
    (await prisma.offer.findFirstOrThrow({
      where: { productId },
      orderBy: { id: 'asc' },
      select: { id: true },
    }))
  return offer.id
}

/**
 * P4a：把商品切到 manual_service。Offer 是履约配置真相源,必须同步更新默认
 * Offer 与 Product 投影列(低层构造测试场景用,绕过服务层投影同步)。
 */
export async function makeManualService(productId: number) {
  await configureDefaultOffer(productId, { deliveryMode: 'manual_service', stock: 0, stockMode: 'unlimited' })
}

/** 同时存在于 Product 投影列与 Offer 真相源上的商业/履约字段。 */
type OfferProjectionData = Partial<{
  price: number
  originalPrice: number | null
  deliveryMode: string
  stockMode: string
  stock: number
  fixedContent: string | null
  fixedContentType: string
}>

/**
 * P4a：更新默认 Offer(真相源)并同步 Product 投影列。测试里需要在建品后
 * 改动履约/价格配置时,用它替代直接 prisma.product.update,保证两处一致。
 */
export async function configureDefaultOffer(productId: number, data: OfferProjectionData) {
  const offerId = await getDefaultOfferId(productId)
  await prisma.offer.update({ where: { id: offerId }, data })
  await prisma.product.update({ where: { id: productId }, data })
}

/**
 * P4a：等价于 prisma.product.create,但额外建一条复制商业/履约字段的默认
 * Offer(生产路径由服务层的 createDefaultOffer 保证;测试直连 DB 时用它)。
 */
export async function createProductWithOffer(args: { data: any }) {
  const data = args.data ?? {}
  // B_CAT：优先采用调用方显式 categoryId；否则按 legacy type 精确映射 ACTIVE
  // 分类（缺省回落网络节点），保证每次直连 DB 建品都带合法 categoryId（D-CAT-09）。
  const categoryId =
    data.categoryId != null
      ? data.categoryId
      : await getActiveCategoryIdByLabel(
          typeof data.type === 'string' && data.type.trim() ? data.type.trim() : '网络节点',
        )
  const product = await prisma.product.create({
    ...args,
    data: { ...data, categoryId },
  })
  await prisma.offer.create({
    data: {
      productId: product.id,
      name: '默认规格',
      isDefault: true,
      price: product.price,
      originalPrice: product.originalPrice,
      deliveryMode: product.deliveryMode,
      stockMode: product.stockMode,
      stock: product.stock,
      fixedContent: product.fixedContent,
      fixedContentType: product.fixedContentType,
    },
  })
  return product
}
