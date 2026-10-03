import { randomUUID } from 'node:crypto'

/** UI-only identity claims; this token is unsigned and must stay on mocked APIs. */
export function createMockAccessToken(user: { id: number; role: string }, sessionId = randomUUID()): string {
  const encodedPayload = Buffer.from(JSON.stringify({
    userId: user.id,
    role: user.role,
    sid: sessionId,
    exp: Math.floor(Date.now() / 1000) + 900,
  })).toString('base64url')
  return `e30.${encodedPayload}.mock-signature`
}
