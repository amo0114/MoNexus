import request from 'supertest'
import bcrypt from 'bcryptjs'
import { app } from '../app.js'
import { prisma } from '../lib/prisma.js'

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
      inviteCode: `TEST-${email}`,
    },
  })
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
  const product = await prisma.product.create({
    data: {
      name,
      type: '网络节点',
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

export interface AuthCookies {
  accessToken: string
  cookies: string[]
}

export async function loginAs(
  email: string,
  password: string
): Promise<AuthCookies> {
  const res = await api
    .post('/api/auth/login')
    .send({ email, password })
    .expect(200)

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
  const offer = await prisma.offer.findFirstOrThrow({
    where: { productId },
    orderBy: { id: 'asc' },
    select: { id: true },
  })
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
  const product = await prisma.product.create(args)
  await prisma.offer.create({
    data: {
      productId: product.id,
      name: '默认规格',
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
