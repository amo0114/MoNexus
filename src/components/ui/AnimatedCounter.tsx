import { useEffect, useState, useRef } from 'react'

interface AnimatedCounterProps {
  value: number
  prefix?: string
  suffix?: string
  decimals?: number
  formatFn?: (val: number) => string
  className?: string
  testId?: string
}

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

export default function AnimatedCounter({
  value,
  prefix = '',
  suffix = '',
  decimals = 0,
  formatFn,
  className = '',
  testId,
}: AnimatedCounterProps) {
  const [displayValue, setDisplayValue] = useState(value)
  const isFirstRender = useRef(true)

  useEffect(() => {
    setDisplayValue(value)
    if (isFirstRender.current) {
      const raf = requestAnimationFrame(() => {
        isFirstRender.current = false
      })
      return () => cancelAnimationFrame(raf)
    }
  }, [value])

  const formattedStr = formatFn
    ? formatFn(displayValue)
    : decimals > 0
      ? displayValue.toFixed(decimals)
      : displayValue.toLocaleString()

  const chars = formattedStr.split('')

  return (
    <span
      className={`odometer inline-flex items-baseline tabular-nums select-none ${className}`}
      data-testid={testId}
      role="img"
      aria-label={`${prefix}${formattedStr}${suffix}`}
    >
      {prefix && <span aria-hidden="true" className="odometer-affix">{prefix}</span>}
      <span aria-hidden="true" className="odometer-chars inline-flex overflow-hidden h-[1.15em] leading-[1.15em]">
        {chars.map((ch, idx) => {
          const isDigit = ch >= '0' && ch <= '9'
          if (!isDigit) {
            return (
              <span key={`${idx}-${ch}`} className="odometer-static">
                {ch}
              </span>
            )
          }
          const num = parseInt(ch, 10)
          return (
            <span
              key={idx}
              className="odometer-reel-window inline-block h-[1.15em] overflow-hidden align-top"
              style={{ width: '0.62em' }}
            >
              <span
                className="odometer-reel-track flex flex-col will-change-transform"
                style={{
                  transform: `translateY(-${num * 10}%)`,
                  transition: isFirstRender.current
                    ? 'none'
                    : 'transform var(--duration-slow, 400ms) var(--ease-smooth-out, cubic-bezier(0.22, 1, 0.36, 1))',
                }}
              >
                {DIGITS.map((d) => (
                  <span
                    key={d}
                    className="h-[1.15em] leading-[1.15em] block text-center"
                    aria-hidden="true"
                  >
                    {d}
                  </span>
                ))}
              </span>
            </span>
          )
        })}
      </span>
      {suffix && <span aria-hidden="true" className="odometer-affix">{suffix}</span>}
    </span>
  )
}
