/**
 * The wire contract, shared by the route handlers and the browser.
 *
 * One idea carries the whole design: the server publishes a *description of the
 * world* and every client derives its own playback position from it. Nothing is
 * commanded, so no client ever needs a recovery path.
 *
 * What is new here relative to `timebase-approach/src/protocol.ts` is that the
 * shared coordinate is mode-dependent. On recorded footage it is a position in
 * the asset; on a live stream it is a program-date-time instant, because
 * `currentTime` on a live playlist is a coordinate in *this client's* view of
 * the stream and not in the match.
 */

export type SessionMode = 'vod' | 'live'

export type CollectorRole = 'home' | 'away'

export type TransportReason = 'join' | 'play' | 'pause' | 'seek' | 'rate' | 'heartbeat'

/**
 * The complete shared playback state for a session.
 *
 * Read it as a sentence: "`anchor` was the current position at server time
 * `anchorServerTime`, advancing at `rate`." That is enough for any client, at any
 * later moment, to compute where it should be — which is why a single message is
 * always sufficient to bring a client fully up to date, whatever it missed.
 */
export interface Transport {
  /**
   * Bumped on every change of operator intent. Seeded from the wall clock at
   * session creation so that a server restart cannot hand out an epoch lower
   * than one clients are already holding — otherwise every client would reject
   * transport for the rest of the match.
   */
  epoch: number
  /** Monotonic within an epoch. With epoch, a total order over all messages. */
  sequence: number
  mode: SessionMode
  state: 'playing' | 'paused'
  /** Rate the session intends. Normally 1. */
  rate: number
  /**
   * The shared coordinate.
   *  - `vod`:  position in the asset, in **seconds**.
   *  - `live`: program-date-time, in **milliseconds** since the Unix epoch.
   */
  anchor: number
  /** Server wall clock (ms) at which `anchor` was current. Stamped on arrival. */
  anchorServerTime: number
  reason: TransportReason
  /** Who published the intent. Diagnostics only. */
  origin: CollectorRole | null
  /**
   * The publisher's own `currentTime` when it published, relayed verbatim.
   *
   * Nothing in the timebase path reads this. It exists so the A/B bench can drive a
   * command-mirroring follower from the same wire messages — because what such a
   * system puts on the wire *is* the host's playhead, and being able to show that
   * side by side is the point.
   */
  leadMediaTime: number | null
}

/** Where an event's media timestamp was read from. Stored with every event. */
export type MediaTimeSource =
  /** Presentation timestamp of the frame actually on screen. Preferred. */
  | 'rvfc'
  /** Decoder position: paused player, or no frame-callback support. ~1 frame. */
  | 'currentTime'
  /** Frames had stopped arriving — the window was not being composited. Flag it. */
  | 'currentTime-stale-frame'

/**
 * Where an event's *absolute* timestamp came from. Live events are only
 * comparable across collectors through this value, so its provenance is data,
 * not diagnostics.
 */
export type PdtSource =
  /** Interpolated inside a fragment whose PROGRAM-DATE-TIME we hold. Exact. */
  | 'frag'
  /**
   * Extrapolated past the last fragment we were told about. Good to within the
   * encoder's segment timing; acceptable, but visible to QC.
   */
  | 'extrapolated'
  /** No mapping available. On live this event is **not** cross-comparable. */
  | 'none'

export interface CollectedEvent {
  /** Client-generated UUID. The idempotency key. */
  clientEventId: string
  /** Monotonic per device, so the server can spot gaps. */
  deviceSequence: number
  role: CollectorRole
  mode: SessionMode
  /** The keystroke run, verbatim. Grammar resolution is not this demo's job. */
  sequenceKeys: string
  /** Shirt number parsed from the run, when present. */
  shirt: number | null
  /** Zone 1–9 from the numeric keypad, when present. */
  zone: number | null

  /** Media position at the first keystroke. Local coordinate. */
  mediaTime: number
  mediaTimeSource: MediaTimeSource

  /**
   * Absolute instant of the first keystroke, ms. **On live this is the event's
   * time** — the only coordinate two collectors share. Null on vod.
   */
  programDateTime: number | null
  pdtSource: PdtSource
  /** HLS discontinuity sequence the stamp was taken in. Null on vod. */
  discontinuitySequence: number | null

  /** Media position when the run committed. Diagnostic only. */
  commitMediaTime: number
  /** How long the operator spent entering it. Diagnostic only. */
  inputDurationMs: number
  keystrokes: number

  /** Local wall clock at submit. Used only to show wire lag. */
  clientSubmittedAt: number
  /** Server wall clock on arrival. Never used as the event's time. */
  serverReceivedAt?: number
}

export interface DuelPair {
  id: string
  home: CollectedEvent
  away: CollectedEvent
  /** Separation on the shared coordinate, ms. PDT on live, media on vod. */
  deltaMs: number
  coordinate: 'pdt' | 'media'
}

export interface PresencePeer {
  role: CollectorRole
  lead: boolean
  lastSeenAt: number
}

/** What a client sends when an operator changes playback intent. */
export interface TransportIntent {
  role: CollectorRole
  reason: Exclude<TransportReason, 'join' | 'heartbeat'>
  state: 'playing' | 'paused'
  rate: number
  /** In transport units: seconds on vod, PDT ms on live. */
  anchor: number
  /**
   * The units `anchor` is expressed in.
   *
   * This is not redundant with the session's mode, and the reason is a bug worth
   * remembering: the console detects live-vs-vod from the playlist a second or two
   * after mount, so a client can publish an anchor in seconds while the session is
   * interpreting anchors as absolute instants. The result was a target seven
   * seconds after 1 January 1970, and a follower correctly reporting that it had no
   * fragment covering it. Carrying the units makes the mismatch a 409 instead of an
   * unexplainable stall.
   */
  mode: SessionMode
  /** The publisher's raw playhead. Used only by the comparison bench. */
  leadMediaTime?: number | null
}

/**
 * What a client reports about the stream it is looking at, so the server can refuse a
 * join rather than let two collectors work against different sources.
 *
 * The design's central claim — that a coordinate means the same picture on both
 * machines — holds for *one* stream. That has to be enforced rather than assumed,
 * because the failure is silent: two collectors on two renditions of the same match,
 * or on a feed and its backup, would each be internally consistent and would produce a
 * dataset in which nothing pairs and no single event looks wrong.
 *
 * Hashing is not available to us and would not be the right test anyway. What matters
 * is the *behaviour* being relied on, so the check is: same playlist, same kind of
 * source, same segment cadence, an absolute stamp present, and — the strong one —
 * agreement about what absolute time the stream is currently at.
 */
export interface StreamFingerprint {
  /** The URL as the client resolved it. */
  src: string
  live: boolean
  /** `EXT-X-TARGETDURATION`. Different packagers, different cadence. */
  targetDuration: number
  pdtPresent: boolean
  /** Current discontinuity sequence, or null on a source without one. */
  discontinuitySequence: number | null
  /**
   * Newest absolute instant this client can resolve. Two clients on the same live
   * stream agree on this to within their latency difference; two clients on
   * *different* streams generally do not agree at all.
   */
  latestPdt: number | null
}

export interface FingerprintMismatch {
  field: 'src' | 'live' | 'targetDuration' | 'pdtPresent' | 'latestPdt'
  ours: string
  theirs: string
  /** True when the difference makes the two clients' events incomparable. */
  fatal: boolean
}

/**
 * How far two clients' newest resolvable instants may differ before it stops looking
 * like a latency difference and starts looking like two different streams. Generous:
 * a DVR window is typically 30–120 s, and a client that has just joined may hold much
 * less of it than one that has been running for an hour.
 */
export const FINGERPRINT_PDT_TOLERANCE_MS = 120_000

export interface ImpairmentConfig {
  /** Seeded on the message sequence, so both followers get identical treatment. */
  seed: number
  dropRate: number
  baseLatencyMs: number
  jitterMs: number
  dropNextN: number
  outage: boolean
}

export interface SessionSnapshot {
  sessionId: string
  mode: SessionMode
  src: string
  transport: Transport
  peers: PresencePeer[]
  eventCount: number
  duels: DuelPair[]
}

// ─── Tuning ────────────────────────────────────────────────────────────────
// Every threshold is a decision with a reason. Change them knowingly.

/**
 * Below this, do nothing. One frame at 25 fps is 40 ms, so this means "already
 * showing the right picture"; correcting inside a frame is churn.
 */
export const FRAME_TOLERANCE_S = 0.04

/**
 * Hysteresis on the lock band: once locked, drift must exceed *this* before
 * correction resumes. Without the gap a client parked near the boundary — the
 * common case, since a startup offset inside tolerance is never corrected away —
 * alternates between locked and nudging several times a second.
 */
export const FRAME_RELEASE_TOLERANCE_S = 0.06

/** Below this, trim playback rate. Above it, reposition. */
export const NUDGE_TOLERANCE_S = 0.5

/** Proportional gain for the rate nudge. */
export const NUDGE_GAIN = 0.5

/** Maximum rate deviation. ±10% is imperceptible for short periods. */
export const RATE_CLAMP = 0.1

/**
 * How stale a frame callback may be before its media time is not trusted. Must
 * exceed one frame interval (40 ms at 25 fps) plus callback scheduling jitter,
 * and stay well under the shortest interval that matters analytically.
 */
export const FRAME_STALE_MS = 150

/** Wall-vs-monotonic divergence that counts as the wall clock having stepped. */
export const CLOCK_STEP_THRESHOLD_MS = 500

/** How often clients re-estimate the clock offset. */
export const CLOCK_PING_INTERVAL_MS = 10_000

/** How many offset samples to retain for min-RTT selection. */
export const CLOCK_SAMPLE_WINDOW = 10

/**
 * Heartbeat cadence. Because each heartbeat fully describes the session, this is
 * also the worst case for a client that missed everything to become correct.
 */
export const HEARTBEAT_MS = 5_000

/** How often a follower evaluates its own position. */
export const CORRECTION_INTERVAL_MS = 200

/** How often follower diagnostics are pushed into React state. */
export const DIAGNOSTICS_INTERVAL_MS = 300

/**
 * How far apart two PROGRAM-DATE-TIME stamps may be from their segment
 * durations before we call it an encoder clock correction rather than rounding.
 */
export const PDT_CONTINUITY_TOLERANCE_MS = 500

/** Pairing window for two collectors' observations of one contest. */
export const DUEL_WINDOW_MS = 2_000

/**
 * Sustained error beyond this flags the *session* in QC — not the events, which are
 * still individually correct.
 */
export const QC_DRIFT_MS = 250

/**
 * The tolerance the `syncwave-webrtc` prototype hard-seeks at. Kept here rather than
 * in the bench because the number is the argument: 0.75 s is about 19 frames at
 * 25 fps and consumes 37% of the duel-pairing window above.
 */
export const SYNCWAVE_TOLERANCE = 0.75

/** How often the comparison bench samples both followers. */
export const BENCH_SAMPLE_INTERVAL_MS = 100

/** Default gap between the lead joining and the followers joining, in the bench. */
export const BENCH_JOIN_GAP_MS = 10_000

/** Keep the live target this far inside the DVR window's trailing edge. */
export const DVR_EDGE_MARGIN_S = 1.5
