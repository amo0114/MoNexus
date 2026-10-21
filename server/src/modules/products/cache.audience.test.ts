import { describe, expect, it } from 'vitest'
import { normalizeProductListParams } from './cache.js'

/**
 * SPEC-CATALOG-VIS-001 §3.4 / §8.1 —— 缓存键必须区分 audience。
 *
 * 「缓存的键必须区分 guest/member，缓存不是权限真相源」是方案的硬要求。
 * guest 与 member 看到的商品集合不同（分类可见性 + 商品 visibility 两道门），
 * 若共用同一个缓存条目，先到的视角会把结果喂给另一个视角：
 * 游客请求被缓存后，登录用户会拿到缺了受限商品的列表；反过来更糟——
 * 登录用户的完整列表被缓存后发给游客。
 *
 * 两个视角之间还有一层保护：listProducts 在缓存命中后会用实时数据逐条
 * 复核（isCurrentlyPubliclyVisible），所以即使键撞了也不会真的泄露。
 * 但那只是第二道防线，键本身必须分开——否则复核只能「少返回」，
 * 游客仍会拿到 member 列表的 9 件里的 0 件，行为依赖缓存命中顺序。
 *
 * 本文件是纯函数测试，不需要 DB 或 Redis：normalizeProductListParams 的
 * 输出直接参与 sha256 哈希，audience 出现在输出里就等于进入了键。
 */
describe('SPEC-CATALOG-VIS-001 §3.4 商品列表缓存键按 audience 隔离', () => {
  it('audience 参与列表缓存键的哈希输入', () => {
    const guest = normalizeProductListParams({ page: 1, audience: 'guest' })
    const member = normalizeProductListParams({ page: 1, audience: 'member' })

    expect(guest).not.toBeNull()
    expect(member).not.toBeNull()
    expect(guest!.audience).toBe('guest')
    expect(member!.audience).toBe('member')
    // 除 audience 外其余完全相同——差异必须只来自视角，否则说明还有别的
    // 因素混进了键，会让本用例失去意义。
    const { audience: _g, ...guestRest } = guest!
    const { audience: _m, ...memberRest } = member!
    expect(guestRest).toEqual(memberRest)
  })

  it('缺省 audience 按 guest 处理，不会与 member 混用', () => {
    const omitted = normalizeProductListParams({ page: 1 })
    const member = normalizeProductListParams({ page: 1, audience: 'member' })
    expect(omitted!.audience).toBe('guest')
    expect(omitted!.audience).not.toBe(member!.audience)
  })

  it('分类过滤与 audience 同时进入键（收紧分类后不能用别的分类的缓存）', () => {
    const a = normalizeProductListParams({ page: 1, audience: 'guest', categoryCode: 'network-node' })
    const b = normalizeProductListParams({ page: 1, audience: 'guest', categoryCode: 'other-code' })
    expect(a!.categoryCode).toBe('network-node')
    expect(b!.categoryCode).toBe('other-code')
    expect(a).not.toEqual(b)
  })

  it('列表参数过长/过短的搜索词不生成缓存键（null），避免无界键空间', () => {
    expect(normalizeProductListParams({ page: 1, query: 'a' })).toBeNull()
    expect(normalizeProductListParams({ page: 1, query: 'x'.repeat(51) })).toBeNull()
    expect(normalizeProductListParams({ page: 1, query: 'ab' })).not.toBeNull()
  })
})
