import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import http, { type ClientRequest, type IncomingMessage } from 'node:http'
import net from 'node:net'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import { config } from '../../../config/index.js'
import { prisma } from '../../../lib/prisma.js'
import { createTestUser } from '../../../__tests__/helpers.js'

/**
 * SPEC-NOTIFY-RT-001 T-BE-005 — graceful shutdown (CHK-OPS-006/007, AC-RT-018).
 * A real child process runs main.ts with realtime enabled; we open an active SSE
 * stream, SIGTERM the child, and verify the stream drains within 5s and the
 * process exits cleanly within the 10s force-exit budget.
 */

interface ParsedFrame {
  event?: string
  data?: string
}

function parseSseBlock(block: string): ParsedFrame {
  const frame: ParsedFrame = {}
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) frame.event = line.slice(6).trim()
    else if (line.startsWith('data:')) frame.data = (frame.data ? `${frame.data}\n` : '') + line.slice(5).trimStart()
  }
  return frame
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function getJson(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let data = ''
      res.on('data', c => {
        data += c
      })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) })
        } catch {
          resolve({ status: res.statusCode ?? 0, body: {} })
        }
      })
    })
    req.on('error', reject)
  })
}

const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..', '..')

describe('realtime graceful shutdown (SPEC-NOTIFY-RT-001 T-BE-005)', () => {
  let child: ChildProcess | null = null
  let port = 0

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL')
    }
  })

  it('CHK-OPS-006/007 / AC-RT-018: SIGTERM drains an active SSE stream within 5s and exits cleanly', async () => {
    port = await getFreePort()
    const { user } = await createTestUser(`rt-shutdown-${Date.now()}@test.local`)
    const token = jwt.sign({ userId: user.id, role: 'user' }, config.jwtSecret, { expiresIn: '15m' })

    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        DATABASE_URL: config.databaseUrl,
        JWT_SECRET: config.jwtSecret,
        FRONTEND_ORIGIN: config.frontendOrigin,
        COOKIE_SECURE: 'false',
        NOTIFICATION_ENABLED: 'true',
        NOTIFICATION_REALTIME_ENABLED: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let childLog = ''
    child.stdout!.on('data', d => {
      childLog += d
    })
    child.stderr!.on('data', d => {
      childLog += d
    })

    // Wait for the child to become ready with a healthy listener.
    const readyDeadline = Date.now() + 20_000
    let realtimeOk = false
    while (Date.now() < readyDeadline) {
      const res = await getJson(`http://127.0.0.1:${port}/api/health/ready`).catch(() => null)
      if (res && res.status === 200 && res.body?.checks?.notificationRealtime === 'ok') {
        realtimeOk = true
        break
      }
      await new Promise(r => setTimeout(r, 200))
    }
    expect(realtimeOk).toBe(true)

    // Open an active SSE stream.
    const stream = await new Promise<{ req: ClientRequest; frames: ParsedFrame[]; closed: boolean }>(resolve => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/notifications/stream',
        method: 'GET',
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
      })
      const state = { req, frames: [] as ParsedFrame[], closed: false }
      req.on('response', (res: IncomingMessage) => {
        let buffer = ''
        res.setEncoding('utf8')
        res.on('data', chunk => {
          buffer += chunk
          let idx: number
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            state.frames.push(parseSseBlock(buffer.slice(0, idx)))
            buffer = buffer.slice(idx + 2)
          }
        })
        res.on('end', () => {
          state.closed = true
        })
        res.on('close', () => {
          state.closed = true
        })
        resolve(state)
      })
      req.end()
    })

    // Wait for stream.ready so the connection is fully registered.
    const readyWait = Date.now() + 5000
    while (Date.now() < readyWait && !stream.frames.some(f => f.event === 'stream.ready')) {
      await new Promise(r => setTimeout(r, 50))
    }
    expect(stream.frames.some(f => f.event === 'stream.ready')).toBe(true)

    // SIGTERM the child.
    const sigtermTime = Date.now()
    child.kill('SIGTERM')

    // The active stream must close (degraded or EOF) within 5 seconds.
    const drainDeadline = Date.now() + 5000
    while (Date.now() < drainDeadline && !stream.closed) {
      await new Promise(r => setTimeout(r, 100))
    }
    expect(stream.closed, `stream did not close within 5s; log: ${childLog.slice(-2000)}`).toBe(true)
    expect(Date.now() - sigtermTime).toBeLessThanOrEqual(5500)

    // The process must exit cleanly within the 10s force-exit budget.
    const exitCode = await new Promise<number | null>(resolve => {
      const t = setTimeout(() => resolve(null), 12_000)
      child!.on('exit', code => {
        clearTimeout(t)
        resolve(code)
      })
    })
    expect(exitCode).toBe(0)
  }, 40_000)
})
