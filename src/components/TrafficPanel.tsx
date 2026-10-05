import { useEffect, useState } from 'react'
import { Eye, Users, RefreshCw } from 'lucide-react'
import { fetchTrafficReport, type TrafficAudience, type TrafficRange, type TrafficReport } from '../api/traffic'
import { getApiErrorMessage } from '../api/error'

const number = new Intl.NumberFormat('zh-CN')
const updatedTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
})

function Ranking({ title, rows }: { title: string; rows: Array<{ key: number | string; name: string; pv: number; uv: number }> }) {
  return (
    <div className="min-w-0">
      <h3 className="font-semibold text-sm mb-3">{title}</h3>
      {rows.length === 0 ? <p className="text-sm text-[var(--color-text-muted)] py-4">暂无访问记录</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-[var(--color-text-muted)]">
              <tr><th className="pb-2 font-medium">名称</th><th className="pb-2 pl-4 text-right font-medium">PV</th><th className="pb-2 pl-4 text-right font-medium">UV</th></tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.key} className="border-t border-[var(--color-border)]">
                  <td className="py-2.5 max-w-[220px] truncate" title={row.name}>{row.name}</td>
                  <td className="py-2.5 pl-4 text-right tabular-nums">{number.format(row.pv)}</td>
                  <td className="py-2.5 pl-4 text-right tabular-nums">{number.format(row.uv)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function TrafficTrend({ points }: { points: TrafficReport['points'] }) {
  const max = Math.max(1, ...points.map(point => point.pv))
  const path = (metric: 'pv' | 'uv') => points.map((point, index) =>
    `${index === 0 ? 'M' : 'L'} ${12 + index / Math.max(1, points.length - 1) * 696} ${160 - point[metric] / max * 144}`
  ).join(' ')

  return (
    <div>
      <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)] mb-2">
        <span>每日访问趋势</span>
        <span className="flex gap-4"><span className="text-[var(--color-primary)]">实线 PV</span><span className="text-[var(--color-cta)]">虚线 UV</span></span>
      </div>
      <svg viewBox="0 0 720 180" className="w-full h-40 sm:h-48" role="img" aria-label="每日浏览量和访客数趋势，下方可展开查看每日数据">
        {[16, 88, 160].map(y => <line key={y} x1="12" y1={y} x2="708" y2={y} stroke="var(--color-border)" strokeDasharray="4 4" />)}
        <path d={path('pv')} fill="none" stroke="var(--color-primary)" strokeWidth="2" />
        <path d={path('uv')} fill="none" stroke="var(--color-cta)" strokeWidth="2" strokeDasharray="5 3" />
        <text x="12" y="12" fill="var(--color-text-muted)" fontSize="11">{number.format(max)}</text>
      </svg>
      <div className="flex justify-between text-xs text-[var(--color-text-muted)]">
        <span>{points[0]?.date}</span><span>{points[points.length - 1]?.date}</span>
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-[var(--color-text-muted)] w-fit">查看每日数据</summary>
        <div className="max-h-56 overflow-auto mt-2">
          <table className="w-full text-left text-sm">
            <thead><tr><th className="py-2">日期</th><th className="text-right">PV</th><th className="text-right">UV</th></tr></thead>
            <tbody>{points.map(point => <tr key={point.date} className="border-t border-[var(--color-border)]"><td className="py-2">{point.date}</td><td className="text-right tabular-nums">{number.format(point.pv)}</td><td className="text-right tabular-nums">{number.format(point.uv)}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

export default function TrafficPanel({ audience, range: controlledRange, active = true }: {
  audience: TrafficAudience
  range?: TrafficRange
  active?: boolean
}) {
  const [selectedRange, setSelectedRange] = useState<TrafficRange>('30d')
  const range = controlledRange ?? selectedRange
  const [data, setData] = useState<TrafficReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    fetchTrafficReport(audience, range)
      .then(report => { if (!cancelled) setData(report) })
      .catch(err => { if (!cancelled) setError(getApiErrorMessage(err, '访问统计加载失败，请稍后重试')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [audience, range, active, revision])

  const stale = data?.updatedAt && Date.now() - new Date(data.updatedAt).getTime() > 5 * 60_000
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4 sm:p-6 mb-6 text-[var(--color-text)]" aria-label="访问统计" aria-busy={loading}>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="font-heading text-lg font-bold">访问统计</h2>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            {audience === 'platform' ? '商城首页与全部商品详情页' : '自己的商品详情页'} · 北京时间 · 通常 1–2 分钟更新
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!controlledRange && <select aria-label="访问统计时间范围" value={range} onChange={event => setSelectedRange(event.target.value as TrafficRange)} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm">
            <option value="7d">近 7 天</option><option value="30d">近 30 天</option><option value="90d">近 90 天</option>
          </select>}
          <button type="button" aria-label="刷新访问统计" disabled={loading} onClick={() => setRevision(value => value + 1)} className="rounded-lg border border-[var(--color-border)] p-2.5 disabled:opacity-50"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>
      {loading && <p className="text-sm text-[var(--color-text-muted)] py-8" role="status">正在加载访问统计…</p>}
      {error && <p className="text-sm text-[var(--color-danger-text)] py-4" role="alert">{error}</p>}
      {!loading && data && <>
        {!data.updatedAt ? <p className="text-sm text-[var(--color-text-muted)] py-6">正在准备首次统计，请稍后刷新。</p> : <>
          <div className="grid grid-cols-2 gap-3 mb-5">
            {[{ label: '浏览量 PV', value: data.totals.pv, Icon: Eye }, { label: '访客数 UV', value: data.totals.uv, Icon: Users }].map(({ label, value, Icon }) => <div key={label} className="rounded-lg bg-[var(--color-surface)] p-4">
              <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]"><Icon className="w-4 h-4" />{label}</div>
              <div className="text-2xl font-bold tabular-nums mt-2">{number.format(value)}</div>
            </div>)}
          </div>
          <p className="text-xs text-[var(--color-text-muted)] mb-4">
            UV 按浏览器在所选期间去重，跨设备分别计数，不等于注册用户数。
            {data.startedAt && ` 采集开始于 ${updatedTime.format(new Date(data.startedAt))}。`}
          </p>
          <TrafficTrend points={data.points} />
          <div className={`grid gap-6 mt-6 pt-5 border-t border-[var(--color-border)] ${audience === 'platform' ? 'md:grid-cols-2' : ''}`}>
            <Ranking title="访问最多的商品 · TOP 10" rows={data.topProducts.map(row => ({ ...row, key: row.productId }))} />
            {audience === 'platform' && <Ranking title="商家商品访问 · TOP 10" rows={data.topMerchants.map(row => ({ ...row, key: row.merchantId ?? 'platform' }))} />}
          </div>
        </>}
        <p className={`text-xs mt-4 ${stale ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-muted)]'}`} role="status">
          {stale ? '统计更新延迟，当前展示上次汇总结果。' : ''}
          {data.updatedAt ? `最近汇总：${updatedTime.format(new Date(data.updatedAt))}` : ''}
          {data.pendingEvents > 0 ? ` · ${number.format(data.pendingEvents)} 条访问记录待汇总` : ''}
        </p>
      </>}
    </section>
  )
}
