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
const ROUND_TARGETS_MS = [0, 30_000, 60_000]
const AUX_TARGETS_MS = [0, 6_000, 12_000, 18_000, 24_000, 30_000, 36_000, 42_000, 48_000, 54_000]
const MAX_TOTAL_MS = 65_000
const OPERATION_TIMEOUT_MS = 5_000

const url = process.env.RT_SESSION_DATABASE_URL
const declaredRole = process.env.RT_SESSION_ROLE
const endpointClass = process.env.RT_SESSION_ENDPOINT_CLASS ?? 'session_pool'
const revision = process.env.RT_SESSION_REVISION ?? 'unknown'

function accepts(result) {
  const roundsOk = Array.isArray(result.rounds)
    && result.rounds.length === 3
    && result.rounds.every((round, index) => (
      round.targetMs === ROUND_TARGETS_MS[index]
      && round.queryOk === true
      && round.received === true
      && Number.isFinite(round.sentOffsetMs)
      && round.sentOffsetMs >= round.targetMs
      && round.sentOffsetMs <= round.targetMs + 5_000
      && Number.isFinite(round.receivedWithinMs)
      && round.receivedWithinMs >= 0
      && round.receivedWithinMs <= 5_000
    ))
  return result.failureStage === null
    && result.listenerConnected === true
    && result.listenAck === true
    && result.senderConnected === true
    && result.roleMatch === true
    && result.pidSamples === 4
    && result.pidDistinct === 1
    && roundsOk
    && result.auxConnected === 4
    && result.auxWorkersSettled === 4
    && result.auxAttempted === 40
    && result.auxCommitted === 40
    && result.auxFailed === 0
    && result.auxCompleted === true
    && Number.isFinite(result.auxFirstOffsetMs)
    && result.auxFirstOffsetMs >= 0
    && result.auxFirstOffsetMs <= 5_000
    && Number.isFinite(result.auxLastOffsetMs)
    && result.auxLastOffsetMs >= 54_000
    && result.auxLastOffsetMs <= MAX_TOTAL_MS
    && (result.endpointClass === 'direct' || result.endpointClass === 'session_pool')
    && typeof result.revision === 'string'
    && result.revision.length > 0
    && result.revision !== 'unknown'
    && result.revision !== 'placeholder'
    && Number.isFinite(result.durationMs)
    && result.durationMs >= 0
    && result.durationMs <= MAX_TOTAL_MS
}

if (process.argv.includes('--self-test')) {
  const valid = {
    failureStage: null,
    listenerConnected: true,
    listenAck: true,
    senderConnected: true,
    roleMatch: true,
    pidSamples: 4,
    pidDistinct: 1,
    rounds: ROUND_TARGETS_MS.map((targetMs) => ({ targetMs, sentOffsetMs: targetMs + 50, queryOk: true, received: true, receivedWithinMs: 25 })),
    auxConnected: 4,
    auxWorkersSettled: 4,
    auxAttempted: 40,
    auxCommitted: 40,
    auxFailed: 0,
    auxCompleted: true,
    auxFirstOffsetMs: 100,
    auxLastOffsetMs: 54_100,
    endpointClass: 'direct',
    revision: 'abc123',
    durationMs: 60_500,
  }
  const cases = [
    ['pid changed', { ...valid, pidDistinct: 2 }],
    ['pid sample missing', { ...valid, pidSamples: 3 }],
    ['listen missing', { ...valid, listenAck: false }],
    ['sender missing', { ...valid, senderConnected: false }],
    ['round missing', { ...valid, rounds: valid.rounds.slice(0, 2) }],
    ['sender query error', { ...valid, rounds: valid.rounds.map((round, index) => index === 1 ? { ...round, queryOk: false } : round) }],
    ['round late', { ...valid, rounds: valid.rounds.map((round, index) => index === 2 ? { ...round, receivedWithinMs: 5_001 } : round) }],
    ['39 transactions', { ...valid, auxCommitted: 39 }],
    ['aux rejected', { ...valid, auxFailed: 1 }],
    ['aux unfinished', { ...valid, auxWorkersSettled: 3, auxCompleted: false }],
    ['aux ended early', { ...valid, auxLastOffsetMs: 30_000 }],
    ['role mismatch', { ...valid, roleMatch: false }],
    ['class', { ...valid, endpointClass: 'unknown' }],
    ['revision', { ...valid, revision: 'unknown' }],
    ['duration', { ...valid, durationMs: 65_001 }],
  ]
  if (!accepts(valid) || cases.some(([, fixture]) => accepts(fixture))) process.exit(1)
  if (AUX_TARGETS_MS.join(',') !== '0,6000,12000,18000,24000,30000,36000,42000,48000,54000') process.exit(1)
  console.log(`[gate] self-test=PASS (valid accepted; ${cases.length} negative fixtures rejected; absolute timeline verified)`)
  process.exit(0)
}

if (!url || !declaredRole) {
  console.error('[gate] RT_SESSION_DATABASE_URL and RT_SESSION_ROLE are required')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(deadlineMs) {
  const remaining = deadlineMs - Date.now()
  if (remaining > 0) await sleep(remaining)
}

function createClient(options = {}) {
  return new Client({
    connectionString: url,
    connectionTimeoutMillis: OPERATION_TIMEOUT_MS,
    query_timeout: OPERATION_TIMEOUT_MS,
    statement_timeout: OPERATION_TIMEOUT_MS,
    ...options,
  })
}

async function run() {
  const startedAt = Date.now()
  const clients = []
  const received = new Set()
  const pids = []
  const rounds = []
  const aux = []
  let listener = null
  let sender = null
  let listenerConnected = false
  let listenAck = false
  let senderConnected = false
  let roleMatch = false
  let connectPermission = 'error'
  let listenPermission = 'error'
  let failureStage = null
  let auxConnected = 0
  let auxWorkersSettled = 0
  let auxAttempted = 0
  let auxCommitted = 0
  let auxFailed = 0
  let auxFirstOffsetMs = Number.POSITIVE_INFINITY
  let auxLastOffsetMs = Number.NEGATIVE_INFINITY

  const failStage = (stage, error) => {
    failureStage = stage
    const wrapped = new Error(stage)
    wrapped.cause = error
    throw wrapped
  }

  try {
    listener = createClient({ application_name: 'monexus-notification-realtime-listener' })
    clients.push(listener)
    try {
      await listener.connect()
      listenerConnected = true
      connectPermission = 'ok'
    } catch (error) {
      connectPermission = error?.code === '42501' ? 'denied' : 'error'
      failStage('listener_connect', error)
    }

    let currentUser
    try {
      const current = await listener.query('SELECT current_user AS u, pg_backend_pid() AS pid')
      currentUser = current.rows[0].u
      pids.push(Number(current.rows[0].pid))
    } catch (error) {
      failStage('listener_identity_query', error)
    }
    roleMatch = currentUser === declaredRole

    try {
      await listener.query(`LISTEN ${CHANNEL}`)
      const p0 = await listener.query('SELECT pg_backend_pid() AS pid')
      pids.push(Number(p0.rows[0].pid))
      listenAck = true
      listenPermission = 'ok'
    } catch (error) {
      listenPermission = error?.code === '42501' ? 'denied' : 'error'
      failStage('listen', error)
    }

    listener.on('notification', (message) => {
      if (typeof message.payload === 'string') received.add(message.payload)
    })

    for (let i = 0; i < 4; i += 1) {
      const c = createClient()
      clients.push(c)
      try {
        await c.connect()
      } catch (error) {
        failStage('aux_connect', error)
      }
      aux.push(c)
      auxConnected += 1
    }

    sender = createClient()
    clients.push(sender)
    try {
      await sender.connect()
      senderConnected = true
    } catch (error) {
      failStage('sender_connect', error)
    }

    const auxWorkers = aux.map((client) => (async () => {
      for (const targetMs of AUX_TARGETS_MS) {
        await waitUntil(startedAt + targetMs)
        const offsetMs = Date.now() - startedAt
        auxFirstOffsetMs = Math.min(auxFirstOffsetMs, offsetMs)
        auxLastOffsetMs = Math.max(auxLastOffsetMs, offsetMs)
        auxAttempted += 1
        try {
          await client.query('BEGIN')
          await client.query('SELECT 1')
          await client.query('COMMIT')
          auxCommitted += 1
        } catch {
          auxFailed += 1
          try {
            await client.query('ROLLBACK')
          } catch { /* cleanup only; original failure remains counted */ }
        }
      }
    })())

    const baseId = Date.now() * 1_000 + Math.floor(Math.random() * 1_000)
    const runSenderTimeline = async () => {
      for (let roundIndex = 0; roundIndex < ROUND_TARGETS_MS.length; roundIndex += 1) {
        const targetMs = ROUND_TARGETS_MS[roundIndex]
        await waitUntil(startedAt + targetMs)
        if (roundIndex > 0) {
          try {
            const probe = await listener.query('SELECT 1, pg_backend_pid() AS pid')
            pids.push(Number(probe.rows[0].pid))
          } catch (error) {
            failStage(`listener_probe_t${targetMs / 1_000}`, error)
          }
        }
        const payload = JSON.stringify({
          v: 1,
          notificationId: baseId + roundIndex,
          recipientUserId: baseId + roundIndex,
        })
        const round = {
          targetMs,
          sentOffsetMs: Date.now() - startedAt,
          queryOk: false,
          received: false,
          receivedWithinMs: null,
          permission: 'error',
        }
        try {
          await sender.query('SELECT pg_notify($1, $2)', [CHANNEL, payload])
          round.queryOk = true
          round.permission = 'ok'
          const queryCompletedAt = Date.now()
          const receiveDeadline = queryCompletedAt + 5_000
          while (Date.now() <= receiveDeadline) {
            if (received.has(payload)) {
              round.received = true
              round.receivedWithinMs = Date.now() - queryCompletedAt
              break
            }
            await sleep(Math.min(50, Math.max(1, receiveDeadline - Date.now())))
          }
        } catch (error) {
          round.permission = error?.code === '42501' ? 'denied' : 'error'
        }
        rounds.push(round)
      }
    }

    const [senderTimeline, auxResults] = await Promise.allSettled([
      runSenderTimeline(),
      Promise.allSettled(auxWorkers),
    ])
    if (senderTimeline.status === 'rejected') {
      failureStage ??= 'sender_timeline'
    }
    if (auxResults.status === 'fulfilled') {
      auxWorkersSettled = auxResults.value.length
      if (auxResults.value.some((result) => result.status === 'rejected')) failureStage ??= 'aux_worker'
    } else {
      failureStage ??= 'aux_workers'
    }
  } catch (error) {
    failureStage ??= error?.message ?? 'unexpected'
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()))
  }

  const durationMs = Date.now() - startedAt
  const finitePids = pids.filter(Number.isFinite)
  const pidSamples = finitePids.length
  const pidDistinct = new Set(finitePids).size
  const auxCompleted = auxWorkersSettled === 4 && auxAttempted === 40
  const result = {
    failureStage,
    listenerConnected,
    listenAck,
    senderConnected,
    roleMatch,
    pidSamples,
    pidDistinct,
    rounds,
    auxConnected,
    auxWorkersSettled,
    auxAttempted,
    auxCommitted,
    auxFailed,
    auxCompleted,
    auxFirstOffsetMs,
    auxLastOffsetMs,
    endpointClass,
    revision,
    durationMs,
  }
  const notifyPermission = rounds.length === 3 && rounds.every((round) => round.permission === 'ok')
    ? 'ok'
    : rounds.some((round) => round.permission === 'denied') ? 'denied' : 'error'

  // ---- redacted output (no PID / URL / user / password) ----
  console.log(`[gate] endpoint_class=${endpointClass}`)
  console.log(`[gate] endpoint_revision=${revision}`)
  console.log(`[gate] role_match=${roleMatch}`)
  console.log(`[gate] pid_samples=${pidSamples}/4`)
  console.log(`[gate] pid_distinct_count=${pidDistinct}`)
  console.log(`[gate] rounds=${rounds.map((round) => `t${round.targetMs / 1_000}:${round.queryOk ? round.received ? 'ok' : 'missed' : 'query_error'}`).join(',') || 'none'}`)
  console.log(`[gate] connect_permission=${connectPermission}`)
  console.log(`[gate] listen_permission=${listenPermission}`)
  console.log(`[gate] notify_permission=${notifyPermission}`)
  console.log(`[gate] aux_workers=${auxWorkersSettled}/4 aux_attempted=${auxAttempted} aux_committed=${auxCommitted} aux_failed=${auxFailed}`)
  console.log(`[gate] aux_window_ms=${Number.isFinite(auxFirstOffsetMs) ? auxFirstOffsetMs : 'none'}..${Number.isFinite(auxLastOffsetMs) ? auxLastOffsetMs : 'none'}`)
  console.log(`[gate] duration_ms=${durationMs}`)
  console.log(`[gate] completed=${auxCompleted && rounds.length === 3}`)
  if (failureStage !== null) console.log(`[gate] failure_stage=${failureStage}`)

  const pass = accepts(result)
  console.log(`[gate] result=${pass ? 'PASS' : 'FAIL'}`)
  return pass
}

run()
  .then((pass) => { process.exitCode = pass ? 0 : 1 })
  .catch(() => {
    console.error('[gate] unexpected failure')
    process.exitCode = 1
  })
