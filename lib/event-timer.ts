/**
 * When did the event happen?
 *
 * An operator enters one event as a run of keystrokes — shirt number, action,
 * grade, attributes, zone. That run takes 300–800 ms. Which keystroke's moment is
 * the event's moment?
 *
 * It has to be the **first**. The operator pressed the first key because they saw
 * something happen; every key after that is transcription. Taking the moment the
 * run finishes folds typing duration into the timestamp — and because longer
 * descriptions take longer to type, that error is proportional to how much detail
 * an event carries. A bare throw-in would land systematically earlier than a
 * graded goal attempt with three attributes, so the bias survives averaging and
 * distorts the intervals between events, which is exactly what downstream
 * analysis measures.
 *
 * This class holds nothing but that timing contract. The grammar — which keys are
 * legal, how attributes resolve — is deliberately not its business.
 */

import type { MediaTimeSource, PdtSource } from './protocol.ts'

/** Everything the console can say about "now", captured in one go. */
export interface Stamp {
  mediaTime: number
  mediaTimeSource: MediaTimeSource
  /** Absolute instant, ms. Null on recorded footage. */
  programDateTime: number | null
  pdtSource: PdtSource
  discontinuitySequence: number | null
}

export interface EventTiming extends Stamp {
  /** Media position when the run committed. Diagnostic only. */
  commitMediaTime: number
  /** From a monotonic clock, so it is a duration and never an instant. */
  inputDurationMs: number
  keystrokes: number
}

export interface EventTimerOptions {
  readStamp: () => Stamp
  monotonicNow?: () => number
}

export class EventTimer {
  private readonly readStamp: () => Stamp
  private readonly monotonicNow: () => number

  private open: (Stamp & { startedAtMonotonic: number; keystrokes: number }) | null = null

  constructor(options: EventTimerOptions) {
    this.readStamp = options.readStamp
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
  }

  /**
   * Record a keystroke belonging to the event currently being entered.
   *
   * The first call captures the timestamp. Later calls only count — they must not
   * move it, which is the entire point.
   */
  keystroke(): void {
    if (this.open) {
      this.open.keystrokes++
      return
    }
    this.open = {
      ...this.readStamp(),
      startedAtMonotonic: this.monotonicNow(),
      keystrokes: 1,
    }
  }

  isOpen(): boolean {
    return this.open !== null
  }

  /** The captured stamp, for live display while the operator types. */
  peek(): Stamp | null {
    if (!this.open) return null
    const { startedAtMonotonic: _s, keystrokes: _k, ...stamp } = this.open
    return stamp
  }

  /**
   * Finish the run and return its timing. Null if nothing was open.
   *
   * Call this however the sequence ends — an explicit terminator, the start of the
   * next event, an idle timeout. The ending mechanism does not affect the
   * timestamp, which was fixed at the first keystroke. That is the point.
   */
  commit(): EventTiming | null {
    const open = this.open
    if (!open) return null
    this.open = null
    const { startedAtMonotonic, keystrokes, ...stamp } = open

    return {
      ...stamp,
      commitMediaTime: this.readStamp().mediaTime,
      inputDurationMs: Math.round(this.monotonicNow() - startedAtMonotonic),
      keystrokes,
    }
  }

  discard(): void {
    this.open = null
  }
}
