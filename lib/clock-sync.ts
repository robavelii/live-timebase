/**
 * Shared-time estimation.
 *
 * Deriving a position needs to know what time it is *for the session*, not for
 * this machine. That is all this class provides, and two properties matter:
 *
 *  1. It reports session time by interpolating from a **monotonic** clock, and
 *     consults the wall clock only to exchange timestamps with the server and to
 *     notice that the wall clock has moved. A machine whose clock is an hour
 *     wrong still reports correct session time.
 *
 *  2. When it cannot vouch for its estimate it says so, via `isTrusted()`, and
 *     callers hold position instead of moving to a target they know is derived
 *     from a bad clock. A slightly stale position is a far smaller problem than a
 *     confidently wrong one.
 */

import { CLOCK_SAMPLE_WINDOW, CLOCK_STEP_THRESHOLD_MS } from './protocol.ts'
import {
  bestOffset,
  type ClockSample,
  cristianSample,
  detectClockStep,
} from './timebase.ts'

export interface ClockSyncOptions {
  wallNow?: () => number
  monotonicNow?: () => number
  sampleWindow?: number
  stepThresholdMs?: number
}

/** One in-flight exchange. Pass it back to `receive()` when the reply arrives. */
export interface PendingPing {
  t0Wall: number
  t0Monotonic: number
}

export class ClockSync {
  private readonly wallNow: () => number
  private readonly monotonicNow: () => number
  private readonly sampleWindow: number
  private readonly stepThresholdMs: number

  private samples: ClockSample[] = []
  /** Session time known to be current at a monotonic instant. */
  private anchor: { monotonic: number; serverTime: number } | null = null
  private lastObservation: { wall: number; monotonic: number } | null = null
  private trusted = false
  private stepCount = 0

  constructor(options: ClockSyncOptions = {}) {
    this.wallNow = options.wallNow ?? (() => Date.now())
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.sampleWindow = options.sampleWindow ?? CLOCK_SAMPLE_WINDOW
    this.stepThresholdMs = options.stepThresholdMs ?? CLOCK_STEP_THRESHOLD_MS
  }

  /** Call when sending a ping. Send `t0Wall`; keep the result. */
  send(): PendingPing {
    return { t0Wall: this.wallNow(), t0Monotonic: this.monotonicNow() }
  }

  /** Call with the server's wall clock at the moment it handled the ping. */
  receive(pending: PendingPing, serverTs: number): ClockSample {
    const t1Wall = this.wallNow()
    const t1Monotonic = this.monotonicNow()

    // Has the wall clock moved independently of real elapsed time? If so every
    // earlier sample was measured against a different clock and is now
    // meaningless — keeping them would drag the estimate toward a stale value
    // for as long as one of them happened to have the lowest RTT.
    if (this.lastObservation) {
      const stepped = detectClockStep(
        t1Wall - this.lastObservation.wall,
        t1Monotonic - this.lastObservation.monotonic,
        this.stepThresholdMs,
      )
      if (stepped) {
        this.samples = []
        this.anchor = null
        this.trusted = false
        this.stepCount++
      }
    }
    this.lastObservation = { wall: t1Wall, monotonic: t1Monotonic }

    const sample = cristianSample(pending.t0Wall, serverTs, t1Wall)
    this.samples = [...this.samples, sample].slice(-this.sampleWindow)

    // Re-anchor: session time at this monotonic instant. From here on, elapsed
    // time comes from the monotonic clock, which cannot step.
    this.anchor = {
      monotonic: t1Monotonic,
      serverTime: t1Wall + bestOffset(this.samples),
    }
    this.trusted = true
    return sample
  }

  /** Session time in ms, interpolated from the monotonic clock. */
  now(): number {
    if (!this.anchor) return this.wallNow()
    return this.anchor.serverTime + (this.monotonicNow() - this.anchor.monotonic)
  }

  /**
   * False before the first successful exchange, and after a detected clock step
   * until the next one. **Do not skip checking this**: the whole point of holding
   * a stale position is lost if callers act on an untrusted estimate.
   */
  isTrusted(): boolean {
    return this.trusted
  }

  offsetMs(): number {
    return bestOffset(this.samples)
  }

  minRttMs(): number {
    if (this.samples.length === 0) return 0
    return Math.min(...this.samples.map((s) => s.rtt))
  }

  /**
   * Accuracy bound: Cristian's estimate is wrong by at most half the path
   * asymmetry, which cannot exceed half the round trip. Worth surfacing — it
   * tells an operator how much of the sync budget the network is eating.
   */
  worstCaseErrorMs(): number {
    return this.minRttMs() / 2
  }

  stepsDetected(): number {
    return this.stepCount
  }

  sampleCount(): number {
    return this.samples.length
  }
}
