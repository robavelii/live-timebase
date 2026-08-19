/**
 * The derivation itself. Pure functions — no DOM, no React, no hls.js — so they
 * can be tested exhaustively and reasoned about in isolation.
 */

import {
  CLOCK_STEP_THRESHOLD_MS,
  FRAME_RELEASE_TOLERANCE_S,
  FRAME_TOLERANCE_S,
  NUDGE_GAIN,
  NUDGE_TOLERANCE_S,
  RATE_CLAMP,
  type Transport,
} from './protocol.ts'

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v))

/**
 * Where should this client be, right now — expressed in the transport's own
 * units (media seconds on vod, program-date-time ms on live)?
 *
 * The whole approach reduces to this function, and it is stateless. A client that
 * has been asleep, one that just opened, and one that has been running for ninety
 * minutes all compute the same answer from the same message. Nothing accumulates,
 * so nothing can be quietly wrong.
 */
export function calculateTarget(transport: Transport, sessionNowMs: number): number {
  if (transport.state === 'paused') return transport.anchor
  const elapsedMs = (sessionNowMs - transport.anchorServerTime) * transport.rate
  return transport.mode === 'live'
    ? transport.anchor + elapsedMs
    : transport.anchor + elapsedMs / 1000
}

export const CorrectionKind = {
  /** Inside one frame. Leave the player alone. */
  NONE: 'none',
  /** Small error: trim playback rate until it closes. No visible jump. */
  NUDGE: 'nudge',
  /** Large error: reposition. Visible, so reserved for genuine divergence. */
  SEEK: 'seek',
  /** The clock estimate is not trustworthy; do not act on the target. */
  HOLD: 'hold',
  /**
   * The target is known but currently unreachable — no program-date-time
   * mapping yet, or the instant is outside the DVR window this client holds.
   * Distinct from HOLD because the remedy is different: HOLD waits for the
   * clock, WAIT waits for segments.
   */
  WAIT: 'wait',
} as const

export type CorrectionKind = (typeof CorrectionKind)[keyof typeof CorrectionKind]

export interface Correction {
  kind: CorrectionKind
  /** currentTime − target, in seconds of media. Positive means ahead. */
  driftSeconds: number
  /** The derived local position, in media seconds. Null when unresolvable. */
  targetSeconds: number | null
  /** Set for NUDGE. */
  appliedRate?: number
  /** Set for WAIT: why the target could not be reached. */
  waitReason?:
    | 'no-pdt-mapping'
    | 'outside-dvr'
    | 'no-transport'
    | 'no-media'
    | 'seeking'
    | 'unlocked'
    | 'hidden'
}

export interface CorrectionOptions {
  frameToleranceS?: number
  releaseToleranceS?: number
  nudgeToleranceS?: number
  /**
   * The previous decision for this client. Supplying it enables hysteresis on
   * the lock band; omitting it makes the function memoryless.
   */
  previousKind?: CorrectionKind
  /** False when the clock offset is not currently trustworthy. */
  clockTrusted?: boolean
}

/**
 * Decide what to do about the gap between where we are and where we should be.
 *
 * Three acting tiers rather than two, because the cost of correcting is not
 * linear: doing nothing is free, trimming the rate is invisible, and
 * repositioning costs an operator their place mid-keystroke. Each tier is used
 * only when the cheaper one cannot close the gap.
 */
export function decideCorrection(
  currentTimeS: number,
  targetS: number,
  transportRate: number,
  options: CorrectionOptions = {},
): Correction {
  const frameTol = options.frameToleranceS ?? FRAME_TOLERANCE_S
  const nudgeTol = options.nudgeToleranceS ?? NUDGE_TOLERANCE_S
  const driftSeconds = currentTimeS - targetS
  const base = { driftSeconds, targetSeconds: targetS }

  if (options.clockTrusted === false) {
    return { ...base, kind: CorrectionKind.HOLD }
  }

  // Asymmetric band: harder to leave lock than to enter it, so a client parked
  // near the boundary stays put instead of chattering.
  const lockTol =
    options.previousKind === CorrectionKind.NONE
      ? (options.releaseToleranceS ?? FRAME_RELEASE_TOLERANCE_S)
      : frameTol

  if (Math.abs(driftSeconds) < lockTol) {
    return { ...base, kind: CorrectionKind.NONE }
  }

  if (Math.abs(driftSeconds) < nudgeTol) {
    // Ahead of target → slow down; behind → speed up.
    const appliedRate = clamp(
      transportRate * (1 - NUDGE_GAIN * driftSeconds),
      transportRate * (1 - RATE_CLAMP),
      transportRate * (1 + RATE_CLAMP),
    )
    return { ...base, kind: CorrectionKind.NUDGE, appliedRate }
  }

  return { ...base, kind: CorrectionKind.SEEK }
}

/**
 * Should this transport replace the one we are holding?
 *
 * Messages can arrive out of order, and on a reconnect a client may be handed a
 * snapshot older than one it already applied. (epoch, sequence) is a total
 * order, so a stale message is discarded rather than briefly applied — without
 * this, reordering shows up as a visible stutter.
 */
export function shouldAcceptTransport(
  incoming: Transport,
  lastAccepted: Transport | null,
): boolean {
  if (!lastAccepted) return true
  if (incoming.epoch !== lastAccepted.epoch) return incoming.epoch > lastAccepted.epoch
  return incoming.sequence > lastAccepted.sequence
}

// ─── Clock offset estimation ───────────────────────────────────────────────

export interface ClockSample {
  /** serverTime − localTime, in ms. */
  offset: number
  /** Round-trip time of the exchange that produced this sample, in ms. */
  rtt: number
}

/**
 * Cristian's algorithm.
 *
 * Assumes the outbound and return path delays are equal. Where they are not, the
 * offset is wrong by half the asymmetry — the dominant and irreducible error in
 * the estimate. Note that a *constant* local skew cancels exactly, however large:
 * that is what makes a collector's wrong laptop clock a non-issue.
 */
export function cristianSample(t0: number, serverTs: number, t1: number): ClockSample {
  return { offset: serverTs - (t0 + t1) / 2, rtt: t1 - t0 }
}

/**
 * Pick the offset from the lowest-RTT sample. A fast exchange had little room to
 * be asymmetric, so its offset is the most trustworthy; averaging would let
 * congested samples pull the estimate around.
 */
export function bestOffset(samples: readonly ClockSample[]): number {
  if (samples.length === 0) return 0
  return samples.reduce((best, s) => (s.rtt < best.rtt ? s : best)).offset
}

/**
 * Did the wall clock step, rather than simply drift?
 *
 * The monotonic clock cannot jump, so a divergence between how much each clock
 * advanced is the wall clock moving — NTP, a manual change, or a resume from
 * sleep. It matters because a stepped wall clock produces a *confidently wrong*
 * target; detecting it lets the follower hold instead.
 */
export function detectClockStep(
  wallDeltaMs: number,
  monotonicDeltaMs: number,
  thresholdMs: number = CLOCK_STEP_THRESHOLD_MS,
): boolean {
  return Math.abs(wallDeltaMs - monotonicDeltaMs) > thresholdMs
}
