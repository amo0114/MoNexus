import { useCallback, useEffect, useRef, useState } from 'react'
import type { GenericAbortSignal } from 'axios'
import type { GVCursorPage } from '../types/governance'
import { getApiErrorMessage } from '../api/error'
import { isForbiddenError } from '../utils/governance'

export type CursorFetcher<T> = (args: { cursor: string | null; signal: GenericAbortSignal }) => Promise<GVCursorPage<T>>

export interface CursorListState<T> {
  items: T[]
  asOf: string | null
  loading: boolean
  loadingMore: boolean
  error: string | null
  forbidden: boolean
  hasNextPage: boolean
  loadMore: () => void
  reload: () => void
}

/**
 * Keyset list for governance-v1 detail sections.
 *
 * `key` identifies the query (target id + filters). When it changes the old
 * cursor is dropped and in-flight requests are aborted, so a late response for
 * user A can never render inside user B's view. `enabled=false` performs no
 * request at all (used for sections the admin may not see).
 */
export function useCursorList<T>(key: string, fetcher: CursorFetcher<T>, enabled = true): CursorListState<T> {
  const [items, setItems] = useState<T[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [generation, setGeneration] = useState(0)

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const controllerRef = useRef<AbortController | null>(null)
  const seqRef = useRef(0)

  const run = useCallback((from: string | null) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const seq = ++seqRef.current
    const append = from !== null
    if (append) setLoadingMore(true)
    else setLoading(true)
    setError(null)
    fetcherRef.current({ cursor: from, signal: controller.signal })
      .then((page) => {
        if (seq !== seqRef.current) return
        setItems((prev) => (append ? [...prev, ...page.items] : page.items))
        setCursor(page.pageInfo.nextCursor)
        setHasNextPage(page.pageInfo.hasNextPage && page.pageInfo.nextCursor !== null)
        setAsOf(page.asOf)
        setForbidden(false)
      })
      .catch((err) => {
        if (seq !== seqRef.current || controller.signal.aborted) return
        if (isForbiddenError(err)) setForbidden(true)
        else setError(getApiErrorMessage(err, '加载失败'))
      })
      .finally(() => {
        if (seq !== seqRef.current) return
        setLoading(false)
        setLoadingMore(false)
      })
  }, [])

  useEffect(() => {
    setItems([])
    setCursor(null)
    setHasNextPage(false)
    setAsOf(null)
    setError(null)
    setForbidden(false)
    if (!enabled) {
      seqRef.current++
      controllerRef.current?.abort()
      setLoading(false)
      setLoadingMore(false)
      return
    }
    run(null)
    return () => {
      seqRef.current++
      controllerRef.current?.abort()
    }
  }, [key, enabled, generation, run])

  return {
    items,
    asOf,
    loading,
    loadingMore,
    error,
    forbidden,
    hasNextPage,
    loadMore: () => {
      if (!loading && !loadingMore && hasNextPage && cursor) run(cursor)
    },
    reload: () => setGeneration((g) => g + 1),
  }
}
