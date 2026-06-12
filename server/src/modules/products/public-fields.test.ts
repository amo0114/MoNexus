import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { api } from '../../__tests__/helpers.js'

describe('public product endpoints with instant_fixed', () => {
  it('never exposes fixedContent and includes stockMode/deliveryMode', async () => {
    const product = await prisma.product.create({
      data: {
        name: '公开字段商品', type: '邀请码', price: 100, stock: 0, status: 'active',
        deliveryMode: 'instant_fixed', stockMode: 'unlimited',
        fixedContent: 'SECRET-PAID-CONTENT', fixedContentType: 'url',
      },
    })

    const detail = await api.get(`/api/products/${product.id}`).expect(200)
    expect(JSON.stringify(detail.body)).not.toContain('SECRET-PAID-CONTENT')
    expect(detail.body.stockMode).toBe('unlimited')
    expect(detail.body.deliveryMode).toBe('instant_fixed')

    const list = await api.get('/api/products').expect(200)
    expect(JSON.stringify(list.body)).not.toContain('SECRET-PAID-CONTENT')
  })
})
