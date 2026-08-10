#!/usr/bin/env node
/**
 * SPEC-NOTIFY-RT-001 (T-QA-004) — multi-instance harness (AC-RT-005 / REQ-F-020).
 *
 * Two independent Node backend processes share one dedicated PostgreSQL DB:
 *   A = 127.0.0.1:3112 (SSE host), B = 127.0.0.1:3113 (order writer).
 * This harness:
 *  1. seeds a merchant / product / buyer in the shared DB;
 *  2. opens an SSE stream on A for the merchant;
 *  3. logs in as the buyer and creates a manual order through B's HTTP API
 *     (so the pg_notify originates in process B);
 *  4. asserts A's stream receives notification.created for the merchant.
 *
 * This proves cross-instance delivery through PostgreSQL LISTEN/NOTIFY, not an
 * in-process EventEmitter (CHK-QA-009~011).
 */
import http from 'node:http'

const PORT_A = Number(process.env.RT_MULTI_PORT_A ?? 3112)
const PORT_B = Number(process.env.RT_MULTI_PORT_B ?? 3113)

function postJson(port, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body ?? {})
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => {
          raw += c
        })
        res.on('end', () => {
          let parsed = {}
          try {
            parsed = JSON.parse(raw)
          } catch { /* keep {} */ }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      }
    )
    req.on('error', reject)
    req.end(data)
  })
}

function openSse(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/notifications/stream',
        method: 'GET',
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
      },
      (res) => {
        const state = { frames: [], closed: false }
        let buffer = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          buffer += chunk
          let idx
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            const frame = {}
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) frame.event = line.slice(6).trim()
              else if (line.startsWith('data:')) frame.data = (frame.data ? `${frame.data}\n` : '') + line.slice(5).trimStart()
            }
            state.frames.push(frame)
          }
        })
        res.on('end', () => {
          state.closed = true
        })
        res.on('close', () => {
          state.closed = true
        })
        resolve(state)
      }
    )
    req.on('error', reject)
    req.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForFrame(sse, event, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (sse.closed) throw new Error(`stream closed before ${event}`)
    if (sse.frames.some((f) => f.event === event)) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${event}; got ${sse.frames.map((f) => f.event).join(',')}`)
}

async function main() {
  // Seed merchant/product/buyer through B's HTTP surface (public register) so
  // the whole flow lives over real HTTP, but product/merchant creation needs
  // an active merchant — use the shared test DB via prisma instead.
  const { prisma } = await import('../src/lib/prisma.js')
  const { default: bcrypt } = await import('bcryptjs')
  const { default: jwt } = await import('jsonwebtoken')
  const { config } = await import('../src/config/index.js')

  const uniq = Date.now()
  const merchantEmail = `rt-multi-m-${uniq}@test.local`
  const buyerEmail = `rt-multi-b-${uniq}@test.local`

  const hashed = await bcrypt.hash('pass123', 10)
  const merchantUser = await prisma.user.create({ data: { email: merchantEmail, password: hashed, role: 'merchant' } })
  const merchant = await prisma.merchant.create({
    data: { userId: merchantUser.id, name: '多实例商家', status: 'active', commissionRate: 0.1, contactEmail: merchantEmail, approvedAt: new Date() },
  })
  const product = await prisma.product.create({
    data: { name: '多实例商品', type: '网络节点', price: 100, status: 'active', stock: 5, merchantId: merchant.id },
  })
  const offer = await prisma.offer.create({
    data: { productId: product.id, name: '人工服务', isDefault: true, price: 100, stock: 5, deliveryMode: 'manual_service' },
  })
  const buyer = await prisma.user.create({ data: { email: buyerEmail, password: hashed, role: 'user' } })
  await prisma.pointAccount.create({ data: { userId: buyer.id, balance: 100000 } })

  const merchantToken = jwt.sign({ userId: merchantUser.id, role: 'merchant' }, config.jwtSecret, { expiresIn: '15m' })
  const buyerToken = jwt.sign({ userId: buyer.id, role: 'user' }, config.jwtSecret, { expiresIn: '15m' })

  // 1. Open SSE on A for the merchant.
  const sse = await openSse(PORT_A, merchantToken)
  await waitForFrame(sse, 'stream.ready', 8000)
  console.log(`[multi] A:${PORT_A} stream.ready received for merchant`)

  // 2. Create a manual order through B's orders API (order write happens in B).
  const created = await postJson(PORT_B, '/api/orders', {
    productId: product.id,
    offerId: offer.id,
    expectedPrice: 100,
  }, buyerToken)
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(`order create on B failed (${created.status}): ${JSON.stringify(created.body)}`)
  }
  const orderId = created.body?.orderId ?? created.body?.id
  if (!orderId) {
    throw new Error(`order create did not return an orderId: ${JSON.stringify(created.body)}`)
  }
  console.log(`[multi] B:${PORT_B} created order ${orderId} (buyer)`)

  // 3. Assert A's stream receives notification.created (cross-instance delivery).
  await waitForFrame(sse, 'notification.created', 8000)
  const createdFrame = sse.frames.find((f) => f.event === 'notification.created')
  const data = JSON.parse(createdFrame.data)
  if (data.notification?.eventType !== 'order.created_merchant') {
    throw new Error(`unexpected eventType ${data.notification?.eventType}`)
  }
  if (data.notification?.relatedOrderId !== Number(orderId)) {
    throw new Error(`relatedOrderId mismatch ${data.notification?.relatedOrderId} vs ${orderId}`)
  }
  console.log(`[multi] A:${PORT_A} received notification.created for order ${orderId} written on B:${PORT_B}`)

  await prisma.$disconnect()
  console.log('[multi] PASS: cross-instance delivery verified')
  process.exit(0)
}

main().catch((err) => {
  console.error('[multi] FAIL:', err.message)
  process.exit(1)
})
