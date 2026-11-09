import { useCallback, useEffect, useState } from 'react'
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
import { useAuthStore } from '../stores/authStore'

/**
 * SPEC-ENGAGE-001：签到状态与动作。Profile 与首页今日面板共用。
 * 每个写操作都捕获发起时的会话上下文，响应返回前账号已切换则丢弃结果。
 */
export function useCheckin() {
  const navigate = useNavigate()
  const showToast = useAppStore(s => s.showToast)
  const [status, setStatus] = useState<CheckinStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await getCheckinStatus())
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function run<T>(key: string, action: () => Promise<T>, onSuccess: (result: T, context: AuthSessionContext, isCurrent: () => boolean) => void, fallback: string) {
    const context = getAuthSessionContext(useAuthStore.getState())
    if (!context || busy) return
    const isCurrent = () => matchesAuthSessionContext(context, getAuthSessionContext(useAuthStore.getState()))
    setBusy(key)
    try {
      const result = await action()
      if (!isCurrent()) return
      onSuccess(result, context, isCurrent)
      await refresh()
    } catch (err) {
      if (!isCurrent()) return
      if (getApiErrorCode(err) === 'PRICE_CHANGED') {
        showToast('补签价格已更新，请重新确认', 'error')
        await refresh()
        return
      }
      showToast(getApiErrorMessage(err, fallback), 'error')
    } finally {
      setBusy(null)
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
    if (!status) return Promise.resolve()
    const price = status.makeup.price
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

  return { status, loadFailed, busy, refresh, checkin, makeup, claim }
}
