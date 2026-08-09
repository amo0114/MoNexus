/**
 * SPEC-NOTIFY-RT-001 — controlled SSE v1 parser (T-FE-001 / REQ-F-007).
 *
 * No third-party EventSource / SSE library. Handles arbitrary chunk boundaries,
 * CRLF, comments, multi-line data, unknown fields, and a 64 KiB frame cap.
 * A frame over the cap yields `{ tooLarge: true }` so the caller can abort the
 * stream and enter degraded polling (CHK-FE-003).
 */
export const SSE_MAX_FRAME_BYTES = 65_536

export interface SseFrame {
  id?: string
  event?: string
  data?: string
  comment?: boolean
  /** Set once when a single frame exceeds the cap; the stream should abort. */
  tooLarge?: boolean
}

interface PartialFrame {
  id?: string
  event?: string
  dataLines: string[]
}

export class SseParser {
  private buffer = ''
  private frame: PartialFrame = { dataLines: [] }
  private frameBytes = 0
  private tooLargeReported = false
  private oversized = false

  /** Feed a decoded text chunk; returns the frames completed by this chunk. */
  feed(chunk: string): SseFrame[] {
    const out: SseFrame[] = []
    this.buffer += chunk
    // Bound an unterminated line as well as completed fields.
    if (!this.oversized && new TextEncoder().encode(this.buffer).byteLength + this.frameBytes > SSE_MAX_FRAME_BYTES) {
      this.oversized = true
      this.frame = { dataLines: [] }
      this.buffer = ''
      this.tooLargeReported = true
      out.push({ tooLarge: true })
    }
    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      const frame = this.processLine(line)
      if (frame) out.push(frame)
    }
    return out
  }

  /** Feed the remaining buffered text (call on stream end). */
  flush(): SseFrame[] {
    const out: SseFrame[] = []
    if (this.buffer.length > 0) {
      const frame = this.processLine(this.buffer)
      this.buffer = ''
      if (frame) out.push(frame)
    }
    const dispatched = this.dispatchFrame()
    if (dispatched) out.push(dispatched)
    return out
  }

  reset(): void {
    this.buffer = ''
    this.frame = { dataLines: [] }
    this.frameBytes = 0
    this.tooLargeReported = false
    this.oversized = false
  }

  private processLine(line: string): SseFrame | null {
    if (line === '') {
      if (this.oversized) { this.oversized = false; this.tooLargeReported = false; this.frame = { dataLines: [] }; this.frameBytes = 0; return null }
      return this.dispatchFrame()
    }
    // Comment line.
    if (line.startsWith(':')) {
      return { comment: true }
    }

    // Track byte size of the accumulating frame (excluding comments).
    if (this.oversized) return null
    this.frameBytes += new TextEncoder().encode(line).byteLength + 1
    if (this.frameBytes > SSE_MAX_FRAME_BYTES && !this.tooLargeReported) {
      this.tooLargeReported = true
      this.oversized = true
      this.frame = { dataLines: [] }
      return { tooLarge: true }
    }

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1)
    const trimmed = value.startsWith(' ') ? value.slice(1) : value

    if (field === 'id') {
      this.frame.id = trimmed
    } else if (field === 'event') {
      this.frame.event = trimmed
    } else if (field === 'data') {
      this.frame.dataLines.push(trimmed)
    }
    // Unknown fields are ignored per SSE spec.
    return null
  }

  private dispatchFrame(): SseFrame | null {
    const f = this.frame
    this.frame = { dataLines: [] }
    this.frameBytes = 0
    const hasContent = f.id !== undefined || f.event !== undefined || f.dataLines.length > 0
    if (!hasContent) return null
    return {
      ...(f.id !== undefined ? { id: f.id } : {}),
      ...(f.event !== undefined ? { event: f.event } : {}),
      ...(f.dataLines.length > 0 ? { data: f.dataLines.join('\n') } : {}),
    }
  }
}
