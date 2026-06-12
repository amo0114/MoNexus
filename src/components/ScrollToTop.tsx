import { useEffect } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

export default function ScrollToTop() {
  const { pathname } = useLocation()
  const navigationType = useNavigationType()

  useEffect(() => {
    if (!('scrollRestoration' in window.history)) return
    const previous = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'
    return () => {
      window.history.scrollRestoration = previous
    }
  }, [])

  useEffect(() => {
    if (pathname === '/' && window.sessionStorage.getItem('monexus:restore-store-scroll') === '1') return
    if (navigationType === 'POP') return
    window.scrollTo(0, 0)
  }, [navigationType, pathname])

  return null
}
