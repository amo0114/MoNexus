import { useEffect, useRef, useState } from 'react'
import {
  Users,
  ShoppingBag,
  Coins,
  ShoppingCart,
  Activity,
  Package,
  Layers,
} from 'lucide-react'
import api from '../../api/client'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { StatCardSkeleton } from '../ui/Skeleton'
import AdminOfferReport from './AdminOfferReport'
import AdminPanelHeader from './AdminPanelHeader'
import TrafficPanel from '../TrafficPanel'

interface DashboardStats {
  users: number
  orders: number
  totalPoints: number
  todayOrders?: number | null
  todayCheckins?: number | null
  productCount?: number | null
  availableInventory?: number | null
}

interface Props {
  active?: boolean
}

function DashStat({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: number | string
  hint?: string
  tone?: 'cta'
}) {
  const isCta = tone === 'cta'
  return (
    <div
      className={`p-4 sm:p-5 rounded-xl border ${
        isCta
          ? 'bg-[color-mix(in_srgb,var(--color-cta)_8%,transparent)] border-[color-mix(in_srgb,var(--color-cta)_25%,transparent)]'
          : 'bg-[var(--color-background)] border-[var(--color-border)]'
      }`}
    >
      <div className={`text-xs font-bold mb-1.5 flex items-center gap-1.5 ${isCta ? 'text-[var(--color-cta)]' : 'text-[var(--color-text-muted)]'}`}>
        <Icon className="w-3.5 h-3.5 shrink-0" /> <span className="sm:truncate">{label}</span>
      </div>
      <div className={`font-heading text-xl sm:text-2xl font-bold truncate ${isCta ? 'text-[var(--color-cta)]' : 'text-[var(--color-text)]'}`}>
        {typeof value === 'number' ? value.toLocaleString('zh-CN') : value}
      </div>
      {hint && (
        <div className="text-[11px] text-[var(--color-text-muted)] mt-1 sm:truncate" title={hint}>
          {hint}
        </div>
      )}
    </div>
  )
}

export default function AdminDashboardPanel({ active = true }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const seqRef = useRef(0)

  useEffect(() => {
    if (!active) {
      seqRef.current++
      return
    }

    const seq = ++seqRef.current
    async function fetchStats() {
      setLoading(true)
      try {
        const { data } = await api.get('/admin/stats')
        if (seq !== seqRef.current) return
        setStats(data)
      } catch (err) {
        if (seq !== seqRef.current) return
        showToast(getApiErrorMessage(err, '加载失败'), 'error')
      } finally {
        if (seq === seqRef.current) {
          setLoading(false)
        }
      }
    }
    void fetchStats()

    return () => {
      seqRef.current++
    }
  }, [active, showToast])

  if (loading && !stats) {
    return (
      <div className="space-y-6">
        <AdminPanelHeader
          title="数据仪表盘"
          description="平台关键运行指标、经营概览与实时数据"
        />
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
          <StatCardSkeleton />
          <StatCardSkeleton />
          <StatCardSkeleton />
          <StatCardSkeleton />
        </div>
      </div>
    )
  }

  if (!stats) {
    return null
  }

  return (
    <div className="space-y-6">
      <AdminPanelHeader
        title="数据仪表盘"
        description="关键运营统计（数据截至本次加载）"
      />
      {(stats.todayOrders != null || stats.todayCheckins != null) && (
        <section aria-labelledby="admin-dash-today" className="space-y-3">
          <h3 id="admin-dash-today" className="text-xs font-semibold text-[var(--color-text-muted)]">今日（北京时间）</h3>
          <div className="grid grid-cols-2 gap-3 sm:gap-4">
            {stats.todayOrders != null && (
              <DashStat icon={ShoppingCart} label="今日新增订单" value={stats.todayOrders} />
            )}
            {stats.todayCheckins != null && (
              <DashStat icon={Activity} label="今日签到人次" value={stats.todayCheckins} />
            )}
          </div>
        </section>
      )}
      <section aria-labelledby="admin-dash-totals" className="space-y-3">
        <h3 id="admin-dash-totals" className="text-xs font-semibold text-[var(--color-text-muted)]">平台累计</h3>
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4">
          <DashStat icon={Users} label="注册用户总数" value={stats.users} />
          <DashStat icon={ShoppingBag} label="平台订单总数" value={stats.orders} />
          <DashStat
            icon={Coins}
            label="账户可用积分合计"
            value={stats.totalPoints}
            hint="不含冻结积分及沙箱积分"
            tone="cta"
          />
          {stats.productCount != null && (
            <DashStat
              icon={Package}
              label="已发布商品数"
              value={stats.productCount}
              hint="已发布商品，不保证均有可售库存"
            />
          )}
          {stats.availableInventory != null && (
            <DashStat
              icon={Layers}
              label="可用库存条目"
              value={stats.availableInventory}
              hint="按可用库存记录统计"
            />
          )}
        </div>
      </section>
      <AdminOfferReport />
      <TrafficPanel audience="platform" active={active} />
    </div>
  )
}
