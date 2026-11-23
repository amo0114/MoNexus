import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  claimCheckinReward,
  getCheckinStatus,
  postCheckin,
  postMakeup,
  type CheckinStatus,
} from '../api/checkin'
import { getApiErrorCode, getApiErrorMessage } from '../api/error'
import { getAuthSessionContext, matchesAuthSessionContext, type AuthSessionContext } from '../auth/sessionContext'
import { celebrate } from '../lib/celebrate'
import { useAppStore } from '../stores/appStore'
import { registerIdentityScopedMetadataCleanup, useAuthStore } from '../stores/authStore'

interface SharedCheckinSnapshot {
  status: CheckinStatus | null
  loadFailed: boolean
  busy: string | null
}

const INITIAL_SNAPSHOT: SharedCheckinSnapshot = {
  status: null,
  loadFailed: false,
  busy: null,
}

let snapshot: SharedCheckinSnapshot = INITIAL_SNAPSHOT
let requestSeq = 0
let inFlightRefresh: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function setSnapshot(patch: Partial<SharedCheckinSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  emit()
}

function resetSharedCheckin() {
  requestSeq += 1
  inFlightRefresh = null
  snapshot = INITIAL_SNAPSHOT
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    // Reset once all mounted consumers unmount (e.g. logout/unmount or isolated test cleanup).
    if (listeners.size === 0) {
      requestSeq += 1
      inFlightRefresh = null
      snapshot = INITIAL_SNAPSHOT
    }
  }
}

function getSnapshot() {
  return snapshot
}

registerIdentityScopedMetadataCleanup(() => {
  resetSharedCheckin()
})

function getIdentityKey(authState = useAuthStore.getState()): string {
  return `${authState.authEpoch}:${authState.user?.id ?? 'guest'}`
}

let lastIdentityKey = getIdentityKey()
useAuthStore.subscribe((authState) => {
  const nextKey = getIdentityKey(authState)
  if (nextKey !== lastIdentityKey) {
    lastIdentityKey = nextKey
    resetSharedCheckin()
  }
})

async function fetchSharedCheckinStatus(force = false): Promise<void> {
  if (!force && inFlightRefresh) return inFlightRefresh
  const seq = ++requestSeq
  const context = getAuthSessionContext(useAuthStore.getState())
  const task = (async () => {
    try {
      const next = await getCheckinStatus()
      if (seq !== requestSeq) return
      if (context && !matchesAuthSessionContext(context, getAuthSessionContext(useAuthStore.getState()))) return
      setSnapshot({ status: next, loadFailed: false })
    } catch {
      if (seq !== requestSeq) return
      setSnapshot({ loadFailed: true })
    } finally {
      if (seq === requestSeq) {
        inFlightRefresh = null
      }
    }
  })()
  inFlightRefresh = task
  return task
}

export interface UseCheckinOptions {
  /** Set false when the consumer should stay inert (e.g. guests or admin navbar). */
  enabled?: boolean
}

/**
 * SPEC-ENGAGE-001：签到状态与动作。顶栏、移动抽屉、签到弹窗与个人中心共用同一订阅快照，
 * 任一入口完成签到/补签/领奖后全站即时同步；每个写操作均校验会话代际防止串号。
 */
export function useCheckin(options: UseCheckinOptions = {}) {
  const enabled = options.enabled ?? true
  const navigate = useNavigate()
  const showToast = useAppStore(s => s.showToast)
  const authEpoch = useAuthStore(s => s.authEpoch)
  const userId = useAuthStore(s => s.user?.id ?? null)
  const shared = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const refresh = useCallback(async () => {
    await fetchSharedCheckinStatus(true)
  }, [])

  useEffect(() => {
    if (!enabled) return
    void fetchSharedCheckinStatus(false)
  }, [enabled, authEpoch, userId])

  async function run<T>(
    key: string,
    action: () => Promise<T>,
    onSuccess: (result: T, context: AuthSessionContext, isCurrent: () => boolean) => void,
    fallback: string,
  ) {
    const context = getAuthSessionContext(useAuthStore.getState())
    if (!context || snapshot.busy) return
    const isCurrent = () => matchesAuthSessionContext(context, getAuthSessionContext(useAuthStore.getState()))
    setSnapshot({ busy: key })
    try {
      const result = await action()
      if (!isCurrent()) return
      onSuccess(result, context, isCurrent)
      await fetchSharedCheckinStatus(true)
    } catch (err) {
      if (!isCurrent()) return
      if (getApiErrorCode(err) === 'PRICE_CHANGED') {
        showToast('补签价格已更新，请重新确认', 'error')
        await fetchSharedCheckinStatus(true)
        return
      }
      showToast(getApiErrorMessage(err, fallback), 'error')
    } finally {
      if (isCurrent()) {
        setSnapshot({ busy: null })
      }
    }
  }

  const checkin = () => run('checkin', postCheckin, (data, context, isCurrent) => {
    useAuthStore.getState().updatePoints(data.balanceAfter, context)
    // 旧版后端不返回 streak / newRewards（滚动发布窗口期）。
    const pending = data.newRewards?.length ? ` · ${data.newRewards.length} 个奖励待领取` : ''
    useAppStore.getState().triggerIslandActivity({
      kind: 'points',
      groupKey: 'points:checkin',
      title: `签到成功 +${data.totalReward} 积分`,
      message: `打卡成功！积分 +${data.totalReward}${data.streak ? `，已连签 ${data.streak} 天` : ''}`,
      subtitle: `基础 +${data.baseReward}${data.bonusReward > 0 ? ` · 等级加成 +${data.bonusReward}` : ''}${pending}`,
      type: 'success',
      actionLabel: '查看积分流水',
      onAction: () => {
        if (!isCurrent()) return
        navigate('/profile')
        useAppStore.getState().setPointsHistoryOpen(true)
      },
    })
    void celebrate()
  }, '签到失败')

  const makeup = (date: string) => {
    const current = snapshot.status
    if (!current) return Promise.resolve()
    const price = current.makeup.price
    return run(`makeup:${date}`, () => postMakeup(date, price), (data, context) => {
      useAuthStore.getState().updatePoints(data.balanceAfter, context)
      showToast(`补签成功，当前连签 ${data.streak} 天`)
    }, '补签失败')
  }

  const claim = (rewardId: number) => run(`claim:${rewardId}`, () => claimCheckinReward(rewardId), (data, context) => {
    useAuthStore.getState().updatePoints(data.balanceAfter, context)
    useAppStore.getState().triggerIslandActivity({
      kind: 'points',
      groupKey: 'points:checkin-reward',
      title: `领取成功 +${data.amount} 积分`,
      message: `奖励已到账 +${data.amount} 积分`,
      type: 'success',
    })
    if (!data.alreadyClaimed) void celebrate()
  }, '领取失败')

  return {
    status: shared.status,
    loadFailed: shared.loadFailed,
    busy: shared.busy,
    refresh,
    checkin,
    makeup,
    claim,
  }
}
