// Run from the server runtime root through node --input-type=module -.
// All provider operations are read-only. Never print delivery content or URLs.
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { prisma } from './dist/lib/prisma.js'
import { callFakaOrderStatus } from './dist/lib/fakaBridge/client.js'
import { formatTrafficBytes } from './dist/lib/fakaBridge/subscriptionResult.js'
import { parseStoredStructuredContent } from './dist/lib/deliveryFields.js'

const ids = [...new Set((process.env.FAKA_REPAIR_ORDER_IDS ?? '').split(',').map(Number))]
assert(ids.length && ids.every(id => Number.isSafeInteger(id) && id > 0), 'Explicit order IDs required')
const apply = process.env.FAKA_REPAIR_APPLY === '1'
const adminId = Number(process.env.FAKA_REPAIR_ADMIN_ID)
assert(Number.isSafeInteger(adminId) && adminId > 0, 'Explicit operator admin ID required')
assert.equal((await prisma.user.findUnique({ where: { id: adminId }, select: { role: true } }))?.role, 'admin')
const backupPath = '/tmp/faka-delivery-originals.json'
const originals = []
try {
  for (const id of ids) {
    const order = await prisma.order.findUnique({ where: { id }, include: { delivery: true, fakaBridgeTask: true } })
    assert(order?.status === 'delivered' && order.delivery && order.fakaBridgeTask?.status === 'succeeded', `Order ${id} is not a completed delivery`)
    assert.equal(order.fakaBridgeTask.protocolVersion, 1, 'Only legacy paid orders supported')
    assert(order.delivery.expiresAt == null || order.delivery.expiresAt > new Date(), 'Expired delivery excluded')
    const delivery = order.delivery
    const structured = parseStoredStructuredContent(delivery.structuredContent)
    assert(structured, 'Valid existing structured delivery required')
    const result = await callFakaOrderStatus(order.fakaBridgeTask.requestOrderNo)
    assert(result.ok && result.body?.success && result.body.status === 'completed', `Order ${id} remote status unavailable`)
    assert.equal(result.body.order_no, order.fakaBridgeTask.requestOrderNo)
    assert.equal(result.body.trade_no, order.fakaBridgeTask.xboardTradeNo)
    const rawUrl = result.body.subscription?.subscribe_url
    assert(typeof rawUrl === 'string' && rawUrl.length <= 2000 && !/[\s\u0000-\u001f\u007f]/.test(rawUrl), 'Subscription URL missing/invalid')
    const url = new URL(rawUrl)
    assert(url.protocol === 'https:' && !url.username && !url.password, 'HTTPS credential URL required')
    if (structured.values.subscribeUrl === url.href && !delivery.content?.includes('总量 1 GB')) {
      console.log(JSON.stringify({ orderId: id, skipped: true, reason: 'already_repaired' }))
      continue
    }
    originals.push({ orderId: id, delivery })
    if (!apply) {
      fs.writeFileSync(backupPath, JSON.stringify(originals), { mode: 0o600 })
      console.log(JSON.stringify({ orderId: id, ready: true, backupPath, subscriptionHost: url.hostname }))
      continue
    }
    assert(fs.existsSync(backupPath), 'Dry run backup required before apply')
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
    assert(backup.some(row => row.orderId === id && row.delivery.id === delivery.id && row.delivery.content === delivery.content), 'Backup mismatch; inspect before retry')
    let content = delivery.content ?? ''
    // Only correct the confirmed zero-use 100 GiB incident. Other historical
    // before/after snapshots must not be replaced by current live usage.
    const after = result.body.subscription?.after
    const repairTraffic = [55, 56].includes(id) && structured.values.action === '新购开通'
      && after?.transfer_enable === 100 * 1024 ** 3 && after.used === 0
      && structured.values.trafficAfter === '剩余 1 GB（总量 1 GB）'
    if (repairTraffic) {
      structured.values.trafficAfter = `剩余 ${formatTrafficBytes(after.remaining)}（总量 ${formatTrafficBytes(after.transfer_enable)}）`
      content = content.replace('购买后流量: 剩余 1 GB / 总量 1 GB（已用 0 B）', '购买后流量: 剩余 100 GB / 总量 100 GB（已用 0 B）')
    }
    structured.fields = structured.fields.filter(field => !['panel', 'subscribeUrl'].includes(field.key))
    delete structured.values.panel
    structured.fields.push({ key: 'subscribeUrl', label: '订阅链接', sensitive: true })
    structured.values.subscribeUrl = url.href
    if (structured.fields.length > 8) {
      structured.fields = structured.fields.filter(field => field.key !== 'period')
      delete structured.values.period
    }
    assert(parseStoredStructuredContent(structured), 'Invalid delivery field contract')
    content = content.split('\n').filter(line => !line.startsWith('面板: ') && !line.startsWith('订阅链接: ') && !line.startsWith('请使用上述邮箱登录面板') && !line.startsWith('请复制订阅链接')).join('\n')
      + `\n订阅链接: ${url.href}\n请复制订阅链接导入客户端。链接含有访问凭据，请勿分享。`
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`
      const current = await tx.order.findUnique({ where: { id }, select: { status: true } })
      assert.equal(current?.status, 'delivered', 'Order status changed')
      const updated = await tx.deliveryRecord.updateMany({ where: { id: delivery.id, content: delivery.content }, data: { content, structuredContent: structured } })
      assert.equal(updated.count, 1, 'Concurrent delivery update')
      await tx.adminLog.create({ data: { adminUserId: adminId, action: 'delivery.subscription_credential_repair', targetType: 'order', targetId: id,
        detail: JSON.stringify({ source: 'signed_read_only_order_status', subscriptionCredentialAdded: true, trafficDisplayCorrected: repairTraffic, noProvisioningOrPointMutation: true }) } })
      await tx.orderStatusEvent.create({ data: { orderId: id, actorUserId: adminId, actorRole: 'admin', fromStatus: 'delivered', toStatus: 'delivered', action: 'delivery.corrected',
        publicNote: '已补齐订阅链接并核对套餐流量。', internalNote: 'Read-only provider evidence; no new provisioning, no balance mutation. URL values excluded from audit.' } })
    })
    console.log(JSON.stringify({ orderId: id, repaired: true, trafficDisplayCorrected: repairTraffic, credentialAdded: true }))
  }
} finally {
  await prisma.$disconnect()
}
