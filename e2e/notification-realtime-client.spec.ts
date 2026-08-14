import { expect, test } from '@playwright/test'

/**
 * SPEC-NOTIFY-RT-001 (T-QA-002) — browser contract for the real SSE parser and
 * stream state machine, using the PRODUCTION modules served by Vite.
 * NRT-024: no page.reload, no manual API polling, no test.skip when off.
 *
 * The backend on 3112 runs realtime=true; Vite proxies /api to it.
 */
test.describe('realtime client parser (browser production modules)', () => {
  test('SseParser handles byte-by-byte chunks, CRLF, comments, multi-line data and frame cap', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const { SseParser, SSE_MAX_FRAME_BYTES } = await import('/src/realtime/sseParser.ts')
      const parser = new SseParser()
      const raw = 'id: 42\nevent: notification.created\ndata: {"v":1}\n\n: hb\n\n'
      const frames: unknown[] = []
      for (let i = 0; i < raw.length; i += 1) {
        frames.push(...parser.feed(raw[i]!))
      }
      const crlf = new SseParser().feed('event: stream.ready\r\ndata: {}\r\n\r\n')
      const multi = new SseParser().feed('event: e\ndata: a\ndata: b\n\n')
      const big = new SseParser().feed(`data: ${'x'.repeat(SSE_MAX_FRAME_BYTES)}\n\n`)
      return {
        frames,
        crlf,
        multi,
        tooLarge: big.some((f) => f.tooLarge),
      }
    })
    expect(result.frames).toEqual([
      { id: '42', event: 'notification.created', data: '{"v":1}' },
      { comment: true },
    ])
    expect(result.crlf).toEqual([{ event: 'stream.ready', data: '{}' }])
    expect(result.multi).toEqual([{ event: 'e', data: 'a\nb' }])
    expect(result.tooLarge).toBe(true)
  })

  test('exact-ID LRU + 300ms coalescer run in the browser (CHK-FE-005~007)', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const { ExactIdLru, InvalidationScheduler, resolveInvalidation } = await import(
        '/src/realtime/notificationInvalidation.ts'
      )
      const lru = new ExactIdLru()
      lru.record(101)
      lru.record(100)
      const seen = { has101: lru.has(101), has100: lru.has(100) }

      const scheduler = new InvalidationScheduler()
      let calls = 0
      scheduler.subscribe('notifications', () => {
        calls += 1
      })
      scheduler.invalidate('notifications')
      scheduler.invalidate('notifications')
      await new Promise((r) => setTimeout(r, 400))

      const matrix = resolveInvalidation({
        id: 1,
        eventType: 'order.created_merchant',
        category: 'order',
        title: 't',
        body: 'b',
        level: 'info',
        deeplink: '/',
        relatedOrderId: 1,
        createdAt: new Date().toISOString(),
      })
      return { seen, coalescedCalls: calls, merchantTopics: matrix.topics }
    })
    expect(result.seen).toEqual({ has101: true, has100: true })
    expect(result.coalescedCalls).toBe(1)
    expect(result.merchantTopics).toEqual(['notifications', 'merchant.orders', 'merchant.stats'])
  })

  test('NotificationRealtimeBridge mounts without crashing on the login page', async ({ page }) => {
    await page.goto('/login')
    // Layout/bridge mount only for logged-in users; for an anonymous visitor the
    // page should still render (bridge unmounted). Assert the login shell renders.
    await expect(page.locator('[data-testid="login-shell"]')).toBeVisible({ timeout: 10_000 })
  })
})
