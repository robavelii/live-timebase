/**
 * End-to-end checks against a running server.
 *
 *   npm run build && npm start      (or npm run dev)
 *   node scripts/smoke.mjs
 *
 * These cover the parts the unit tests cannot: authority enforcement, the exact
 * shape of the heartbeat, idempotent replay, and that pairing happens on the
 * absolute coordinate rather than on either client's playhead.
 */

import { randomUUID } from 'node:crypto'

const BASE = process.env.BASE ?? 'http://localhost:3200'
const SESSION = `smoke-${Date.now()}`

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const post = async (path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

const get = async (path) => {
  const response = await fetch(`${BASE}${path}`)
  return { status: response.status, body: await response.json() }
}

/** Collect server-sent messages for `ms`, then return them. */
function listen(sessionId, ms) {
  return new Promise((resolve, reject) => {
    const messages = []
    const controller = new AbortController()
    fetch(`${BASE}/api/sessions/${sessionId}/stream`, { signal: controller.signal })
      .then(async (response) => {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        setTimeout(() => {
          controller.abort()
          resolve(messages)
        }, ms)
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''
          for (const frame of frames) {
            const line = frame.split('\n').find((l) => l.startsWith('data: '))
            if (line) messages.push(JSON.parse(line.slice(6)))
          }
        }
      })
      .catch((error) => {
        if (error.name !== 'AbortError') reject(error)
      })
  })
}

const PDT_BASE = Date.UTC(2026, 0, 1, 15, 0, 0)

const event = (overrides) => ({
  clientEventId: randomUUID(),
  deviceSequence: 1,
  role: 'home',
  mode: 'live',
  sequenceKeys: '10s',
  shirt: 10,
  zone: 8,
  mediaTime: 12.5,
  mediaTimeSource: 'rvfc',
  programDateTime: PDT_BASE,
  pdtSource: 'frag',
  discontinuitySequence: 0,
  commitMediaTime: 13.1,
  inputDurationMs: 600,
  keystrokes: 4,
  clientSubmittedAt: Date.now(),
  ...overrides,
})

console.log(`\nsession ${SESSION} @ ${BASE}\n`)

console.log('clock')
{
  const { body } = await get('/api/clock')
  check('replies with a wall clock and nothing else', typeof body.ts === 'number' && Object.keys(body).length === 1)
}

console.log('\npresence and authority')
let epochAfterJoin = 0
{
  const home = await post(`/api/sessions/${SESSION}/join`, {
    role: 'home',
    mode: 'live',
    src: '/stream/index.m3u8',
  })
  check('first joiner becomes lead', home.body.peers.some((p) => p.role === 'home' && p.lead))

  const away = await post(`/api/sessions/${SESSION}/join`, { role: 'away' })
  check('second joiner is a follower', away.body.peers.length === 2 && !away.body.peers.find((p) => p.role === 'away').lead)

  epochAfterJoin = away.body.transport.epoch
  check('epoch is seeded from the wall clock, not from 1', epochAfterJoin > 1_700_000_000_000,
    `epoch=${epochAfterJoin}`)

  const refusedSeek = await post(`/api/sessions/${SESSION}/transport`, {
    role: 'away',
    reason: 'seek',
    state: 'playing',
    rate: 1,
    anchor: PDT_BASE,
    mode: 'live',
  })
  check('a non-lead seek is refused server-side, not just hidden in the UI', refusedSeek.status === 403)

  const allowedPause = await post(`/api/sessions/${SESSION}/transport`, {
    role: 'away',
    reason: 'pause',
    state: 'paused',
    rate: 1,
    anchor: PDT_BASE,
    mode: 'live',
  })
  check('either operator may pause', allowedPause.status === 200)

  const leadSeek = await post(`/api/sessions/${SESSION}/transport`, {
    role: 'home',
    reason: 'seek',
    state: 'playing',
    rate: 1,
    anchor: PDT_BASE + 30_000,
    mode: 'live',
  })
  check('the lead may seek', leadSeek.status === 200)
  check('an intent bumps the epoch', leadSeek.body.transport.epoch > epochAfterJoin)
  check('the server stamps the anchor time itself',
    Math.abs(leadSeek.body.transport.anchorServerTime - Date.now()) < 2_000)

  const rubbish = await post(`/api/sessions/${SESSION}/transport`, { role: 'home', reason: 'seek' })
  check('a malformed intent is rejected', rubbish.status === 400)

  // An anchor in the wrong units is accepted by every type check and is completely
  // wrong. `12.5` as a program-date-time is January 1970.
  const wrongUnits = await post(`/api/sessions/${SESSION}/transport`, {
    role: 'home',
    reason: 'seek',
    state: 'playing',
    rate: 1,
    anchor: 12.5,
    mode: 'vod',
  })
  check('an anchor in the wrong units is refused, not published', wrongUnits.status === 409)
  check('the refusal left the session transport untouched',
    wrongUnits.body.transport.anchor === PDT_BASE + 30_000)

  // Later joins must not be able to change the session's mode, or the check above
  // could be defeated simply by re-joining first.
  const modeHijack = await post(`/api/sessions/${SESSION}/join`, { role: 'away', mode: 'vod' })
  check('a join cannot change the session mode', modeHijack.body.mode === 'live')
  check('the disagreement is reported back instead', modeHijack.body.modeMismatch === 'live')
  check('and the transport survived the join',
    modeHijack.body.transport.anchor === PDT_BASE + 30_000)
}

console.log('\nstream identity')
{
  const fingerprint = {
    src: '/stream/index.m3u8',
    live: true,
    targetDuration: 2,
    pdtPresent: true,
    discontinuitySequence: 0,
    latestPdt: Date.now(),
  }
  const identity = `fp-${Date.now()}`

  const first = await post(`/api/sessions/${identity}/join`, {
    role: 'home',
    mode: 'live',
    src: fingerprint.src,
    fingerprint,
  })
  check('the first fingerprint is adopted as the session s', first.status === 200)

  const sameStream = await post(`/api/sessions/${identity}/join`, {
    role: 'away',
    mode: 'live',
    src: fingerprint.src,
    // Eight seconds of latency difference: ordinary, and must not be refused.
    fingerprint: { ...fingerprint, latestPdt: fingerprint.latestPdt - 8_000 },
  })
  check('a second console on the same stream joins', sameStream.status === 200)
  check('with nothing to report', (sameStream.body.fingerprintMismatches ?? []).length === 0)

  const wrongStream = await post(`/api/sessions/${identity}/join`, {
    role: 'away',
    mode: 'live',
    src: '/stream-backup/index.m3u8',
    fingerprint: { ...fingerprint, src: '/stream-backup/index.m3u8' },
  })
  check('a console on a different stream is refused', wrongStream.status === 409)
  check('and told why', wrongStream.body.fingerprintMismatches?.[0]?.field === 'src')
  check('the refusal is explicit, not a silent no-op', wrongStream.body.refused === true)

  const staleStream = await post(`/api/sessions/${identity}/join`, {
    role: 'away',
    mode: 'live',
    src: fingerprint.src,
    // Ten minutes adrift is not latency — a stalled playlist, or a different stream.
    fingerprint: { ...fingerprint, latestPdt: fingerprint.latestPdt - 600_000 },
  })
  check('a console whose stream clock disagrees is refused', staleStream.status === 409)

  const otherRendition = await post(`/api/sessions/${identity}/join`, {
    role: 'away',
    mode: 'live',
    src: fingerprint.src,
    fingerprint: { ...fingerprint, targetDuration: 6 },
  })
  check('a different rendition joins with a warning, not a refusal', otherRendition.status === 200)
  check('and the warning is non-fatal',
    otherRendition.body.fingerprintMismatches?.[0]?.fatal === false)

  const report = await get(`/api/sessions/${identity}/report`)
  check('a refused join left no trace in presence', report.body.peers.length === 2)
}

console.log('\ntransport stream')
{
  const messages = await listen(SESSION, 6_500)
  const snapshot = messages.find((m) => m.type === 'snapshot')
  check('a new subscriber is handed the whole state immediately', Boolean(snapshot?.snapshot?.transport))

  const beats = messages.filter((m) => m.type === 'transport' && m.transport.reason === 'heartbeat')
  check('a heartbeat arrives within one interval', beats.length >= 1, `${beats.length} beats`)

  if (beats.length && snapshot) {
    const before = snapshot.snapshot.transport
    const beat = beats[0]
    check('the heartbeat bumps the sequence', beat.transport.sequence > before.sequence)
    check('the heartbeat does NOT re-anchor — the anchor pair is already complete',
      beat.transport.anchor === before.anchor &&
        beat.transport.anchorServerTime === before.anchorServerTime,
      `anchor ${before.anchor}→${beat.transport.anchor}`)
  }
}

console.log('\ningest')
{
  const homeEvent = event({ role: 'home', programDateTime: PDT_BASE, mediaTime: 12.5 })
  // The away collector joined earlier, so the same moment sits 137.5 s deeper in
  // its buffer. Its reaction is 260 ms later than home's.
  const awayEvent = event({
    role: 'away',
    programDateTime: PDT_BASE + 260,
    mediaTime: 150.0,
    sequenceKeys: '4e',
    shirt: 4,
  })

  const first = await post(`/api/sessions/${SESSION}/events`, { events: [homeEvent] })
  check('stores a new event', first.body.results[0].status === 'stored')

  const replay = await post(`/api/sessions/${SESSION}/events`, { events: [homeEvent] })
  check('a resend is acknowledged, not duplicated', replay.body.results[0].status === 'replayed')

  const second = await post(`/api/sessions/${SESSION}/events`, { events: [awayEvent] })
  const duel = second.body.results[0].duel
  check('two collectors\' observations pair', Boolean(duel))
  check('pairing is on the absolute coordinate, not either playhead', duel?.coordinate === 'pdt')
  check('the separation is the reaction-time difference, not the buffer difference',
    duel?.deltaMs === 260, `deltaMs=${duel?.deltaMs}`)

  const unpairable = await post(`/api/sessions/${SESSION}/events`, {
    events: [
      event({ role: 'home', pdtSource: 'none', programDateTime: null, mediaTime: 400 }),
      event({ role: 'away', pdtSource: 'none', programDateTime: null, mediaTime: 400 }),
    ],
  })
  check('live events with no absolute stamp are never paired on media position',
    unpairable.body.results.every((r) => r.duel === null))

  const oversized = await fetch(`${BASE}/api/sessions/${SESSION}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: Array.from({ length: 501 }, () => event({})) }),
  })
  check('the batch limit is enforced', oversized.status === 413)
}

console.log('\nreport')
{
  const { body } = await get(`/api/sessions/${SESSION}/report`)
  check('events pass through verbatim', body.events.every((e) => typeof e.mediaTime === 'number'))
  check('the server adds only an arrival time', body.events.every((e) => typeof e.serverReceivedAt === 'number'))
  check('one pair recorded', body.duels.length === 1)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
