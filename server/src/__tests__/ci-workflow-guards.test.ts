import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function topLevelJob(workflow: string, jobId: string): string {
  const startMarker = `  ${jobId}:\n`
  const start = workflow.indexOf(startMarker)
  if (start < 0) {
    throw new Error(`Missing CI job: ${jobId}`)
  }

  const nextJob = workflow.slice(start + startMarker.length).search(/^  [a-z0-9-]+:\n/m)
  return nextJob < 0
    ? workflow.slice(start)
    : workflow.slice(start, start + startMarker.length + nextJob)
}

describe('CI workflow guards', () => {
  it('allows notification realtime E2E enough time to install Playwright dependencies', () => {
    const workflow = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8')
    const notificationE2e = topLevelJob(workflow, 'notification-realtime-e2e')

    expect(notificationE2e).toContain('timeout-minutes: 20')
    expect(notificationE2e).toContain('npx playwright install-deps chromium')
    expect(notificationE2e).toContain('bash scripts/verify-notification-realtime-e2e.sh')
  })
})
