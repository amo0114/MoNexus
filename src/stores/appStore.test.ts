import { beforeEach, describe, expect, it, vi } from 'vitest'

// PR-3：订单红点权威计数刷新的单飞/代际保护。
// 网络层 mock 掉，store 的并发语义用受控 Promise 精确编排。
const getOrderAttentionCount = vi.fn()
vi.mock('../api/orders', () => ({
  getOrderAttentionCount: (...args: unknown[]) => getOrderAttentionCount(...args),
}))
const getUnreadCount = vi.fn()
vi.mock('../api/notifications', () => ({
  getUnreadCount: (...args: unknown[]) => getUnreadCount(...args),
}))
vi.mock('../api/registry', () => ({
  getConfigRegistry: vi.fn(async () => ({ capabilities: {} })),
}))

import { useAppStore } from './appStore'
import { useAuthStore } from './authStore'

const userA = { id: 101, email: 'a@test.local', nickname: 'A', role: 'user', points: 0 }
const userB = { id: 202, email: 'b@test.local', nickname: 'B', role: 'user', points: 0 }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

/** 排空微任务队列：trailing 补跑是 fire-and-forget 的 promise 链，
    宏任务边界后单飞/代际状态必然落定，避免跨用例泄漏。 */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

beforeEach(async () => {
  vi.clearAllMocks()
  useAuthStore.setState({ user: null, accessToken: null, isLoggedIn: false })
  useAppStore.setState({ orderAttentionCount: -1, notificationUnreadCount: 0 })
  await flush()
})

describe('refreshOrderAttention — 权威计数与代际保护 (PR-3)', () => {
  it('登录用户拉取权威计数并写入 store', async () => {
    getOrderAttentionCount.mockResolvedValueOnce(3)
    useAuthStore.setState({ user: userA as never, isLoggedIn: true })
    await useAppStore.getState().refreshOrderAttention()
    expect(getOrderAttentionCount).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().orderAttentionCount).toBe(3)
  })

  it('用户 A 的慢响应在切换到用户 B 后到达：作废；trailing 补跑取到 B 的计数', async () => {
    const slowA = deferred<number>()
    getOrderAttentionCount.mockImplementationOnce(() => slowA.promise)
    useAuthStore.setState({ user: userA as never, isLoggedIn: true })
    const first = useAppStore.getState().refreshOrderAttention()

    // A 的请求在途时切到 B：B 的刷新在单飞窗口内只会登记 trailing 补跑。
    useAuthStore.setState({ user: userB as never, isLoggedIn: true })
    const second = useAppStore.getState().refreshOrderAttention()
    expect(getOrderAttentionCount).toHaveBeenCalledTimes(1)

    // 预注册 trailing 补跑（代表 B 发起）要取的计数，再放行 A 的慢响应。
    getOrderAttentionCount.mockResolvedValueOnce(7)
    slowA.resolve(5)
    await first
    // A 的慢响应（5）因 userId 不匹配被丢弃，此处不能出现 5。
    expect(useAppStore.getState().orderAttentionCount).not.toBe(5)

    await second
    await vi.waitFor(() => {
      expect(useAppStore.getState().orderAttentionCount).toBe(7)
    })
    expect(getOrderAttentionCount).toHaveBeenCalledTimes(2)
    await flush()
  })

  it('登出立即归零：在途响应作废、trailing 补跑取消', async () => {
    const slow = deferred<number>()
    getOrderAttentionCount.mockImplementationOnce(() => slow.promise)
    useAuthStore.setState({ user: userA as never, isLoggedIn: true })
    const first = useAppStore.getState().refreshOrderAttention()
    expect(getOrderAttentionCount).toHaveBeenCalledTimes(1)

    // 登出触发的刷新（Layout 的 user 变化 effect）：同步归零，不排队等待。
    useAuthStore.setState({ user: null, accessToken: null, isLoggedIn: false })
    await useAppStore.getState().refreshOrderAttention()
    expect(useAppStore.getState().orderAttentionCount).toBe(0)

    // 慢响应此后到达：seq 已前移 → 作废，角标保持 0。
    slow.resolve(5)
    await first
    expect(useAppStore.getState().orderAttentionCount).toBe(0)
    await flush()
  })

  it('重新登录后角标恢复该用户的权威计数', async () => {
    getOrderAttentionCount.mockResolvedValueOnce(4)
    useAuthStore.setState({ user: userA as never, isLoggedIn: true })
    await useAppStore.getState().refreshOrderAttention()
    expect(useAppStore.getState().orderAttentionCount).toBe(4)

    useAuthStore.setState({ user: null, accessToken: null, isLoggedIn: false })
    await useAppStore.getState().refreshOrderAttention()
    expect(useAppStore.getState().orderAttentionCount).toBe(0)
    await flush()
  })
})

describe('refreshOrderAttentionIfStale — 补拉去重 (PR-3)', () => {
  it('首次挂载场景：登录初始化拉取后 1s 内的 stream ready 补拉被跳过（只发一笔请求）', async () => {
    getOrderAttentionCount.mockResolvedValue(2)
    useAuthStore.setState({ user: userA as never, isLoggedIn: true })
    await useAppStore.getState().refreshOrderAttention()
    expect(getOrderAttentionCount).toHaveBeenCalledTimes(1)

    await useAppStore.getState().refreshOrderAttentionIfStale()
    expect(getOrderAttentionCount).toHaveBeenCalledTimes(1)
    await flush()
  })

  it('事件驱动的 refreshOrderAttention 不受 1s 间隔限制', async () => {
    getOrderAttentionCount.mockResolvedValue(1)
    useAuthStore.setState({ user: userA as never, isLoggedIn: true })
    await useAppStore.getState().refreshOrderAttention()
    await useAppStore.getState().refreshOrderAttention()
    // 第二次在单飞窗口外直接发起（无在途请求）→ 两次真实网络调用。
    expect(getOrderAttentionCount).toHaveBeenCalledTimes(2)
    await flush()
  })
})

describe('refreshNotificationUnread — 代际保护 (PR-3 复审)', () => {
  it('A 的慢响应在 B 登录后返回：作废；B 的响应正常落位', async () => {
    const slowA = deferred<number>()
    getUnreadCount.mockImplementationOnce(() => slowA.promise)
    useAuthStore.setState({ user: userA as never, isLoggedIn: true })
    const first = useAppStore.getState().refreshNotificationUnread()

    useAuthStore.setState({ user: userB as never, isLoggedIn: true })
    getUnreadCount.mockResolvedValueOnce(9)
    const second = useAppStore.getState().refreshNotificationUnread()

    slowA.resolve(5)
    await first
    // A 的 5 因 userId 不匹配被丢弃，不能写进 B 的界面。
    expect(useAppStore.getState().notificationUnreadCount).not.toBe(5)

    await second
    expect(useAppStore.getState().notificationUnreadCount).toBe(9)
    await flush()
  })

  it('登出时仍有请求在途：立即清零，慢响应作废后保持 0', async () => {
    const slow = deferred<number>()
    getUnreadCount.mockImplementationOnce(() => slow.promise)
    useAuthStore.setState({ user: userA as never, isLoggedIn: true })
    const first = useAppStore.getState().refreshNotificationUnread()

    useAuthStore.setState({ user: null, accessToken: null, isLoggedIn: false })
    await useAppStore.getState().refreshNotificationUnread()
    expect(useAppStore.getState().notificationUnreadCount).toBe(0)

    slow.resolve(5)
    await first
    expect(useAppStore.getState().notificationUnreadCount).toBe(0)
    await flush()
  })

  it('B 的新响应先完成、A 后完成：最终保持 B 的结果', async () => {
    const slowA = deferred<number>()
    getUnreadCount.mockImplementationOnce(() => slowA.promise)
    useAuthStore.setState({ user: userA as never, isLoggedIn: true })
    const first = useAppStore.getState().refreshNotificationUnread()

    useAuthStore.setState({ user: userB as never, isLoggedIn: true })
    getUnreadCount.mockResolvedValueOnce(7)
    await useAppStore.getState().refreshNotificationUnread()
    expect(useAppStore.getState().notificationUnreadCount).toBe(7)

    slowA.resolve(5)
    await first
    expect(useAppStore.getState().notificationUnreadCount).toBe(7)
    await flush()
  })
})

describe('Dynamic Island Live Activity & Demotion Protection', () => {
  beforeEach(() => {
    useAppStore.setState({
      toasts: [],
      islandNotice: null,
      islandNoticeAvailable: true,
      modalDepth: 0,
    })
  })

  it('triggerIslandActivity activates island and prevents competing toast duplication', () => {
    useAppStore.setState({
      modalDepth: 1,
      toasts: [{ id: 99, message: '兑换成功', type: 'success' }],
    })

    useAppStore.getState().triggerIslandActivity({
      kind: 'order_success',
      title: '兑换成功',
      subtitle: '已扣除 3 积分 · 默认套餐',
      badge: '即时交付',
      actionLabel: '查看卡密',
    })

    const state = useAppStore.getState()
    expect(state.islandNotice).not.toBeNull()
    expect(state.islandNotice?.title).toBe('兑换成功')
    expect(state.islandNotice?.kind).toBe('order_success')
    expect(state.modalDepth).toBe(1)
    expect(state.toasts.some((t) => t.message === '兑换成功')).toBe(false)
  })

  it('demoteIslandNotice protects order_success from ever demoting to a detached toast', () => {
    useAppStore.getState().triggerIslandActivity({
      kind: 'order_success',
      title: '兑换成功',
      subtitle: '已扣除 3 积分',
    })

    useAppStore.getState().demoteIslandNotice()

    const state = useAppStore.getState()
    expect(state.islandNotice).not.toBeNull()
    expect(state.islandNotice?.kind).toBe('order_success')
    expect(state.toasts).toHaveLength(0)
  })

  it('leaving the layout clears the order activity instead of replaying a stale action', () => {
    useAppStore.getState().triggerIslandActivity({
      kind: 'order_success',
      title: '兑换成功',
      subtitle: '已扣除 3 积分',
    })

    useAppStore.getState().setIslandNoticeAvailable(false)

    const state = useAppStore.getState()
    expect(state.islandNotice).toBeNull()
    expect(state.toasts).toHaveLength(0)
  })

  it('preserves the order action when a favorite activity or error arrives', () => {
    const onAction = vi.fn()
    useAppStore.getState().triggerIslandActivity({ kind: 'order_success', title: '兑换成功', onAction })
    const order = useAppStore.getState().islandNotice

    useAppStore.getState().triggerIslandActivity({ kind: 'favorite', title: '已加入收藏' })
    useAppStore.getState().showToast('网络异常', 'error')

    expect(useAppStore.getState().islandNotice).toBe(order)
    expect(useAppStore.getState().toasts.map((toast) => toast.message)).toEqual(['已加入收藏', '网络异常'])
    useAppStore.getState().islandNotice?.onAction?.()
    expect(onAction).toHaveBeenCalledOnce()
  })
})
