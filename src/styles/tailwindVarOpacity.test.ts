import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// Tailwind v3 cannot split an arbitrary var() colour into channels, so
// `bg-[var(--x)]/10` silently generates no CSS. Use a design token tint or
// `bg-[color-mix(in_srgb,var(--x)_10%,transparent)]` instead.
const DEAD_VAR_OPACITY = /-\[var\(--[\w-]+\)\]\/(?:\d|\[)/

const srcDir = join(process.cwd(), 'src')

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(full)
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield full
  }
}

describe('tailwind var() opacity guard', () => {
  it('has no opacity modifiers on arbitrary var() colours', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(srcDir)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (DEAD_VAR_OPACITY.test(line)) offenders.push(`${relative(srcDir, file)}:${index + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
