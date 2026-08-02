import { useCallback, useEffect, useState } from 'react'
import { Trophy } from 'lucide-react'
import { getLeaderboard, LeaderboardResponse, LeaderboardScope } from '../api/leaderboard'
import { getApiErrorMessage } from '../api/error'
import { useAppStore } from '../stores/appStore'
import EmptyState from '../components/ui/EmptyState'
import { Skeleton } from '../components/ui/Skeleton'
import Podium from './leaderboard/Podium'
import RankRow from './leaderboard/RankRow'
import MyRankBar from './leaderboard/MyRankBar'
import StatsPanel from './leaderboard/StatsPanel'

const SCOPES: { value: LeaderboardScope; label: string }[] = [
  { value: 'total', label: '总榜' },
  { value: 'month', label: '本月榜' },
  { value: 'week', label: '本周榜' },
]

/**
 * 空态分两类（spec §4.4）：updatedAt 为 null 是部署后首刷未完成的空窗，
 * 有 updatedAt 却无人上榜则是新周期首日。
 */
function emptyCopy(scope: LeaderboardScope, updatedAt: string | null) {
  if (!updatedAt) {
    return { title: '榜单正在生成中', description: '首轮数据稍后就位，晚点再来看看' }
  }
  if (scope === 'week') {
    return { title: '新的一周刚开始', description: '明天见分晓——现在去签到，抢占本周榜首' }
  }
  if (scope === 'month') {
    return { title: '新的一个月刚开始', description: '明天见分晓——现在去签到，抢占本月榜首' }
  }
  return { title: '还没有人上榜', description: '完成每日签到赚取积分，成为第一个登上总榜的人' }
}

/** 加载骨架：hero（颁奖台 + 战况卡）+ 8 行列表，形状对齐最终布局。 */
function LeaderboardSkeleton() {
  return (
    <div className="space-y-4 lg:space-y-6" role="status" aria-label="加载中">
      <div className="space-y-4 lg:space-y-0 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-stretch lg:gap-6">
        <div className="card flex items-end justify-center gap-2 sm:gap-5 px-4 pt-9 pb-6 sm:px-6 lg:h-full">
          {[2, 1, 3].map((medal) => (
            <div
              key={medal}
              className={`flex flex-col items-center ${
                medal === 1 ? 'w-[6.5rem] sm:w-32 mb-6' : 'w-[5.5rem] sm:w-28'
              }`}
            >
              <Skeleton className={medal === 1 ? 'w-20 h-20 rounded-full' : 'w-16 h-16 rounded-full'} />
              <Skeleton className="mt-4 h-3.5 w-16" />
              <Skeleton className="mt-2 h-3 w-10" />
            </div>
          ))}
        </div>
        <div className="hidden lg:flex card h-full flex-col justify-between gap-5">
          <div className="flex items-center gap-3">
            <Skeleton className="w-11 h-11 rounded-full shrink-0" />
            <Skeleton className="h-7 w-44" />
          </div>
          <div className="space-y-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-16" />
              </div>
            ))}
          </div>
          <Skeleton className="h-3 w-4/5" />
        </div>
      </div>
      <div className="card p-0 overflow-hidden divide-y divide-[var(--color-border)]">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 sm:px-5 py-3">
            <Skeleton className="w-8 h-4 shrink-0" />
            <Skeleton className="w-10 h-10 rounded-full shrink-0" />
            <Skeleton className="h-4 w-28 shrink-0" />
            <Skeleton className="hidden sm:block h-1.5 flex-1 rounded-full" />
            <Skeleton className="w-12 h-4 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  )
}

export default function LeaderboardPage() {
  const [scope, setScope] = useState<LeaderboardScope>('total')
  const [data, setData] = useState<LeaderboardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  // 吸底条的收起条件：自己那一行（颁奖台或列表）已在可视区。
  const [meEl, setMeEl] = useState<HTMLElement | null>(null)
  const [meOnScreen, setMeOnScreen] = useState(false)
  const registerMeEl = useCallback((el: HTMLElement | null) => setMeEl(el), [])

  useEffect(() => {
    let mounted = true
    setLoading(true)
    getLeaderboard(scope)
      .then((res) => {
        if (!mounted) return
        setData(res)
        setFailed(false)
      })
      .catch((err) => {
        if (!mounted) return
        // 保留旧 scope 的数据会张冠李戴，失败一律清空并给出重试入口。
        setData(null)
        setFailed(true)
        useAppStore.getState().showToast(getApiErrorMessage(err, '排行榜加载失败，请稍后重试'), 'error')
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [scope, reloadKey])

  useEffect(() => {
    if (!meEl || typeof IntersectionObserver === 'undefined') {
      setMeOnScreen(false)
      return
    }
    // 底部收缩 88px ≈ 吸底条高度 + 间距：被条盖住的行不算"看得见"。
    const io = new IntersectionObserver((entries) => setMeOnScreen(entries[0].isIntersecting), {
      rootMargin: '0px 0px -88px 0px',
    })
    io.observe(meEl)
    return () => io.disconnect()
  }, [meEl])

  const copy = emptyCopy(scope, data?.updatedAt ?? null)

  return (
    <div className="max-w-3xl lg:max-w-6xl mx-auto pt-2">
      <header>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="w-10 h-10 shrink-0 inline-flex items-center justify-center rounded-full bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
            <Trophy className="w-5 h-5" aria-hidden="true" />
          </span>
          <h1 className="font-heading text-2xl lg:text-[28px] font-bold tracking-tight text-[var(--color-text)]">积分排行榜</h1>
          {data && scope !== 'total' && (
            <span className="px-2.5 py-1 rounded-full text-xs font-medium border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]">
              {data.periodLabel}
            </span>
          )}
        </div>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          {data?.dataThrough ? `数据截至 ${data.dataThrough} · 每日更新` : '数据每日更新'}
        </p>
      </header>

      <div className="flex items-center gap-2 mt-4 mb-4">
        {SCOPES.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setScope(opt.value)}
            aria-pressed={scope === opt.value}
            data-testid={`leaderboard-tab-${opt.value}`}
            className={`px-4 py-1.5 btn-sm rounded-full text-sm font-medium transition-colors ${
              scope === opt.value
                ? 'bg-[var(--color-primary)] text-white'
                : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border border-[var(--color-border)] hover:text-[var(--color-text)]'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div aria-busy={loading || undefined}>
        {loading ? (
          <LeaderboardSkeleton />
        ) : failed || !data ? (
          <div className="card lg:max-w-2xl lg:mx-auto" data-testid="leaderboard-error">
            <EmptyState
              icon={Trophy}
              title="榜单加载失败"
              description="网络或服务暂时不可用，请稍后重试"
              action={
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => setReloadKey((k) => k + 1)}
                >
                  重试
                </button>
              }
            />
          </div>
        ) : data.top.length === 0 ? (
          <div className="card lg:max-w-2xl lg:mx-auto" data-testid="leaderboard-empty">
            <EmptyState icon={Trophy} title={copy.title} description={copy.description} />
          </div>
        ) : (
          /* .fade-in 会留下 transform，吸底浮条（position: fixed）必须待在它之外。
             桌面密度方案（第三版）：hero 行 = 颁奖台(3) + 「本期战况」统计卡(2)
             等高并排——两侧都不长，天然无留白；列表回归全宽单列（名次连续），
             每行以「距榜首」比例条把横向空间转成信息。 */
          <div className="fade-in space-y-4 lg:space-y-6">
            <div className="space-y-4 lg:space-y-0 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-stretch lg:gap-6">
              <Podium top={data.top.slice(0, 3)} meRef={registerMeEl} />
              <StatsPanel data={data} />
            </div>

            {data.top.length > 3 && (
              /* 分隔线由行自己的 border-b 画：divide-* 会以 border-color 简写
                 盖掉 isMe 行的左侧强调色（选择器特异性更高）。 */
              <ul className="card p-0 overflow-hidden">
                {data.top.slice(3).map((entry) => (
                  <RankRow
                    key={entry.rank}
                    entry={entry}
                    meRef={registerMeEl}
                    maxPoints={data.top[0].points}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {!loading && !failed && data && data.top.length > 0 && (
        <>
          {/* 让最后一行能滚过吸底条（Layout 只预留了 Tab Bar 的高度）；
              lg 起浮条退役（信息在左栏卡片），占位一并撤掉 */}
          <div className="h-14 md:h-16 lg:hidden" aria-hidden="true" />
          <MyRankBar me={data.me} hidden={meOnScreen} />
        </>
      )}
    </div>
  )
}
