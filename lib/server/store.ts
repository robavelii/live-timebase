/**
 * The coordinator.
 *
 * The server owns session and transport state, presence, the clock endpoint,
 * sequence numbers and idempotent event storage. It **never** computes, adjusts or
 * overrides an event's timestamp — it cannot form an opinion about one, because it
 * never sees the video.
 *
 * In-memory and process-local, which is right for a demo and wrong for production
 * (see README). Cached on `globalThis` so Next's dev-mode module reloading does
 * not silently fork the state.
 */

import {
  DUEL_WINDOW_MS,
  HEARTBEAT_MS,
  type CollectedEvent,
  type CollectorRole,
  type DuelPair,
  type FingerprintMismatch,
  type PresencePeer,
  type SessionMode,
  type SessionSnapshot,
  type StreamFingerprint,
  type Transport,
  type TransportIntent,
} from '../protocol.ts'
import { compareFingerprints, isFatal } from '../fingerprint.ts'

export type ServerMessage =
  | { type: 'transport'; transport: Transport }
  | { type: 'peers'; peers: PresencePeer[]; lead: CollectorRole | null }
  | { type: 'event'; event: CollectedEvent }
  | { type: 'duel'; duel: DuelPair }
  | { type: 'mode'; mode: SessionMode; src: string }

type Subscriber = (message: ServerMessage) => void

interface Session {
  sessionId: string
  mode: SessionMode
  src: string
  transport: Transport
  /** Keyed by clientEventId. The idempotency store. */
  events: Map<string, CollectedEvent>
  /** Insertion order, for pairing and reporting. */
  order: string[]
  duels: DuelPair[]
  pairedEventIds: Set<string>
  peers: Map<CollectorRole, PresencePeer>
  lead: CollectorRole | null
  subscribers: Set<Subscriber>
  heartbeat: ReturnType<typeof setInterval> | null
  /** Set by the first client to report one. Later joins are compared against it. */
  fingerprint: StreamFingerprint | null
}

interface Store {
  sessions: Map<string, Session>
}

const globalStore = globalThis as unknown as { __liveTimebase?: Store }
const store: Store = (globalStore.__liveTimebase ??= { sessions: new Map() })

function initialTransport(mode: SessionMode): Transport {
  return {
    // Seeded from the wall clock, not from 1. A restarted server that handed out
    // epoch 1 again would publish transport that every surviving client rejects
    // as stale for the rest of the match — the failure would look like "the other
    // operator's player froze" and would be very hard to diagnose.
    epoch: Date.now(),
    sequence: 0,
    mode,
    state: 'paused',
    rate: 1,
    anchor: 0,
    anchorServerTime: Date.now(),
    reason: 'join',
    origin: null,
    leadMediaTime: null,
  }
}

export function getOrCreateSession(
  sessionId: string,
  init?: { mode?: SessionMode; src?: string },
): Session {
  let session = store.sessions.get(sessionId)
  if (!session) {
    const mode = init?.mode ?? 'live'
    session = {
      sessionId,
      mode,
      src: init?.src ?? '',
      transport: initialTransport(mode),
      events: new Map(),
      order: [],
      duels: [],
      pairedEventIds: new Set(),
      peers: new Map(),
      lead: null,
      subscribers: new Set(),
      heartbeat: null,
      fingerprint: null,
    }
    store.sessions.set(sessionId, session)
  }
  return session
}

export function getSession(sessionId: string): Session | undefined {
  return store.sessions.get(sessionId)
}

function broadcast(session: Session, message: ServerMessage): void {
  for (const send of session.subscribers) {
    try {
      send(message)
    } catch {
      // A dead subscriber is removed by its own stream teardown; ignore here.
    }
  }
}

// ─── Transport ─────────────────────────────────────────────────────────────

export interface IntentResult {
  ok: boolean
  transport: Transport
  refusedBecause?: 'not-lead' | 'mode-mismatch'
}

/**
 * Apply an operator's intent.
 *
 * Two rules that matter more than they look:
 *
 *  - **`anchorServerTime` is stamped here, on arrival.** A client-supplied value
 *    would carry that client's clock error straight into the shared state, where
 *    it would be applied by everyone.
 *
 *  - **Authority is enforced here, not in the UI.** Either operator may pause —
 *    both have legitimate reasons to stop — but only the lead may seek, because a
 *    seek drags the other operator off the passage they are working on.
 */
export function applyIntent(sessionId: string, intent: TransportIntent): IntentResult {
  const session = getOrCreateSession(sessionId)

  // An anchor in the wrong units is worse than no anchor: it is accepted, published,
  // and then every client faithfully derives a position from a number that does not
  // mean what the session thinks it means.
  if (intent.mode !== session.mode) {
    return { ok: false, transport: session.transport, refusedBecause: 'mode-mismatch' }
  }

  if (intent.reason === 'seek' && session.lead !== null && session.lead !== intent.role) {
    return { ok: false, transport: session.transport, refusedBecause: 'not-lead' }
  }

  const next: Transport = {
    ...session.transport,
    epoch: session.transport.epoch + 1,
    sequence: 0,
    state: intent.state,
    rate: intent.rate,
    anchor: intent.anchor,
    anchorServerTime: Date.now(),
    reason: intent.reason,
    origin: intent.role,
    leadMediaTime: intent.leadMediaTime ?? null,
  }
  session.transport = next
  broadcast(session, { type: 'transport', transport: next })
  return { ok: true, transport: next }
}

/**
 * Re-publish the transport unchanged.
 *
 * Note what this deliberately does **not** do: it does not re-anchor. Projecting
 * `anchor` forward on every beat would make the server's idea of the position an
 * accumulating quantity, and — worse — one that never reconciles against any real
 * playhead. If the lead's playback stalls on a buffer underrun the projection
 * would keep advancing and hand every client a target ahead of reality, producing
 * repeated repositioning. The anchor pair is already a complete description of the
 * session at any future instant, so the correct heartbeat is a verbatim resend
 * with only the sequence bumped.
 */
export function heartbeat(sessionId: string): Transport {
  const session = getOrCreateSession(sessionId)
  const next: Transport = {
    ...session.transport,
    sequence: session.transport.sequence + 1,
    reason: 'heartbeat',
  }
  session.transport = next
  broadcast(session, { type: 'transport', transport: next })
  return next
}

function ensureHeartbeat(session: Session): void {
  if (session.heartbeat) return
  session.heartbeat = setInterval(() => {
    if (session.subscribers.size === 0) {
      clearInterval(session.heartbeat!)
      session.heartbeat = null
      return
    }
    heartbeat(session.sessionId)
  }, HEARTBEAT_MS)
}

// ─── Presence ──────────────────────────────────────────────────────────────

/**
 * Register a collector.
 *
 * A join is **never** allowed to change the session's mode or reset its transport.
 * That sounds like an obvious rule and it is not: the console detects live-vs-vod
 * from the playlist, which resolves a second or two after mount, so a naive
 * implementation re-joins with a corrected mode and — if a join could reset
 * anything — silently throws away a transport the other operator is already
 * following. It presents as "the other console keeps pausing itself".
 *
 * So the mode is fixed when the session is created, and a later disagreement is
 * reported back for the client to warn about rather than acted on.
 */
export interface JoinResult extends SessionSnapshot {
  modeMismatch?: SessionMode
  /** Differences from the session's stream. Fatal ones mean the join was refused. */
  fingerprintMismatches: FingerprintMismatch[]
  refused: boolean
}

export function join(
  sessionId: string,
  role: CollectorRole,
  init?: { mode?: SessionMode; src?: string; fingerprint?: StreamFingerprint },
): JoinResult {
  const session = getOrCreateSession(sessionId, init)

  // Stream identity, before anything else. A refused join changes nothing: no
  // presence, no lead, no transport. Failing loudly here is vastly preferable to a
  // match collected against two different sources, which is undetectable afterwards.
  let fingerprintMismatches: FingerprintMismatch[] = []
  if (init?.fingerprint) {
    if (session.fingerprint) {
      fingerprintMismatches = compareFingerprints(session.fingerprint, init.fingerprint)
      if (isFatal(fingerprintMismatches)) {
        return {
          ...snapshot(session),
          fingerprintMismatches,
          refused: true,
        }
      }
    } else {
      session.fingerprint = init.fingerprint
    }
  }

  if (init?.src && init.src !== session.src) {
    session.src = init.src
    broadcast(session, { type: 'mode', mode: session.mode, src: session.src })
  }
  const modeMismatch = init?.mode && init.mode !== session.mode ? session.mode : undefined
  session.peers.set(role, { role, lead: false, lastSeenAt: Date.now() })
  session.lead ??= role
  syncLeadFlags(session)
  broadcast(session, { type: 'peers', peers: peerList(session), lead: session.lead })
  return { ...snapshot(session), modeMismatch, fingerprintMismatches, refused: false }
}

export function transferLead(sessionId: string, role: CollectorRole): CollectorRole {
  const session = getOrCreateSession(sessionId)
  session.lead = role
  syncLeadFlags(session)
  broadcast(session, { type: 'peers', peers: peerList(session), lead: session.lead })
  return role
}

function syncLeadFlags(session: Session): void {
  for (const [role, peer] of session.peers) {
    peer.lead = session.lead === role
  }
}

function peerList(session: Session): PresencePeer[] {
  return [...session.peers.values()]
}

// ─── Events ────────────────────────────────────────────────────────────────

export interface SubmitResult {
  status: 'stored' | 'replayed'
  event: CollectedEvent
  duel: DuelPair | null
}

/**
 * Store one event, idempotently.
 *
 * Clients queue locally and resend after a reconnect, so a replay must be
 * acknowledged rather than duplicated. `mediaTime` and `programDateTime` pass
 * through verbatim — the only field added is `serverReceivedAt`, and it exists
 * solely so the console can display wire lag and show that it changes nothing.
 */
export function submitEvent(sessionId: string, event: CollectedEvent): SubmitResult {
  const session = getOrCreateSession(sessionId)
  const existing = session.events.get(event.clientEventId)
  if (existing) return { status: 'replayed', event: existing, duel: null }

  const stored: CollectedEvent = { ...event, serverReceivedAt: Date.now() }
  session.events.set(stored.clientEventId, stored)
  session.order.push(stored.clientEventId)
  broadcast(session, { type: 'event', event: stored })

  const duel = tryPair(session, stored)
  if (duel) broadcast(session, { type: 'duel', duel })
  return { status: 'stored', event: stored, duel }
}

/** The shared coordinate for pairing: PDT on live, media position on vod. */
function pairingKey(event: CollectedEvent): number | null {
  if (event.mode === 'live') {
    return event.pdtSource === 'none' ? null : event.programDateTime
  }
  return event.mediaTime * 1000
}

/**
 * Pair two collectors' observations of one contest.
 *
 * This is the **only** place the two operators' independent captures are ever
 * compared, and it works solely because both are coordinates on a timeline
 * neither machine owns. Note what is not happening: nothing is arbitrated. 260 ms
 * of separation is two people's reaction times, not a conflict to resolve, so both
 * observations are stored raw and the pair records the delta.
 */
function tryPair(session: Session, event: CollectedEvent): DuelPair | null {
  const key = pairingKey(event)
  if (key === null) return null

  const otherRole: CollectorRole = event.role === 'home' ? 'away' : 'home'
  let best: { event: CollectedEvent; delta: number } | null = null

  for (const id of session.order) {
    if (id === event.clientEventId) continue
    if (session.pairedEventIds.has(id)) continue
    const candidate = session.events.get(id)!
    if (candidate.role !== otherRole) continue
    const candidateKey = pairingKey(candidate)
    if (candidateKey === null) continue
    const delta = Math.abs(candidateKey - key)
    if (delta > DUEL_WINDOW_MS) continue
    if (!best || delta < best.delta) best = { event: candidate, delta }
  }

  if (!best) return null
  session.pairedEventIds.add(event.clientEventId)
  session.pairedEventIds.add(best.event.clientEventId)

  const duel: DuelPair = {
    id: `D${session.duels.length + 1}`,
    home: event.role === 'home' ? event : best.event,
    away: event.role === 'away' ? event : best.event,
    deltaMs: Math.round(best.delta),
    coordinate: event.mode === 'live' ? 'pdt' : 'media',
  }
  session.duels.push(duel)
  return duel
}

// ─── Subscription ──────────────────────────────────────────────────────────

export function subscribe(sessionId: string, send: Subscriber): () => void {
  const session = getOrCreateSession(sessionId)
  session.subscribers.add(send)
  ensureHeartbeat(session)
  return () => {
    session.subscribers.delete(send)
  }
}

export function getSnapshot(sessionId: string): SessionSnapshot {
  return snapshot(getOrCreateSession(sessionId))
}

export function snapshot(session: Session): SessionSnapshot {
  return {
    sessionId: session.sessionId,
    mode: session.mode,
    src: session.src,
    transport: session.transport,
    peers: peerList(session),
    eventCount: session.events.size,
    duels: session.duels,
  }
}

export function report(sessionId: string) {
  const session = store.sessions.get(sessionId)
  if (!session) return null
  return {
    ...snapshot(session),
    lead: session.lead,
    events: session.order.map((id) => session.events.get(id)!),
  }
}
