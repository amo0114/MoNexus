import React, { useEffect, useState } from 'react'
import { fetchSummary, fetchTimeseries, fetchTopOffers, DashboardSummary, DashboardTimeseries, DashboardTopOffer } from '../../api/merchant/dashboard'
import { useDashboardStore } from '../../stores/dashboard'
import { useAppStore } from '../../stores/appStore'
import SummaryCards from './dashboard/SummaryCards'
import TrendChart from './dashboard/TrendChart'
import TopProducts from './dashboard/TopProducts'
import TopOffers from './dashboard/TopOffers'
import StatusBreakdown from './dashboard/StatusBreakdown'
import RangeFilter from './dashboard/RangeFilter'
import TrafficPanel from '../../components/TrafficPanel'
import WorkbenchSummary from '../../components/merchant/workbench/WorkbenchSummary'

export default function Dashboard() {
  const { range } = useDashboardStore()

  const [summary, setSummary] = useState<DashboardSummary>()
  const [summaryLoading, setSummaryLoading] = useState(true)

  const [timeseries, setTimeseries] = useState<DashboardTimeseries>()
  const [timeseriesLoading, setTimeseriesLoading] = useState(true)

  const [topOffers, setTopOffers] = useState<DashboardTopOffer[]>([])
  const [topOffersLoading, setTopOffersLoading] = useState(true)

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

  useEffect(() => {
    let mounted = true
    setTopOffersLoading(true)
    fetchTopOffers(range)
      .then(data => {
        if (mounted) setTopOffers(data.items)
      })
      .catch(e => {
        useAppStore.getState().showToast('加载失败，请稍后重试', 'error')
      })
      .finally(() => {
        if (mounted) setTopOffersLoading(false)
      })
    return () => { mounted = false }
  }, [range])

  return (
    <div className="fade-in">
      <h1 className="font-heading text-2xl font-bold text-[var(--color-text)] mb-6">经营数据</h1>

      {/* Loads independently; a workbench failure never blocks these statistics. */}
      <WorkbenchSummary />

      <SummaryCards data={summary} loading={summaryLoading} />

      <div className="flex justify-between items-end mb-2">
        <RangeFilter />
      </div>

      <TrendChart data={timeseries?.points || []} loading={timeseriesLoading} />
      <TrafficPanel audience="merchant" range={range} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <TopProducts data={timeseries?.top10 || []} loading={timeseriesLoading} />
        <TopOffers data={topOffers} loading={topOffersLoading} />
        <StatusBreakdown data={timeseries?.statusBreakdown} loading={timeseriesLoading} />
      </div>
    </div>
  )
}
