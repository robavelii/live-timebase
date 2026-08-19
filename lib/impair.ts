/**
 * Controlled network impairment, so the comparison is an experiment rather than an
 * anecdote.
 *
 * Ported from `demo/sync-bench`. The important property is that the impairment is
 * **seeded on the message's sequence number**, so both followers receive exactly the
 * same drops and exactly the same delays. Without that, a run where one follower
 * happened to lose a different message proves nothing, and the temptation to re-run
 * until the numbers look right is very hard to resist.
 */

import type { ImpairmentConfig } from './protocol.ts'

/** mulberry32 — small, fast, and deterministic from a seed. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

export interface ImpairDecision {
  dropped: boolean
  delayMs: number
}

export function decideImpairment(
  config: ImpairmentConfig,
  seq: number,
  dropNextRemaining: number,
): ImpairDecision & { dropNextRemaining: number } {
  if (config.outage) return { dropped: true, delayMs: 0, dropNextRemaining }

  if (dropNextRemaining > 0) {
    return { dropped: true, delayMs: 0, dropNextRemaining: dropNextRemaining - 1 }
  }

  // Keyed on the sequence number, not on call order, so two followers polling at
  // different moments still agree on what happened to message 47.
  const roll = mulberry32(config.seed ^ seq)
  const dropped = roll() < config.dropRate
  const jitter = roll()
  const delayMs = config.baseLatencyMs + config.jitterMs * (jitter - 0.5)

  return { dropped, delayMs: Math.max(0, delayMs), dropNextRemaining }
}

interface ScheduledMessage<T> {
  msg: T
  seq: number
  deliverAt: number
}

export class ImpairmentScheduler<T> {
  private queue: ScheduledMessage<T>[] = []
  private dropNextRemaining = 0
  private delivered = 0
  private dropped = 0
  /**
   * An explicit field rather than a constructor parameter property: these modules run
   * directly under Node's type stripping so the tests need no build step, and stripping
   * cannot desugar a parameter property. Same reason the correction kinds are a const
   * object rather than an `enum`.
   */
  private config: ImpairmentConfig

  constructor(config: ImpairmentConfig) {
    this.config = config
  }

  updateConfig(config: ImpairmentConfig): void {
    this.config = config
    this.dropNextRemaining = config.dropNextN
  }

  /** Arm "drop the next N messages" without disturbing anything else. */
  dropNext(count: number): void {
    this.dropNextRemaining = count
  }

  enqueue(msg: T, seq: number, now: number): ImpairDecision {
    const decision = decideImpairment(this.config, seq, this.dropNextRemaining)
    this.dropNextRemaining = decision.dropNextRemaining

    if (decision.dropped) {
      this.dropped++
    } else {
      this.queue.push({ msg, seq, deliverAt: now + decision.delayMs })
      this.queue.sort((a, b) => a.deliverAt - b.deliverAt)
    }
    return decision
  }

  poll(now: number): T[] {
    const ready: T[] = []
    while (this.queue.length > 0 && this.queue[0]!.deliverAt <= now) {
      ready.push(this.queue.shift()!.msg)
      this.delivered++
    }
    return ready
  }

  stats(): { delivered: number; dropped: number; inFlight: number } {
    return { delivered: this.delivered, dropped: this.dropped, inFlight: this.queue.length }
  }

  clear(): void {
    this.queue = []
  }
}

export const IMPAIRMENT_PRESETS: Record<string, ImpairmentConfig> = {
  clean: { seed: 1, dropRate: 0, baseLatencyMs: 0, jitterMs: 0, dropNextN: 0, outage: false },
  wifi: { seed: 7, dropRate: 0.01, baseLatencyMs: 25, jitterMs: 20, dropNextN: 0, outage: false },
  lossyWan: { seed: 11, dropRate: 0.08, baseLatencyMs: 120, jitterMs: 90, dropNextN: 0, outage: false },
  awful: { seed: 13, dropRate: 0.25, baseLatencyMs: 400, jitterMs: 300, dropNextN: 0, outage: false },
}
