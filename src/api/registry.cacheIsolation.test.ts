import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * SPEC-CATALOG-VIS-001 §3.5（P1-B）— registry 前端缓存隔离。
 *
 * 覆盖三件方案明确要求、且单份缓存实现做不到的事：
 *   1. 游客与登录用户的缓存互不污染；
 *   2. 同一浏览器的不同登录会话（authEpoch 变化）互不污染；
 *   3. 登出/切换账号时正在飞的旧请求，返回后不得写入缓存。
 */

const getMock = vi.fn()

vi.mock('./client', () => ({
  default: { get: (...args: unknown[]) => getMock(...args) },
}))

async function loadRegistryModule() {
  vi.resetModules()
  return import('./registry')
}

function registryPayload(codes: string[]) {
  return {
    data: {
      productCategories: codes.map((code, i) => ({ id: i + 1, code, label: code, iconKey: null, sortOrder: i })),
      productTypes: codes.map(code => ({ value: code, label: code, deprecated: true })),
      memberTiers: [],
      memberTierThresholds: { silver: 0, gold: 0, platinum: 0 },
      memberTierBonusBps: { bronze: 0, silver: 0, gold: 0, platinum: 0 },
    },
  }
}

afterEach(() => {
  getMock.mockReset()
})

describe('SPEC-CATALOG-VIS-001 §3.5 registry 缓存按身份隔离', () => {
  it('游客与登录用户各自请求一次，不共用缓存', async () => {
    const mod = await loadRegistryModule()

    getMock.mockResolvedValueOnce(registryPayload(['public-cat']))
    mod.setRegistryIdentity({ isAuthenticated: false, authEpoch: 0 })
    const guest = await mod.getConfigRegistry()
    expect(guest.productCategories.map(c => c.code)).toEqual(['public-cat'])

    getMock.mockResolvedValueOnce(registryPayload(['public-cat', 'locked-cat']))
    mod.setRegistryIdentity({ isAuthenticated: true, authEpoch: 1 })
    const member = await mod.getConfigRegistry()
    expect(member.productCategories.map(c => c.code)).toEqual(['public-cat', 'locked-cat'])

    // 两次真实请求，不是复用游客缓存。
    expect(getMock).toHaveBeenCalledTimes(2)
  })

  it('游客预热后再以登录身份请求，仍能拿到受限分类（不被 guest 条目污染）', async () => {
    const mod = await loadRegistryModule()

    getMock.mockResolvedValueOnce(registryPayload(['public-cat']))
    mod.setRegistryIdentity({ isAuthenticated: false, authEpoch: 0 })
    await mod.getConfigRegistry()

    getMock.mockResolvedValueOnce(registryPayload(['public-cat', 'locked-cat']))
    mod.setRegistryIdentity({ isAuthenticated: true, authEpoch: 2 })
    const member = await mod.getConfigRegistry()

    expect(member.productCategories.map(c => c.code)).toContain('locked-cat')
    expect(getMock).toHaveBeenCalledTimes(2)
  })

  it('同一 perspective 内 authEpoch 变化（A 退出 B 登录）不共用缓存', async () => {
    const mod = await loadRegistryModule()

    getMock.mockResolvedValueOnce(registryPayload(['cat-a']))
    mod.setRegistryIdentity({ isAuthenticated: true, authEpoch: 5 })
    await mod.getConfigRegistry()

    // 换账号：仍是 member，但 epoch 变了。
    getMock.mockResolvedValueOnce(registryPayload(['cat-b']))
    mod.setRegistryIdentity({ isAuthenticated: true, authEpoch: 6 })
    const second = await mod.getConfigRegistry()

    expect(second.productCategories.map(c => c.code)).toEqual(['cat-b'])
    expect(getMock).toHaveBeenCalledTimes(2)
  })

  it('同一身份重复请求命中缓存，只发一次网络请求', async () => {
    const mod = await loadRegistryModule()

    getMock.mockResolvedValue(registryPayload(['cat-x']))
    mod.setRegistryIdentity({ isAuthenticated: true, authEpoch: 1 })
    await mod.getConfigRegistry()
    await mod.getConfigRegistry()

    expect(getMock).toHaveBeenCalledTimes(1)
  })

  it('在途请求在登出后返回，不得写入缓存（不回填受限数据）', async () => {
    const mod = await loadRegistryModule()

    let resolveInflight: (v: unknown) => void = () => {}
    const inflight = new Promise(resolve => { resolveInflight = resolve })
    getMock.mockReturnValueOnce(inflight)

    mod.setRegistryIdentity({ isAuthenticated: true, authEpoch: 1 })
    const pending = mod.getConfigRegistry()

    // 请求还在飞时登出。
    mod.invalidateRegistryCache()
    mod.setRegistryIdentity({ isAuthenticated: false, authEpoch: 0 })

    // 旧请求现在返回「含受限分类」的内容。
    resolveInflight(registryPayload(['public-cat', 'locked-cat']))
    const stale = await pending
    // 调用方当时有权，仍拿到数据（不破坏在途语义）。
    expect(stale.productCategories.map(c => c.code)).toContain('locked-cat')

    // 关键：游客视角的下一次读取必须重新发请求，不能命中刚才那条缓存。
    getMock.mockResolvedValueOnce(registryPayload(['public-cat']))
    const guest = await mod.getConfigRegistry()
    expect(guest.productCategories.map(c => c.code)).toEqual(['public-cat'])
    expect(getMock).toHaveBeenCalledTimes(2)
  })

  /**
   * 直接针对 generation 保护的用例。
   *
   * 上一条「在途请求…不得写入缓存」其实**没有真正验证** generation 检查：
   * invalidateRegistryCache 会 slots.clear()，槽位消失后旧请求本来也写不进去。
   * 要单独证明 generation 有意义，必须构造「槽位仍在、但代次已变」的场景——
   * 即调用方在请求飞行期间**换了身份**（key 可能不同），随后又切回原身份，
   * 使同 key 的槽位被重新创建；旧请求返回时不得覆盖新槽位。
   */
  it('旧代次的在途请求不覆盖同 key 的新槽位', async () => {
    const mod = await loadRegistryModule()

    let resolveOld: (v: unknown) => void = () => {}
    const oldInflight = new Promise(resolve => { resolveOld = resolve })
    getMock.mockReturnValueOnce(oldInflight)

    mod.setRegistryIdentity({ isAuthenticated: true, authEpoch: 1 })
    const oldRequest = mod.getConfigRegistry()

    // 期间登出再登录回同一个 epoch=1 的身份：槽位被清掉后重新建立，
    // 但 generation 已经变了。旧请求若不受 generation 约束，返回时会写入
    // 这个新槽位，把「含受限分类」的旧内容留给后续读取。
    mod.invalidateRegistryCache()
    mod.setRegistryIdentity({ isAuthenticated: false, authEpoch: 0 })
    mod.setRegistryIdentity({ isAuthenticated: true, authEpoch: 1 })

    getMock.mockResolvedValueOnce(registryPayload(['fresh-only']))
    const fresh = await mod.getConfigRegistry()
    expect(fresh.productCategories.map(c => c.code)).toEqual(['fresh-only'])

    // 旧请求现在才返回，内容是旧的（含受限分类）。
    resolveOld(registryPayload(['stale-with-locked']))
    await oldRequest

    // 再读一次：必须仍是 fresh，说明旧结果没覆盖新槽位。命中缓存不发请求。
    const again = await mod.getConfigRegistry()
    expect(again.productCategories.map(c => c.code)).toEqual(['fresh-only'])
    expect(getMock).toHaveBeenCalledTimes(2)
  })

  it('invalidateRegistryCache 后同一身份也会重新请求', async () => {
    const mod = await loadRegistryModule()

    getMock.mockResolvedValue(registryPayload(['cat-1']))
    mod.setRegistryIdentity({ isAuthenticated: false, authEpoch: 0 })
    await mod.getConfigRegistry()
    expect(getMock).toHaveBeenCalledTimes(1)

    mod.invalidateRegistryCache()
    await mod.getConfigRegistry()
    expect(getMock).toHaveBeenCalledTimes(2)
  })
})
