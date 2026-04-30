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
  for (const content of items) {
    await prisma.inventoryItem.create({
      data: { productId: product.id, content, status: 'available' },
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
