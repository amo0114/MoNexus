import { describe, expect, it } from 'vitest'
import { SseParser, SSE_MAX_FRAME_BYTES } from '../sseParser.js'

describe('SseParser (SPEC-NOTIFY-RT-001 / CHK-FE-002~003)', () => {
  it('parses a ready frame fed as a single chunk', () => {
    const parser = new SseParser()
    const frames = parser.feed(
      'event: stream.ready\ndata: {"v":1,"resyncRequired":true}\n\n'
    )
    expect(frames).toEqual([
      { event: 'stream.ready', data: '{"v":1,"resyncRequired":true}' },
    ])
  })

  it('parses byte-by-byte chunk boundaries (arbitrary splits)', () => {
    const parser = new SseParser()
    const raw = 'id: 123\nevent: notification.created\ndata: {"v":1}\n\n: heartbeat 2026-01-01T00:00:00Z\n\n'
    const frames: unknown[] = []
    for (let i = 0; i < raw.length; i += 1) {
      frames.push(...parser.feed(raw[i]!))
    }
    expect(frames).toEqual([
      { id: '123', event: 'notification.created', data: '{"v":1}' },
      { comment: true },
    ])
  })

  it('handles CRLF line endings', () => {
    const parser = new SseParser()
    const frames = parser.feed('event: stream.ready\r\ndata: {}\r\n\r\n')
    expect(frames).toEqual([{ event: 'stream.ready', data: '{}' }])
  })

  it('joins multi-line data with newlines', () => {
    const parser = new SseParser()
    const frames = parser.feed('event: notification.created\ndata: line1\ndata: line2\n\n')
    expect(frames).toEqual([{ event: 'notification.created', data: 'line1\nline2' }])
  })

  it('ignores unknown fields and comments', () => {
    const parser = new SseParser()
    const frames = parser.feed('event: auth.expiring\nfoo: bar\ndata: {"expiresAt":"x"}\n\n')
    expect(frames).toEqual([{ event: 'auth.expiring', data: '{"expiresAt":"x"}' }])
  })

  it('dispatches on flush for a final unterminated frame', () => {
    const parser = new SseParser()
    parser.feed('event: stream.ready\ndata: {}')
    expect(parser.flush()).toEqual([{ event: 'stream.ready', data: '{}' }])
  })

  it('reports tooLarge when a frame exceeds the 64KiB cap (CHK-FE-003)', () => {
    const parser = new SseParser()
    const big = `data: ${'x'.repeat(SSE_MAX_FRAME_BYTES)}\n\n`
    const frames = parser.feed(big)
    expect(frames.some(f => f.tooLarge)).toBe(true)
  })

  it('resets cleanly after a tooLarge frame', () => {
    const parser = new SseParser()
    const big = `data: ${'x'.repeat(SSE_MAX_FRAME_BYTES)}\n\n`
    parser.feed(big)
    parser.reset()
    const frames = parser.feed('event: stream.ready\ndata: {}\n\n')
    expect(frames).toEqual([{ event: 'stream.ready', data: '{}' }])
  })

  it('caps by UTF-8 bytes and allows the exact boundary', () => {
    const exact = new SseParser()
    const prefix = 'data: '
    const payload = '界'.repeat(Math.floor((SSE_MAX_FRAME_BYTES - new TextEncoder().encode(prefix + '\n\n').byteLength) / 3))
    const raw = `${prefix}${payload}\n\n`
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(SSE_MAX_FRAME_BYTES)
    expect(exact.feed(raw).some((frame) => frame.tooLarge)).toBe(false)

    const oversized = new SseParser()
    expect(oversized.feed(`${prefix}${'界'.repeat(22_000)}`).some((frame) => frame.tooLarge)).toBe(true)
    // Bytes after the overflow are discarded until the frame boundary.
    expect(oversized.feed('\n\nevent: stream.ready\ndata: {}\n\n')).toEqual([
      { event: 'stream.ready', data: '{}' },
    ])
  })

  it('bounds an unterminated UTF-8 line', () => {
    const parser = new SseParser()
    expect(parser.feed('界'.repeat(22_000)).some((frame) => frame.tooLarge)).toBe(true)
  })
})
