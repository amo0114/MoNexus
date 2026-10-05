import { useState, useRef, useEffect } from 'react'
import { Heart } from 'lucide-react'
import HeartBurst from '../ui/HeartBurst'
import { useMediaQuery } from '../../hooks/useMediaQuery'

interface FavoriteHeartButtonProps {
  favorite: boolean
  onClick: () => void
  showLabel?: boolean
  label?: string
  size?: number
  className?: string
  ariaLabel?: string
  type?: 'button' | 'submit' | 'reset'
  'data-testid'?: string
}

export default function FavoriteHeartButton({
  favorite,
  onClick,
  showLabel = false,
  label,
  size = 19,
  className = '',
  ariaLabel,
  type = 'button',
  'data-testid': dataTestId,
}: FavoriteHeartButtonProps) {
  const [bursting, setBursting] = useState(false)
  const prevFavoriteRef = useRef(favorite)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

  useEffect(() => {
    const wasFavorite = prevFavoriteRef.current
    prevFavoriteRef.current = favorite
    if (!favorite || reducedMotion) {
      setBursting(false)
      return
    }
    // Persisted favorites do not celebrate on mount or when motion is re-enabled.
    if (wasFavorite) return
    setBursting(true)
    // Include the last particle's delay (600ms animation + up to 70ms).
    const timer = setTimeout(() => setBursting(false), 700)
    return () => clearTimeout(timer)
  }, [favorite, reducedMotion])

  const defaultText = favorite ? '已收藏' : '收藏'
  const textContent = label ?? defaultText
  const celebrating = bursting && favorite && !reducedMotion

  return (
    <button
      type={type}
      aria-pressed={favorite}
      aria-label={ariaLabel ?? textContent}
      data-testid={dataTestId}
      className={`t-like-btn ${celebrating ? 'is-bursting' : ''} ${className}`}
      onClick={onClick}
    >
      <span className="t-like-icon" style={{ position: 'relative', display: 'inline-flex' }}>
        <Heart
          size={size}
          fill={favorite ? 'currentColor' : 'none'}
          className="t-like-heart"
          aria-hidden="true"
        />
        {celebrating && <HeartBurst />}
      </span>
      {showLabel && <span>{textContent}</span>}
    </button>
  )
}
