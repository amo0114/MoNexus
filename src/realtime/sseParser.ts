/**
 * SPEC-NOTIFY-RT-001 — controlled SSE v1 parser (T-FE-001 / REQ-F-007).
 *
 * No third-party EventSource / SSE library. Handles arbitrary chunk boundaries,
 * CRLF, comments, multi-line data, unknown fields, and a 64 KiB frame cap.
 * A frame over the cap yields `{ tooLarge: true }` so the caller can abort the
 * stream and enter degraded polling (CHK-FE-003).
 */
export const SSE_MAX_FRAME_BYTES = 65_536

/** Shared UTF-8 encoder — avoids allocating a new TextEncoder per line/chunk. */
const utf8Encoder = new TextEncoder()

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
  private bufferBytes = 0
  private tooLargeReported = false
  private oversized = false

  /** Feed a decoded text chunk; returns the frames completed by this chunk. */
  feed(chunk: string): SseFrame[] {
    const out: SseFrame[] = []
    this.buffer += chunk
    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      const rawLine = line + '\n'
      const lineBytes = utf8Encoder.encode(rawLine).byteLength
      if (line.endsWith('\r')) line = line.slice(0, -1)
      const frame = this.processLine(line, lineBytes)
      if (frame) out.push(frame)
    }
    this.bufferBytes = utf8Encoder.encode(this.buffer).byteLength
    // Process complete lines first: one network chunk may legitimately contain
    // many small frames whose aggregate size is larger than the per-frame cap.
    if (!this.oversized && this.bufferBytes + this.frameBytes > SSE_MAX_FRAME_BYTES) {
      this.oversized = true
      this.frame = { dataLines: [] }
      this.frameBytes = 0
      this.buffer = ''
      this.bufferBytes = 0
      this.tooLargeReported = true
      out.push({ tooLarge: true })
    } else if (this.oversized) {
      // Discard an unterminated oversized line without retaining unbounded data.
      this.buffer = ''
      this.bufferBytes = 0
    }
    return out
  }

  /** Feed the remaining buffered text (call on stream end). */
  flush(): SseFrame[] {
    const out: SseFrame[] = []
    if (this.buffer.length > 0) {
      const frame = this.processLine(this.buffer)
      this.buffer = ''
      this.bufferBytes = 0
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
    this.bufferBytes = 0
    this.tooLargeReported = false
    this.oversized = false
  }

  private processLine(line: string, rawBytes?: number): SseFrame | null {
    if (line === '') {
      if (this.oversized) { this.oversized = false; this.tooLargeReported = false; this.frame = { dataLines: [] }; this.frameBytes = 0; return null }
      return this.dispatchFrame()
    }
    // Track raw UTF-8 bytes for every field/comment in the current frame.
    if (this.oversized) return null
    this.frameBytes += rawBytes ?? (utf8Encoder.encode(line).byteLength + 1)
    if (this.frameBytes > SSE_MAX_FRAME_BYTES && !this.tooLargeReported) {
      this.tooLargeReported = true
      this.oversized = true
      this.frame = { dataLines: [] }
      return { tooLarge: true }
    }

    if (line.startsWith(':')) {
      return { comment: true }
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
