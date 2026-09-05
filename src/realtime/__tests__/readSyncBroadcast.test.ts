import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetReadSyncBroadcastForTests,
  broadcastReadInvalidation,
  subscribeReadInvalidation,
} from '../readSyncBroadcast.js'

/**
 * PR-5 — BroadcastChannel 同源已读同步。
 * jsdom 不做真实的跨实例消息投递，这里注入一个语义等价的内存实现。
 * 传输语义（同规范）：频道不把消息回发给发送者自身——所以本模块的订阅者
 * 由「探针频道」的 postMessage 触发（等价于另一个 Tab 的模块实例广播）。
 */

type Message = { data: unknown }

const CHANNEL_NAME = 'monexus-notification-read-sync-v1'

class FakeBroadcastChannel {
  private static readonly registry = new Map<string, FakeBroadcastChannel[]>()
  onmessage: ((event: Message) => void) | null = null
  constructor(public readonly name: string) {
    const list = FakeBroadcastChannel.registry.get(name) ?? []
    FakeBroadcastChannel.registry.set(name, [...list, this])
  }
  postMessage(data: unknown): void {
    for (const peer of FakeBroadcastChannel.registry.get(this.name) ?? []) {
      if (peer === this) continue // 规范：不投递给发送者自身
      peer.onmessage?.({ data })
    }
  }
  close(): void {
    const list = FakeBroadcastChannel.registry.get(this.name) ?? []
    FakeBroadcastChannel.registry.set(this.name, list.filter((c) => c !== this))
  }
  static reset(): void {
    FakeBroadcastChannel.registry.clear()
  }
}

beforeEach(() => {
  __resetReadSyncBroadcastForTests()
  FakeBroadcastChannel.reset()
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
})

afterEach(() => {
  __resetReadSyncBroadcastForTests()
  FakeBroadcastChannel.reset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('readSyncBroadcast (PR-5)', () => {
  it('signals from another tab reach subscribers; unsubscribe stops delivery', () => {
    const received: string[] = []
    const unsubscribe = subscribeReadInvalidation(() => received.push('tab-b'))

    // 另一个 Tab 的模块实例广播 → 本 Tab 频道 onmessage → 订阅者触发。
    new FakeBroadcastChannel(CHANNEL_NAME).postMessage({ v: 1 })
    expect(received).toEqual(['tab-b'])

    unsubscribe()
    new FakeBroadcastChannel(CHANNEL_NAME).postMessage({ v: 1 })
    expect(received).toEqual(['tab-b'])
  })

  it('multiple subscribers all fire; unsubscribe removes only one', () => {
    const a = vi.fn()
    const b = vi.fn()
    const unsubA = subscribeReadInvalidation(a)
    subscribeReadInvalidation(b)

    new FakeBroadcastChannel(CHANNEL_NAME).postMessage({ v: 1 })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)

    unsubA()
    new FakeBroadcastChannel(CHANNEL_NAME).postMessage({ v: 1 })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
  })

  it('broadcast carries only the invalidation signal — no payload content', () => {
    const captured: unknown[] = []
    const probe = new FakeBroadcastChannel(CHANNEL_NAME)
    probe.onmessage = (event) => captured.push(event.data)

    subscribeReadInvalidation(() => {})
    broadcastReadInvalidation()

    expect(captured).toEqual([{ v: 1 }])
  })

  it('broadcasting with no subscribers is a safe no-op', () => {
    expect(() => broadcastReadInvalidation()).not.toThrow()
  })
})
