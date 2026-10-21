import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SPEC-CATALOG-VIS-001 §3.5（P1-B 复审阻塞项）— 身份切换后分类数据必须更新。
 *
 * 上一版的问题：`invalidateRegistryCache()` 在生产代码里**没有任何调用方**，
 * registry 只在 App 挂载时取一次（`App.tsx` 的 effect），登录/退出（SPA 不刷新）
 * 后既不失效也不重取。后果：
 *   a. member 退出后，appStore.registry 仍是登录视角，游客仍能看到受限分类名；
 *   b. guest 登录后仍是游客视角，商家分类选择器缺「仅登录可见」项。
 *
 * 本文件走**真实的身份切换入口**（beginUnpersistedIdentityTransition / logout /
 * beginIdentityTransition），而不是直接调用 invalidateRegistryCache——后者只能
 * 证明函数本身可用，证明不了它在页面流程里被调用。
 */

const getMock = vi.fn()

vi.mock('../api/client', () => ({
  default: {
    get: (...args: unknown[]) => getMock(...args),
    post: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  },
}))

function registryPayload(codes: string[]) {
  return {
    data: {
      productCategories: codes.map((code, i) => ({
        id: i + 1, code, label: code, iconKey: null, sortOrder: i,
      })),
      productTypes: codes.map(code => ({ value: code, label: code, deprecated: true })),
      memberTiers: [],
      memberTierThresholds: { silver: 0, gold: 0, platinum: 0 },
      memberTierBonusBps: { bronze: 0, silver: 0, gold: 0, platinum: 0 },
    },
  }
}

type Mods = {
  registry: typeof import('../api/registry')
  auth: typeof import('../stores/authStore')
  app: typeof import('../stores/appStore')
}

async function loadModules(): Promise<Mods> {
  vi.resetModules()
  const registry = await import('../api/registry')
  const auth = await import('../stores/authStore')
  const app = await import('../stores/appStore')
  return { registry, auth, app }
}

/** 等待 authStore 里触发的动态 import('./appStore') 落定。 */
async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  getMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SPEC-CATALOG-VIS-001 §3.5 身份切换后 registry 与身份一致', () => {
  it('退出登录：appStore.registry 被清空，再次读取拿到游客视角', async () => {
    const { registry, auth, app } = await loadModules()

    // 1) 以登录身份加载：拿到受限分类。
    auth.useAuthStore.setState({
      user: { id: 7, email: 'm@test.local', nickname: 'M', role: 'user', points: 0 } as never,
      isLoggedIn: true,
      accessToken: null,
      sessionId: null,
    })
    getMock.mockResolvedValueOnce(registryPayload(['public-cat', 'locked-cat']))
    await app.useAppStore.getState().loadRegistry()
    expect(app.useAppStore.getState().registry?.productCategories.map(c => c.code))
      .toContain('locked-cat')

    // 2) 走真实退出入口（logout 内部会 clearStorePageCache + 失效 registry）。
    auth.useAuthStore.getState().logout()
    await flushMicrotasks()

    // 关键断言：快照已被丢弃，不能继续把受限分类留在页面上。
    expect(app.useAppStore.getState().registry).toBeNull()
    expect(app.useAppStore.getState().registryStatus).toBe('idle')

    // 3) 重新加载时按新身份（游客）请求，且不复用旧缓存。
    getMock.mockResolvedValueOnce(registryPayload(['public-cat']))
    await app.useAppStore.getState().loadRegistry()
    expect(getMock).toHaveBeenCalledTimes(2)
    const codes = app.useAppStore.getState().registry?.productCategories.map(c => c.code) ?? []
    expect(codes).toEqual(['public-cat'])
    expect(codes).not.toContain('locked-cat')
  })

  it('从头开始登录（beginUnpersistedIdentityTransition）：清空快照并重新按登录视角请求', async () => {
    const { auth, app } = await loadModules()

    // 1) 游客视角先加载。
    getMock.mockResolvedValueOnce(registryPayload(['public-cat']))
    await app.useAppStore.getState().loadRegistry()
    expect(app.useAppStore.getState().registry?.productCategories.map(c => c.code))
      .toEqual(['public-cat'])

    // 2) 走真实登录前入口（LoginPage 内部调用的就是它）。
    auth.useAuthStore.getState().beginUnpersistedIdentityTransition()
    await flushMicrotasks()
    expect(app.useAppStore.getState().registry).toBeNull()

    // 3) 登录完成后按登录身份取，能看到受限分类。
    auth.useAuthStore.setState({
      user: { id: 9, email: 'n@test.local', nickname: 'N', role: 'merchant', points: 0 } as never,
      isLoggedIn: true,
    })
    getMock.mockResolvedValueOnce(registryPayload(['public-cat', 'locked-cat']))
    await app.useAppStore.getState().loadRegistry()

    expect(getMock).toHaveBeenCalledTimes(2)
    expect(app.useAppStore.getState().registry?.productCategories.map(c => c.code))
      .toContain('locked-cat')
  })

  it('beginIdentityTransition 同样清空快照', async () => {
    const { auth, app } = await loadModules()

    getMock.mockResolvedValueOnce(registryPayload(['a', 'b']))
    await app.useAppStore.getState().loadRegistry()
    expect(app.useAppStore.getState().registry).not.toBeNull()

    auth.useAuthStore.getState().beginIdentityTransition()
    await flushMicrotasks()
    expect(app.useAppStore.getState().registry).toBeNull()
  })

  it('两个在途请求乱序返回（旧 member 后到），最终快照为 guest 视角', async () => {
    const { auth, app } = await loadModules()

    // 1) 以登录身份发起请求 A（挂起）。
    auth.useAuthStore.setState({
      user: { id: 21, email: 'q@test.local', nickname: 'Q', role: 'user', points: 0 } as never,
      isLoggedIn: true,
    })
    let resolveMember: (v: unknown) => void = () => {}
    getMock.mockReturnValueOnce(new Promise(resolve => { resolveMember = resolve }))
    const memberPending = app.useAppStore.getState().loadRegistry()

    // 2) 期间退出，App 依 authEpoch 变化发起 guest 请求 B（挂起）。
    auth.useAuthStore.getState().logout()
    await flushMicrotasks()
    let resolveGuest: (v: unknown) => void = () => {}
    getMock.mockReturnValueOnce(new Promise(resolve => { resolveGuest = resolve }))
    const guestPending = app.useAppStore.getState().loadRegistry()

    // 3) 关键顺序：guest（新）先返回，member（旧）后返回。
    resolveGuest(registryPayload(['public-cat']))
    await guestPending
    await flushMicrotasks()
    expect(app.useAppStore.getState().registry?.productCategories.map(c => c.code))
      .toEqual(['public-cat'])

    resolveMember(registryPayload(['public-cat', 'locked-cat']))
    await memberPending
    await flushMicrotasks()

    // 4) 旧响应不得覆盖新快照。
    const codes = app.useAppStore.getState().registry?.productCategories.map(c => c.code) ?? []
    expect(codes).toEqual(['public-cat'])
    expect(codes).not.toContain('locked-cat')
    expect(app.useAppStore.getState().registryStatus).toBe('ready')
  })

  it('旧请求失败不得把新请求的成功状态改写成 error', async () => {
    const { auth, app } = await loadModules()

    auth.useAuthStore.setState({
      user: { id: 31, email: 'r@test.local', nickname: 'R', role: 'user', points: 0 } as never,
      isLoggedIn: true,
    })
    let rejectMember: (e: unknown) => void = () => {}
    getMock.mockReturnValueOnce(new Promise((_res, rej) => { rejectMember = rej }))
    const memberPending = app.useAppStore.getState().loadRegistry()

    auth.useAuthStore.getState().logout()
    await flushMicrotasks()

    getMock.mockResolvedValueOnce(registryPayload(['public-cat']))
    await app.useAppStore.getState().loadRegistry()
    expect(app.useAppStore.getState().registryStatus).toBe('ready')

    rejectMember(new Error('stale member failure'))
    await memberPending
    await flushMicrotasks()

    // 状态仍是 ready（新请求的结果），不被旧失败改写。
    expect(app.useAppStore.getState().registryStatus).toBe('ready')
    expect(app.useAppStore.getState().registry?.productCategories.map(c => c.code))
      .toEqual(['public-cat'])
  })

  it('退出后旧的在途请求返回，不得把受限分类写回快照', async () => {
    const { auth, app, registry } = await loadModules()

    auth.useAuthStore.setState({
      user: { id: 11, email: 'p@test.local', nickname: 'P', role: 'user', points: 0 } as never,
      isLoggedIn: true,
    })

    // 让 registry 请求挂起。
    let resolveInflight: (v: unknown) => void = () => {}
    getMock.mockReturnValueOnce(new Promise(resolve => { resolveInflight = resolve }))
    const pending = app.useAppStore.getState().loadRegistry()

    // 期间退出。
    auth.useAuthStore.getState().logout()
    await flushMicrotasks()

    // 旧请求带着登录视角（含受限分类）返回。
    resolveInflight(registryPayload(['public-cat', 'locked-cat']))
    await pending
    await flushMicrotasks()

    // 模块缓存不得被旧响应污染：游客再读必须重新请求。
    getMock.mockResolvedValueOnce(registryPayload(['public-cat']))
    const guest = await registry.getConfigRegistry()
    expect(guest.productCategories.map(c => c.code)).toEqual(['public-cat'])
    expect(getMock).toHaveBeenCalledTimes(2)

    // 关键：**页面状态**同样不得被旧响应写回。这是上一版本的漏点——
    // generation 只保护模块缓存，旧结果仍 return 给调用方，而
    // appStore.loadRegistry 会把它原样写进 registry。
    expect(app.useAppStore.getState().registry).toBeNull()
    const snapshotCodes = app.useAppStore.getState().registry?.productCategories
      ?.map(c => c.code) ?? []
    expect(snapshotCodes).not.toContain('locked-cat')
  })
})
