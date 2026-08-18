import type { BacktestRuntime, GitIdentity } from '../types.js'

export function testRuntime(
  commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  treeState: GitIdentity['treeState'] = 'clean',
  now = '2026-08-18T00:00:00.000Z',
): BacktestRuntime {
  return {
    now: () => new Date(now),
    gitIdentity: () => ({ commit, treeState }),
  }
}
