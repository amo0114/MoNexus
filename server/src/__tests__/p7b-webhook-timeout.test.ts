import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// 打开 e2e 逃生开关:允许 http + 127.0.0.1 目标,真实 HTTP 服务器验证
// 总时限行为(mock 不了 socket 语义)。其余 config 保持真实值。
vi.mock('../config/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../config/index.js')>()
  return { ...actual, config: { ...actual.config, autoProvisionAllowInsecureTargets: true } }
})

import { createServer, type Server } from 'node:http'
import { callWebhook, signWebhookPayload, WebhookTargetError } from '../lib/outboundWebhook.js'

/**
 * P7b 复审 R2-P2 回归:node request 的 `timeout` 只是 **socket 空闲超时**,
 * 持续慢滴的响应永不空闲、可长期占住 worker。callWebhook 必须受硬性
 * **墙钟总时限**约束。
 */

let server: Server
let port = 0
const dripTimers: NodeJS.Timeout[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/drip') {
      // 复审场景:2xx 头 + 每 50ms 滴一个字节,永不结束——空闲超时永不触发。
      res.writeHead(200, { 'content-type': 'application/json' })
      const timer = setInterval(() => res.write('x'), 50)
      dripTimers.push(timer)
      res.on('close', () => clearInterval(timer))
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ content: 'ok' }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  dripTimers.forEach(clearInterval)
  await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('R2-P2 callWebhook 硬性总时限', () => {
  const sig = signWebhookPayload('s'.repeat(64), '{}', 1)

  it('慢滴响应被墙钟总时限切断(诊断码 timeout,不受 socket 空闲语义蒙蔽)', async () => {
    const t0 = Date.now()
    await expect(
      callWebhook(`http://127.0.0.1:${port}/drip`, '{}', sig, { timeoutMs: 400 })
    ).rejects.toMatchObject({ code: 'timeout' })
    // 400ms 时限 + 落定余量:远小于"永远"。
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('时限内完成的正常响应不受影响', async () => {
    const result = await callWebhook(`http://127.0.0.1:${port}/ok`, '{}', sig, { timeoutMs: 2000 })
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ content: 'ok' })
  })

  it('rejects 的是 WebhookTargetError(诊断码可被 classify 归类,不落远端内容)', async () => {
    try {
      await callWebhook(`http://127.0.0.1:${port}/drip`, '{}', sig, { timeoutMs: 300 })
      expect.unreachable('should have timed out')
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookTargetError)
      expect((err as WebhookTargetError).code).toBe('timeout')
    }
  })
})
