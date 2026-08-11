export type RequestKind = 'foreground' | 'background'

/** Pure request generations plus skeleton ownership for latest-wins views. */
export function createLatestRequestCoordinator(initialLoading = true) {
  let generation = 0
  let loadingOwner: number | null = initialLoading ? 0 : null

  return {
    begin(kind: RequestKind) {
      const id = ++generation
      if (kind === 'foreground' || loadingOwner !== null) loadingOwner = id
      return id
    },
    isLatest(id: number) {
      return id === generation
    },
    ownsLoading(id: number) {
      return loadingOwner === id
    },
    finish(id: number) {
      if (loadingOwner !== id) return false
      loadingOwner = null
      return true
    },
    get generation() { return generation },
    get loadingOwner() { return loadingOwner },
  }
}
