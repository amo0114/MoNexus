import React, { useState, useMemo } from 'react'
import { DashboardSeriesPoint } from '../../../api/merchant/dashboard'

export default function TrendChart({ data, loading }: { data: DashboardSeriesPoint[], loading: boolean }) {
  const [metric, setMetric] = useState<'pointsRevenue' | 'orderCount'>('pointsRevenue')
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  const { pathD, points, maxVal } = useMemo(() => {
    if (!data || data.length === 0) return { pathD: '', points: [], maxVal: 0 }

    const max = Math.max(...data.map(d => d[metric]), 1)
    const w = 1000
    const h = 200
    const step = w / Math.max(data.length - 1, 1)

    const pts = data.map((d, i) => {
      const x = i * step
      const y = h - (d[metric] / max) * h
      return { x, y, data: d, index: i }
    })

    const d = pts.length > 0
      ? `M ${pts[0].x} ${pts[0].y} ` + pts.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ')
      : ''

    return { pathD: d, points: pts, maxVal: max }
  }, [data, metric])

  if (loading) {
    return <div className="card h-[300px] flex items-center justify-center animate-pulse bg-[var(--color-background)] rounded-lg border border-[var(--color-border)] mb-6"><div className="w-1/2 h-4 bg-[var(--color-border)] rounded"></div></div>
  }

  if (!data || data.length === 0) {
    return (
      <div className="card h-[300px] flex items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] mb-6">
        <span className="text-[var(--color-text-muted)] text-sm">暂无数据</span>
      </div>
    )
  }

  return (
    <div className="card p-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] mb-6">
      <div className="flex justify-between items-center mb-6">
        <h3 className="font-heading text-lg font-bold text-[var(--color-text)]">趋势分析</h3>
        <select
          className="bg-[var(--color-surface)] border border-[var(--color-border)] text-sm rounded-md px-3 py-1.5 text-[var(--color-text)] cursor-pointer"
          value={metric}
          onChange={(e) => setMetric(e.target.value as any)}
        >
          <option value="pointsRevenue">积分流水</option>
          <option value="orderCount">订单数</option>
        </select>
      </div>

      <div className="relative w-full h-[200px]">
        <svg viewBox="0 0 1000 200" preserveAspectRatio="none" className="w-full h-full overflow-visible">
          <line x1="0" y1="0" x2="1000" y2="0" stroke="var(--color-border)" strokeWidth="1" strokeDasharray="4 4" />
          <line x1="0" y1="100" x2="1000" y2="100" stroke="var(--color-border)" strokeWidth="1" strokeDasharray="4 4" />
          <line x1="0" y1="200" x2="1000" y2="200" stroke="var(--color-border)" strokeWidth="1" strokeDasharray="4 4" />

          <path d={pathD} fill="none" stroke="var(--color-primary)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

          {points.map((p) => (
            <g key={p.index}
               onMouseEnter={() => setHoveredIndex(p.index)}
               onMouseLeave={() => setHoveredIndex(null)}
               className="cursor-pointer">
              <circle cx={p.x} cy={p.y} r="4" fill="var(--color-background)" stroke="var(--color-primary)" strokeWidth="2" />
              <circle cx={p.x} cy={p.y} r="15" fill="transparent" />
              {hoveredIndex === p.index && (
                <circle cx={p.x} cy={p.y} r="6" fill="var(--color-primary)" opacity="0.2" />
              )}
            </g>
          ))}
        </svg>

        {hoveredIndex !== null && (
          <div
            className="absolute z-10 bg-[var(--color-surface)] border border-[var(--color-border)] shadow-lg rounded p-3 pointer-events-none transform -translate-x-1/2 -translate-y-[120%]"
            style={{
              left: `${(points[hoveredIndex].x / 1000) * 100}%`,
              top: `${(points[hoveredIndex].y / 200) * 100}%`
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
