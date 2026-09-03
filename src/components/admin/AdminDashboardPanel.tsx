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
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: number | string
  tone?: 'cta'
}) {
  const isCta = tone === 'cta'
  return (
    <div
      className={`p-5 rounded-lg border ${
        isCta
          ? 'bg-[var(--color-cta)]/8 border-[var(--color-cta)]/25'
          : 'bg-[var(--color-background)] border-[var(--color-border)]'
      }`}
    >
      <div className={`text-xs font-bold mb-1.5 flex items-center gap-1.5 ${isCta ? 'text-[var(--color-cta)]' : 'text-[var(--color-text-muted)]'}`}>
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <div className={`font-heading text-2xl font-bold ${isCta ? 'text-[var(--color-cta)]' : 'text-[var(--color-text)]'}`}>
        {value}
      </div>
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
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
        description="平台关键运行指标、经营概览与实时数据"
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        <DashStat icon={Users} label="注册用户总数" value={stats.users} />
        <DashStat icon={ShoppingBag} label="平台订单总数" value={stats.orders} />
        <DashStat icon={Coins} label="流通积分总额" value={stats.totalPoints} tone="cta" />
        {stats.todayOrders != null && (
          <DashStat icon={ShoppingCart} label="今日新增订单" value={stats.todayOrders} />
        )}
        {stats.todayCheckins != null && (
          <DashStat icon={Activity} label="今日签到人次" value={stats.todayCheckins} />
        )}
        {stats.productCount != null && (
          <DashStat icon={Package} label="在售商品数" value={stats.productCount} />
        )}
        {stats.availableInventory != null && (
          <DashStat icon={Layers} label="可用卡密库存" value={stats.availableInventory} />
        )}
      </div>
      <AdminOfferReport />
    </div>
  )
}
