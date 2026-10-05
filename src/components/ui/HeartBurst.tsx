import type { CSSProperties } from 'react'

const PARTICLES = [
  { x: 0, y: -20, delay: 0, scale: 0.6, color: '#ef4444' },
  { x: 14, y: -14, delay: 40, scale: 0.5, color: '#f43f5e' },
  { x: 20, y: 0, delay: 20, scale: 0.7, color: '#ec4899' },
  { x: 14, y: 14, delay: 60, scale: 0.5, color: '#f43f5e' },
  { x: 0, y: 20, delay: 30, scale: 0.6, color: '#ef4444' },
  { x: -14, y: 14, delay: 70, scale: 0.5, color: '#f43f5e' },
  { x: -20, y: 0, delay: 15, scale: 0.7, color: '#ec4899' },
  { x: -14, y: -14, delay: 50, scale: 0.5, color: '#f43f5e' },
]

/** Shared bloom; other confirmation states can supply their own accent color. */
export default function HeartBurst({ distance = 20, delay = 0, color }: { distance?: number; delay?: number; color?: string }) {
  return (
    <span className="t-like-particles" aria-hidden="true">
      {PARTICLES.map((particle, index) => (
        <i key={index} style={{
          '--px': `${particle.x * distance / 20}px`,
          '--py': `${particle.y * distance / 20}px`,
          '--pdelay': `${particle.delay + delay}ms`,
          '--p-end-scale': particle.scale,
          backgroundColor: color ?? particle.color,
        } as CSSProperties} />
      ))}
    </span>
  )
}
