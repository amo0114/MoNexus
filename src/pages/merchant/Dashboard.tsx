import React, { useEffect, useState } from 'react'
import { fetchSummary, fetchTimeseries, DashboardSummary, DashboardTimeseries } from '../../api/merchant/dashboard'
import { useDashboardStore } from '../../stores/dashboard'
import { useAppStore } from '../../stores/appStore'
import SummaryCards from './dashboard/SummaryCards'
import TrendChart from './dashboard/TrendChart'
import TopProducts from './dashboard/TopProducts'
import StatusBreakdown from './dashboard/StatusBreakdown'
import RangeFilter from './dashboard/RangeFilter'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

export default function Dashboard() {
  const { range } = useDashboardStore()
  const navigate = useNavigate()

  const [summary, setSummary] = useState<DashboardSummary>()
  const [summaryLoading, setSummaryLoading] = useState(true)

  const [timeseries, setTimeseries] = useState<DashboardTimeseries>()
  const [timeseriesLoading, setTimeseriesLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    setSummaryLoading(true)
    fetchSummary()
      .then(data => {
        if (mounted) setSummary(data)
      })
      .catch(e => {
        useAppStore.getState().showToast('加载失败，请稍后重试', 'error')
      })
      .finally(() => {
        if (mounted) setSummaryLoading(false)
      })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    let mounted = true
    setTimeseriesLoading(true)
    fetchTimeseries(range)
      .then(data => {
        if (mounted) setTimeseries(data)
      })
      .catch(e => {
        useAppStore.getState().showToast('加载失败，请稍后重试', 'error')
      })
      .finally(() => {
        if (mounted) setTimeseriesLoading(false)
      })
    return () => { mounted = false }
  }, [range])

  return (
    <div className="max-w-6xl mx-auto mt-4">
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={() => navigate('/merchant')}
          className="p-2 hover:bg-[var(--color-surface)] rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="font-heading text-2xl font-bold text-[var(--color-text)]">经营数据</h1>
      </div>

      <SummaryCards data={summary} loading={summaryLoading} />

      <div className="flex justify-between items-end mb-2">
        <RangeFilter />
      </div>

      <TrendChart data={timeseries?.points || []} loading={timeseriesLoading} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <TopProducts data={timeseries?.top10 || []} loading={timeseriesLoading} />
        <StatusBreakdown data={timeseries?.statusBreakdown} loading={timeseriesLoading} />
      </div>
    </div>
  )
}
