import React, { useEffect, useState, useRef } from 'react'

export interface AnimatedNumberProps {
  value: number | string
  className?: string
  dataTestId?: string
}

export default function AnimatedNumber({
  value,
  className = '',
  dataTestId,
}: AnimatedNumberProps) {
  const [animating, setAnimating] = useState(false)
  const prevValueRef = useRef(value)
  const isFirstRender = useRef(true)

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }

    if (prevValueRef.current !== value) {
      prevValueRef.current = value
      setAnimating(true)
      const timer = setTimeout(() => {
        setAnimating(false)
      }, 300)
      return () => clearTimeout(timer)
    }
  }, [value])

  return (
    <span
      data-testid={dataTestId}
      className={`inline-block tabular-nums transition-all duration-300 ${
        animating ? 'animate-[numberPopIn_0.25s_cubic-bezier(0.22,1,0.36,1)] text-[var(--color-primary)] scale-105' : ''
      } ${className}`}
      style={{ fontFeatureSettings: '"tnum" 1' }}
    >
      {value}
    </span>
  )
}
