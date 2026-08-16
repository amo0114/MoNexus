/** Commit guard for local-state fetches: only the latest begun request may publish. */
export function createLatestRequestGuard() {
  let revision = 0
  return {
    begin(): () => boolean {
      const requestRevision = ++revision
      return () => requestRevision === revision
    },
    invalidate(): void {
      revision += 1
    },
  }
}
