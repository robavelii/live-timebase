/**
 * Measurement.
 *
 * Ported from `demo/sync-bench`, with one substantive change: on live, the error being
 * accumulated is the distance between the follower's **presented program-date-time**
 * and the lead's, not the distance between their playheads. Comparing playheads is
 * precisely the mistake under examination — it would score a command-mirroring
 * follower as perfect while it showed a picture ten seconds out.
 */

import { DUEL_WINDOW_MS, FRAME_TOLERANCE_S, QC_DRIFT_MS } from './protocol.ts'

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = clamp(Math.ceil((p / 100) * sorted.length) - 1, 0, sorted.length - 1)
  return sorted[index]!
}

export interface Metrics {
  samples: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  /** Signed mean. A non-zero value is a systematic bias, not noise. */
  meanSignedMs: number
  /** Share of samples inside one frame at 25 fps. */
  frameAccuratePct: number
  /** Share beyond the QC session-flag threshold. */
  beyondQcPct: number
  /** Disruptive `currentTime =` corrections. */
  hardSeeks: number
  /** Invisible `playbackRate` corrections. */
  nudges: number
  /** Hard seeks that landed while the operator was mid-sequence. */
  midInputSeeks: number
  /** Share of the ±2 s duel-pairing window consumed at p95. */
  duelWindowConsumedPct: number
  delivered: number
  dropped: number
}

export const EMPTY_METRICS: Metrics = {
  samples: 0,
  p50Ms: 0,
  p95Ms: 0,
  p99Ms: 0,
  maxMs: 0,
  meanSignedMs: 0,
  frameAccuratePct: 0,
  beyondQcPct: 0,
  hardSeeks: 0,
  nudges: 0,
  midInputSeeks: 0,
  duelWindowConsumedPct: 0,
  delivered: 0,
  dropped: 0,
}

export interface SamplePoint {
  at: number
  errorMs: number
  correction: string
}

const MAX_SAMPLES = 6_000
const MAX_HISTORY = 600

export class MetricsAccumulator {
  private absolute: number[] = []
  private signed: number[] = []
  private frameAccurate = 0
  private beyondQc = 0
  private nudges = 0
  private hardSeeks = 0
  private midInputSeeks = 0
  private history: SamplePoint[] = []
  private delivered = 0
  private dropped = 0

  record(errorMs: number, correction: string, at: number): void {
    const magnitude = Math.abs(errorMs)
    this.absolute.push(magnitude)
    this.signed.push(errorMs)
    if (this.absolute.length > MAX_SAMPLES) {
      this.absolute.shift()
      this.signed.shift()
    }
    if (magnitude < FRAME_TOLERANCE_S * 1000) this.frameAccurate++
    if (magnitude > QC_DRIFT_MS) this.beyondQc++
    if (correction === 'nudge') this.nudges++
    if (correction === 'seek') this.hardSeeks++

    this.history.push({ at, errorMs, correction })
    if (this.history.length > MAX_HISTORY) this.history.shift()
  }

  recordMidInputSeek(): void {
    this.midInputSeeks++
  }

  recordChannel(delivered: number, dropped: number): void {
    this.delivered = delivered
    this.dropped = dropped
  }

  getHistory(): readonly SamplePoint[] {
    return this.history
  }

  reset(): void {
    this.absolute = []
    this.signed = []
    this.frameAccurate = 0
    this.beyondQc = 0
    this.nudges = 0
    this.hardSeeks = 0
    this.midInputSeeks = 0
    this.history = []
  }

  snapshot(): Metrics {
    const sorted = [...this.absolute].sort((a, b) => a - b)
    const total = sorted.length || 1
    const p95 = percentile(sorted, 95)
    return {
      samples: sorted.length,
      p50Ms: percentile(sorted, 50),
      p95Ms: p95,
      p99Ms: percentile(sorted, 99),
      maxMs: sorted.at(-1) ?? 0,
      meanSignedMs: this.signed.reduce((a, b) => a + b, 0) / (this.signed.length || 1),
      frameAccuratePct: (this.frameAccurate / total) * 100,
      beyondQcPct: (this.beyondQc / total) * 100,
      hardSeeks: this.hardSeeks,
      nudges: this.nudges,
      midInputSeeks: this.midInputSeeks,
      duelWindowConsumedPct: (p95 / DUEL_WINDOW_MS) * 100,
      delivered: this.delivered,
      dropped: this.dropped,
    }
  }
}
