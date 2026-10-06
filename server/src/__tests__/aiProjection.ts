// SPEC-AI-001 §4.2 — reusable assertions every AI-safe projection test must run.

import { expect } from 'vitest'

/** 1. Sentinel leak: none of the planted secrets may appear anywhere in the context. */
export function assertNoSentinel(context: unknown, sentinels: string[]): void {
  const serialized = JSON.stringify(context)
  for (const sentinel of sentinels) {
    expect(serialized.includes(sentinel), `context leaks sentinel ${sentinel}`).toBe(false)
  }
}

/** 2. Allowlist snapshot: recursive key paths, array indices collapsed to []. */
export function collectKeyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    const paths = new Set<string>()
    for (const item of value) for (const path of collectKeyPaths(item, `${prefix}[]`)) paths.add(path)
    return [...paths].sort()
  }
  if (value !== null && typeof value === 'object') {
    const paths: string[] = []
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key
      paths.push(path, ...collectKeyPaths(item, path))
    }
    return [...new Set(paths)].sort()
  }
  return []
}

/** 3. Unknown stays unknown: no 0 / 不限 / 永久 substituted for missing facts. */
export function assertUnknownPreserved(context: unknown): void {
  const serialized = JSON.stringify(context)
  for (const placeholder of ['"不限"', '"无限"', '"永久"']) {
    expect(serialized.includes(placeholder), `context invents ${placeholder}`).toBe(false)
  }
}
