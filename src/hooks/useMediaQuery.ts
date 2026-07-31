import { useEffect, useState } from 'react'

/**
 * Reactive media-query hook. SSR-safe (defaults to false server-side).
 * Prefer this over reading window.innerWidth so breakpoint branches
 * respond to rotation / split-screen resizes.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )

  useEffect(() => {
    const mq = window.matchMedia(query)
    const update = () => setMatches(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [query])

  return matches
}

/** Shared Tailwind md breakpoint (768px), mobile = below it. */
export function useIsMobileViewport(): boolean {
  return useMediaQuery('(max-width: 767px)')
}
