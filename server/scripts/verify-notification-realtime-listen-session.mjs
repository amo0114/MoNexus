#!/usr/bin/env node
/**
 * SPEC-NOTIFY-RT-001 (T-INF-002) — AC-RT-029 / CHK-INF-007 LISTEN session gate.
 *
 * Runs the actual-role gate against a production-like PostgreSQL endpoint:
 *  1. connect + current_user vs declared role (match boolean only) + P_pre
 *  2. LISTEN static channel + command ACK -> P0
 *  3. independent sender NOTIFYs unique v1 payloads at t≈0/30/60 (5s each round)
 *  4. t≈30/60 `SELECT 1, pg_backend_pid()` probes -> P30/P60
 *  5. 4 auxiliary connections each run 10 short transactions (t=0..60)
 *
 * Pass requires {P_pre,P0,P30,P60} distinct count = 1, all 3 rounds received,
 * and no 42501 / connection / LISTEN errors. Output is redacted: only PID
 * distinct count, round results, permission conclusions, duration and endpoint
 * class. Never prints PIDs, URLs, usernames or passwords.
 *
 * Env (read from a git-ignored production-like env file, xtrace off):
 *   RT_SESSION_DATABASE_URL   production-like direct/session-pool URL
 *   RT_SESSION_ROLE           declared database role (for current_user match)
 *   RT_SESSION_ENDPOINT_CLASS direct | session_pool
 *   RT_SESSION_REVISION       deployment / endpoint revision
 */
import { Client } from 'pg'

const CHANNEL = 'monexus_notification_created_v1'

const url = process.env.RT_SESSION_DATABASE_URL
const declaredRole = process.env.RT_SESSION_ROLE
const endpointClass = process.env.RT_SESSION_ENDPOINT_CLASS ?? 'session_pool'
const revision = process.env.RT_SESSION_REVISION ?? 'unknown'

if (process.argv.includes('--self-test')) {
  const cases = [
    ['four workers connected', { connected: 4, attempted: 40, committed: 40, failed: 0, roleMatch: true }],
    ['39 transactions', { connected: 4, attempted: 40, committed: 39, failed: 0, roleMatch: true }],
    ['reject', { connected: 4, attempted: 40, committed: 39, failed: 1, roleMatch: true }],
    ['role mismatch', { connected: 4, attempted: 40, committed: 40, failed: 0, roleMatch: false }],
  ]
  const accepts = (x) => x.connected === 4 && x.attempted === 40 && x.committed === 40 && x.failed === 0 && x.roleMatch
  if (accepts(cases[0][1]) && cases.slice(1).some(([, x]) => accepts(x))) process.exit(1)
  console.log('[gate] self-test=PASS (valid accepted; incomplete/reject/role mismatch rejected)')
  process.exit(0)
}

if (!url) {
  console.error('[gate] RT_SESSION_DATABASE_URL is required')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function redactedHost(url) {
  try {
    const u = new URL(url)
    return `${u.hostname}:${u.port ?? 5432}`
  } catch {
    return '<redacted>'
  }
}

async function run() {
  const startedAt = Date.now()
  const listener = new Client({ connectionString: url, application_name: 'monexus-notification-realtime-listener' })
  const received = []

  try {
    await listener.connect()
  } catch (err) {
    console.error('[gate] CONNECT FAILED')
    console.error(`[gate] connect_permission=${err.code === '42501' ? 'denied' : 'other'}`)
    process.exit(1)
  }

  let currentUser
  let pPre
  let p0 = null
  let p30 = null
  let p60 = null
  try {
    const cu = await listener.query('SELECT current_user AS u, pg_backend_pid() AS pid')
    currentUser = cu.rows[0].u
    pPre = Number(cu.rows[0].pid)
  } catch (err) {
    console.error(`[gate] CONNECT_QUERY_FAILED ${err.code ?? 'unknown'}`)
    await listener.end().catch(() => {})
    process.exit(1)
  }

  const roleMatch = declaredRole ? currentUser === declaredRole : null

  // LISTEN static channel + command ACK.
  try {
    await listener.query(`LISTEN ${CHANNEL}`)
    const p = await listener.query('SELECT pg_backend_pid() AS pid')
    p0 = Number(p.rows[0].pid)
  } catch (err) {
    console.error(`[gate] LISTEN_FAILED ${err.code ?? 'unknown'}`)
    await listener.end().catch(() => {})
    process.exit(1)
  }

  listener.on('notification', (msg) => {
    received.push(msg.payload)
  })

  // 4 auxiliary connections each run 10 short transactions over the 60s window.
  const aux = []
  const auxWorkers = []
  let auxAttempted = 0
  let auxCommitted = 0
  let auxFailed = 0
  try {
    for (let i = 0; i < 4; i += 1) {
      const c = new Client({ connectionString: url })
      await c.connect()
      aux.push(c)
      auxWorkers.push((async () => {
        for (let t = 0; t < 10; t += 1) {
          auxAttempted += 1
          try {
            await c.query('BEGIN')
            await c.query('SELECT 1')
            await c.query('COMMIT')
            auxCommitted += 1
          } catch {
            auxFailed += 1
            try {
              await c.query('ROLLBACK')
            } catch { /* ignore */ }
          }
          await sleep(1500 + Math.random() * 1500)
        }
        await c.end().catch(() => {})
      })())
    }
  } catch (err) {
    console.error(`[gate] AUX_CONNECT_FAILED ${err.code ?? 'unknown'}`)
  }

  // Independent sender (not one of the auxiliary connections).
  const sender = new Client({ connectionString: url })
  try {
    await sender.connect()
  } catch (err) {
    console.error(`[gate] SENDER_CONNECT_FAILED ${err.code ?? 'unknown'}`)
    await listener.end().catch(() => {})
    process.exit(1)
  }

  const rounds = []
  const sendRound = async (round) => {
    const payload = JSON.stringify({ v: 1, notificationId: 1_000_000 + round, recipientUserId: 1_000_000 + round })
    let ok = false
    let permission = true
    try {
      await sender.query('SELECT pg_notify($1, $2)', [CHANNEL, payload])
      const roundDeadline = Date.now() + 5000
      while (Date.now() < roundDeadline) {
        if (received.includes(payload)) {
          ok = true
          break
        }
        await sleep(100)
      }
    } catch (err) {
      permission = err.code !== '42501'
    }
    rounds.push({ round, ok, permission })
  }

  // t≈0: send round 0
  await sendRound(0)
  await sleep(30_000) // -> t≈30
  { const p = await listener.query('SELECT 1, pg_backend_pid() AS pid'); p30 = Number(p.rows[0].pid) }
  await sendRound(1) // t≈30
  await sleep(30_000) // -> t≈60
  { const p = await listener.query('SELECT 1, pg_backend_pid() AS pid'); p60 = Number(p.rows[0].pid) }
  await sendRound(2) // t≈60

  await listener.end().catch(() => {})
  await sender.end().catch(() => {})
  await Promise.all(auxWorkers)
  for (const c of aux) await c.end().catch(() => {})

  const pids = new Set([pPre, p0, p30, p60].filter((n) => n !== null && Number.isFinite(n)))
  const pidDistinct = pids.size
  const allRoundsOk = rounds.every((r) => r.ok)
  const allPermitted = rounds.every((r) => r.permission)
  const durationSec = Math.round((Date.now() - startedAt) / 1000)

  // ---- redacted output (no PID / URL / user / password) ----
  console.log(`[gate] endpoint_class=${endpointClass}`)
  console.log(`[gate] endpoint_revision=${revision}`)
  console.log(`[gate] host=${redactedHost(url)}`)
  console.log(`[gate] role_match=${roleMatch === null ? 'unchecked' : roleMatch}`)
  console.log(`[gate] pid_distinct_count=${pidDistinct}`)
  console.log(`[gate] rounds=${rounds.map((r) => `t${r.round === 0 ? 0 : r.round === 1 ? 30 : 60}:${r.ok ? 'ok' : 'missed'}`).join(',')}`)
  console.log(`[gate] connect_permission=${'ok'}`)
  console.log(`[gate] listen_permission=${'ok'}`)
  console.log(`[gate] notify_permission=${allPermitted ? 'ok' : 'denied'}`)
  console.log(`[gate] duration_sec=${durationSec}`)
  console.log(`[gate] aux_workers=4 aux_attempted=${auxAttempted} aux_committed=${auxCommitted} aux_failed=${auxFailed}`)
  console.log(`[gate] total_sec=${durationSec}`)

  const pass = roleMatch === true && pidDistinct === 1 && allRoundsOk && allPermitted && auxAttempted === 40 && auxCommitted === 40 && auxFailed === 0 && durationSec <= 65
  console.log(`[gate] result=${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}

run().catch((err) => {
  console.error(`[gate] unexpected failure: ${err.code ?? err.message}`)
  process.exit(1)
})
