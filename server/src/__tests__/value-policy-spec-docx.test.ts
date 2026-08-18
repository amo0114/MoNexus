import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function plainText(relative: string): string {
  return execFileSync('pandoc', [resolve(repoRoot, relative), '-f', 'docx', '-t', 'plain'], {
    encoding: 'utf8',
  })
}

describe('ValuePolicy spec DOCX sync', () => {
  it('keeps the Phase 1 DOCX aligned with the implemented/blocked status', () => {
    const text = plainText('docs/specs/points-value-policy-phase-1.docx')
    expect(text).toContain('Implemented — Production Activation Blocked by D-02/D-03')
    expect(text).toContain('VALUE_POLICY_DATA_INVALID')
    expect(text).toContain('无论客户端是否携带')
  })

  it('keeps the parent ledger spec DOCX from claiming the narrow Phase 1 is the ledger P1', () => {
    const text = plainText('docs/specs/points-real-value-alignment.docx')
    expect(text).toContain('两个“Phase 1”不要混用')
    expect(text).toContain('仍未实施')
  })
})
