import api from './client'
import { useAuthStore } from '../stores/authStore'
import { ConfigRegistry } from '../types/config'

export interface MemberTierMeta {
  value: 'bronze' | 'silver' | 'gold' | 'platinum'
  label: string
  tone: 'neutral' | 'info' | 'warning' | 'success'
}

export interface RegistryResponse extends ConfigRegistry {
  memberTiers: MemberTierMeta[]
  memberTierThresholds: { silver: number; gold: number; platinum: number }
  memberTierBonusBps: { bronze: 0; silver: number; gold: number; platinum: number }
}

/**
 * SPEC-CATALOG-VIS-001 §3.5（P1-B）— 分类 registry 缓存按「视角 + 登录代数」隔离。
 *
 * 背景：`GET /api/config/registry` 现在按可选登录态返回不同内容——游客拿不到
 * members_only 分类，登录用户能拿到。因此这份缓存不能再是单份：
 *
 * 1. **必须区分 perspective**：游客与登录用户是两个不同的响应，
 *    共用一份会让先到的视角把结果喂给另一个（游客预热后登录仍看不到受限分类，
 *    反过来更糟：登录用户的完整列表被缓存后发给游客）。
 * 2. **必须区分登录代数（authEpoch）**：同一浏览器里 A 退出、B 登录，
 *    两份都是「登录态」，perspective 相同，但内容不同。仅用 boolean 隔离不够。
 * 3. **旧在途请求不得回填**：登出或换账号时正在飞的请求，返回后不得写入缓存，
 *    否则会把上一个身份的受限分类留给下一个人。用代次快照比对实现。
 */

type Perspective = 'guest' | 'member'

interface CacheSlot {
  response: RegistryResponse | null
  promise: Promise<RegistryResponse> | null
}

/** key = `${perspective}:${authEpoch}`；authEpoch 对游客恒为 0。 */
const slots = new Map<string, CacheSlot>()

/**
 * 当前读取身份。
 *
 * ⚠️ 两件事必须说清楚（P1-B 的回归教训）：
 *
 * 1. **不由 appStore 在 authStore.subscribe 里注入**。最初写成外部注入
 *    （`setRegistryIdentity()` 由 appStore 的身份订阅回调调用），结果破坏了
 *    `notification-realtime.spec.ts` 的 AC-RT-020：该用例在登出/换账号流程上
 *    断言 SSE 中止与重建，而在 subscribe 回调里额外 setState 会改变那一步的
 *    渲染时序，导致 SSE 迟迟不就绪（realtime probe timeout）。已实测确认：
 *    移除该回调内的新增代码后用例恢复通过。
 *
 * 2. 因此改为**读取时惰性解析**：每次 getConfigRegistry 自己从 authStore 取
 *    当前身份。没有订阅、没有副作用，也就不可能影响登录/登出时序。
 *
 * authEpoch 只用于区分「同一浏览器的不同登录会话」；游客统一 0。
 */
let overrideIdentity: { isAuthenticated: boolean; authEpoch: number } | null = null

function resolveAuthIdentity(): { isAuthenticated: boolean; authEpoch: number } {
  // authStore 不依赖本模块（它只依赖 types / cache 工具），因此静态导入
  // 不会形成循环。读取用 getState()，不订阅、不产生副作用。
  const state = useAuthStore.getState()
  return {
    isAuthenticated: Boolean(state.user),
    authEpoch: state.user ? state.authEpoch : 0,
  }
}

function resolveIdentity(): { isAuthenticated: boolean; authEpoch: number } {
  return overrideIdentity ?? resolveAuthIdentity()
}

/**
 * 仅供测试显式指定身份。生产路径不调用它——身份由 resolveAuthIdentity()
 * 在每次读取时从 authStore 惰性解析（原因见上方注释 1）。
 */
export function setRegistryIdentity(identity: { isAuthenticated: boolean; authEpoch: number } | null): void {
  overrideIdentity = identity
    ? {
        isAuthenticated: identity.isAuthenticated,
        authEpoch: identity.isAuthenticated ? identity.authEpoch : 0,
      }
    : null
}

function perspectiveOf(): Perspective {
  return resolveIdentity().isAuthenticated ? 'member' : 'guest'
}

function slotKey(): string {
  return `${perspectiveOf()}:${resolveIdentity().authEpoch}`
}

/**
 * 让全部缓存失效。登录、退出、切换账号、鉴权失效时调用。
 *
 * 除了清数据，还必须**作废在途请求**：把 generation 加一，正在飞的请求回来时
 * 发现代次变了就丢弃结果，不写入缓存（§3.5「旧的在途请求不得在退出或换账号后
 * 回填受限数据」）。
 */
let generation = 0

export function invalidateRegistryCache(): void {
  generation += 1
  slots.clear()
}

/** 仅测试用：完整重置模块状态。 */
export function __resetRegistryCacheForTests(): void {
  generation = 0
  slots.clear()
  overrideIdentity = null
}

export async function getConfigRegistry(): Promise<RegistryResponse> {
  const key = slotKey()
  const startGeneration = generation

  let slot = slots.get(key)
  if (!slot) {
    slot = { response: null, promise: null }
    slots.set(key, slot)
  }

  if (slot.response) {
    return slot.response
  }
  if (slot.promise) {
    return slot.promise
  }

  const pending = api.get<RegistryResponse>('/config/registry')
    .then(res => {
      // 代次变化说明期间发生了登录/退出/换账号：本次结果属于旧身份，
      // 丢弃且不写缓存。调用方仍拿到数据（它发请求时是有权的），
      // 但不会污染后续任何人的缓存。
      if (generation === startGeneration) {
        const liveSlot = slots.get(key)
        if (liveSlot) {
          liveSlot.response = res.data
          liveSlot.promise = null
        }
      }
      return res.data
    })
    .catch(err => {
      const liveSlot = slots.get(key)
      if (liveSlot && generation === startGeneration) {
        liveSlot.promise = null
      }
      throw err
    })

  slot.promise = pending
  return pending
}
