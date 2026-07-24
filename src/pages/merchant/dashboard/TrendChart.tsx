import React, { useState, useMemo, useEffect, useRef } from 'react'
import { LineChart } from 'lucide-react'
import { DashboardSeriesPoint } from '../../../api/merchant/dashboard'
import EmptyState from '../../../components/ui/EmptyState'

const CHART_HEIGHT = 200

export default function TrendChart({ data, loading }: { data: DashboardSeriesPoint[], loading: boolean }) {
  const [metric, setMetric] = useState<'pointsRevenue' | 'orderCount'>('pointsRevenue')
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  // Measure the container so the viewBox matches the rendered aspect ratio
  // 1:1 — circles stay round and stroke widths uniform at any width
  // (the previous hardcoded 1000×200 + preserveAspectRatio="none" squashed
  // points into ellipses on phones).
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width)
      if (w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Reset the selection whenever the dataset changes (e.g. switching
  // from a 30-day range to 7 days) — a stale hoveredIndex would point
  // past the end of the shorter series and crash the tooltip render.
  useEffect(() => {
    setHoveredIndex(null)
  }, [data])

  const { pathD, points } = useMemo(() => {
    if (!data || data.length === 0) return { pathD: '', points: [] }

    const max = Math.max(...data.map(d => d[metric]), 1)
    const w = width
    const h = CHART_HEIGHT
    const step = w / Math.max(data.length - 1, 1)

    const pts = data.map((d, i) => {
      const x = i * step
      const y = h - (d[metric] / max) * h
      return { x, y, data: d, index: i }
    })

    const d = pts.length > 0
      ? `M ${pts[0].x} ${pts[0].y} ` + pts.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ')
      : ''

    return { pathD: d, points: pts }
  }, [data, metric, width])

  if (loading) {
    return <div className="card h-[300px] flex items-center justify-center animate-pulse bg-[var(--color-background)] rounded-lg border border-[var(--color-border)] mb-6"><div className="w-1/2 h-4 bg-[var(--color-border)] rounded"></div></div>
  }

  if (!data || data.length === 0) {
    return (
      <div className="card h-[300px] flex items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] mb-6">
        <EmptyState compact icon={LineChart} title="暂无数据" description="所选时间范围内还没有经营数据" />
      </div>
    )
  }

  // Selection model: click SETS the active point (tap on touch also fires
  // a synthesized mouseenter first — a toggle would cancel it out, which
  // is why the first tap appeared to do nothing). Tapping the chart
  // background clears. Mouse hover is untouched.
  const selectPoint = (index: number) => setHoveredIndex(index)

  return (
    <div className="card p-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] mb-6">
      <div className="flex justify-between items-center mb-6">
        <h3 className="font-heading text-lg font-bold text-[var(--color-text)]">趋势分析</h3>
        <select
          className="bg-[var(--color-surface)] border border-[var(--color-border)] text-sm rounded-md px-3 py-1.5 text-[var(--color-text)] cursor-pointer"
          value={metric}
          onChange={(e) => setMetric(e.target.value as any)}
          aria-label="选择趋势指标"
        >
          <option value="pointsRevenue">积分流水</option>
          <option value="orderCount">订单数</option>
        </select>
      </div>

      <div ref={containerRef} className="relative w-full h-[200px]" data-testid="merchant-trend-chart">
        <svg viewBox={`0 0 ${width} ${CHART_HEIGHT}`} className="w-full h-full overflow-visible" onClick={() => setHoveredIndex(null)}>
          <line x1="0" y1="0" x2={width} y2="0" stroke="var(--color-border)" strokeWidth="1" strokeDasharray="4 4" />
          <line x1="0" y1="100" x2={width} y2="100" stroke="var(--color-border)" strokeWidth="1" strokeDasharray="4 4" />
          <line x1="0" y1="200" x2={width} y2="200" stroke="var(--color-border)" strokeWidth="1" strokeDasharray="4 4" />

          <path d={pathD} fill="none" stroke="var(--color-primary)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

          {points.map((p) => (
            <g key={p.index}
               onMouseEnter={() => setHoveredIndex(p.index)}
               onMouseLeave={() => setHoveredIndex(null)}
               onClick={(e) => { e.stopPropagation(); selectPoint(p.index) }}
               className="cursor-pointer">
              <circle cx={p.x} cy={p.y} r="4" fill="var(--color-background)" stroke="var(--color-primary)" strokeWidth="2" />
              <circle cx={p.x} cy={p.y} r="15" fill="transparent" />
              {hoveredIndex === p.index && (
                <circle cx={p.x} cy={p.y} r="6" fill="var(--color-primary)" opacity="0.2" />
              )}
            </g>
          ))}
        </svg>

        {hoveredIndex !== null && points[hoveredIndex] && (
          <div
            className="absolute z-10 bg-[var(--color-surface)] border border-[var(--color-border)] shadow-lg rounded p-3 pointer-events-none transform -translate-x-1/2 -translate-y-[120%]"
            style={{
              left: `${(points[hoveredIndex].x / width) * 100}%`,
              top: `${(points[hoveredIndex].y / CHART_HEIGHT) * 100}%`
            }}
          >
            <div className="text-xs text-[var(--color-text-muted)] mb-1">{points[hoveredIndex].data.date}</div>
            <div className="text-sm font-bold text-[var(--color-cta)]">积分: {points[hoveredIndex].data.pointsRevenue}</div>
            <div className="text-sm font-bold text-[var(--color-text)]">订单: {points[hoveredIndex].data.orderCount}</div>
          </div>
        )}
      </div>
      <div className="flex justify-between text-xs text-[var(--color-text-muted)] mt-2">
        <span>{data[0]?.date}</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  )
}
