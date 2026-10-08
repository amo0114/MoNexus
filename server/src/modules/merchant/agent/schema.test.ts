import { describe, expect, it } from 'vitest'
import { AgentOutputInvalidError, parseDecision, ToolArgumentsError } from './schema.js'

describe('parseDecision', () => {
  it('treats omitted branches and tool fields as null (JSON-compatible output mode)', () => {
    expect(parseDecision({ kind: 'clarify', clarify: { question: '是哪一个？', candidateRefs: [] } }))
      .toEqual({ kind: 'clarify', question: '是哪一个？', candidateRefs: [] })
    expect(parseDecision({ kind: 'tool', tool: { name: 'read_workbench', group: 'urgent' } }))
      .toEqual({ kind: 'tool', call: { name: 'read_workbench', group: 'urgent', cursorRef: null } })
  })

  it('still rejects wrong types, unknown keys and a missing selected branch', () => {
    expect(() => parseDecision({ kind: 'answer' })).toThrow(AgentOutputInvalidError)
    expect(() => parseDecision({ kind: 'tool', tool: { name: 'drop_table' } })).toThrow(AgentOutputInvalidError)
    expect(() => parseDecision({ kind: 'answer', answer: { blocks: [{ text: 'x', evidenceRefs: [], actionRef: null, url: 'https://x' }] } }))
      .toThrow(AgentOutputInvalidError)
  })
})

describe('tool argument errors', () => {
  it('reports missing arguments of a known tool separately from unusable output', () => {
    expect(() => parseDecision({ kind: 'tool', tool: { name: 'find_products', query: null } })).toThrow(ToolArgumentsError)
    expect(() => parseDecision({ kind: 'tool', tool: { name: 'inspect_product' } })).toThrow(ToolArgumentsError)
  })
})
