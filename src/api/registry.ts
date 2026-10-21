import api from './client'
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
 * 当前读取身份。由 appStore 在每次请求前注入，避免 registry 反向依赖 store
 * 造成循环引用（appStore 已经 import 本模块）。
 *
 * authEpoch 只用于区分「同一浏览器的不同登录会话」；游客统一 0。
 */
let currentIdentity: { isAuthenticated: boolean; authEpoch: number } = {
  isAuthenticated: false,
  authEpoch: 0,
}

export function setRegistryIdentity(identity: { isAuthenticated: boolean; authEpoch: number }): void {
  currentIdentity = {
    isAuthenticated: identity.isAuthenticated,
    authEpoch: identity.isAuthenticated ? identity.authEpoch : 0,
  }
}

function perspectiveOf(): Perspective {
  return currentIdentity.isAuthenticated ? 'member' : 'guest'
}

function slotKey(): string {
  return `${perspectiveOf()}:${currentIdentity.authEpoch}`
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
  currentIdentity = { isAuthenticated: false, authEpoch: 0 }
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
