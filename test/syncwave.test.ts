/**
 * The comparison, tested.
 *
 * The point of these is to hold the A/B honest. Each defect is asserted to exist *and*
 * to disappear when its flag is turned off, so nobody has to take on trust that the
 * bench is not simply mis-implementing the alternative. The last suite is the one that
 * matters: the part that survives with every defect disabled.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applySyncwaveMessage,
  calculateSyncwaveTarget,
  decideSyncwaveCorrection,
  DEFAULT_SYNCWAVE_DEFECTS,
  NO_SYNCWAVE_DEFECTS,
  syncwaveLatencyBias,
  type SyncwaveHostState,
  type SyncwaveMsg,
} from '../lib/syncwave.ts'
import { decideImpairment, mulberry32 } from '../lib/impair.ts'
import { MetricsAccumulator, percentile } from '../lib/metrics.ts'
import type { ImpairmentConfig } from '../lib/protocol.ts'

const host = (overrides: Partial<SyncwaveHostState> = {}): SyncwaveHostState => ({
  time: 100,
  paused: false,
  rate: 1,
  localAt: 1_000,
  ...overrides,
})

describe('command mirroring', () => {
  it('projects the host position forward from arrival', () => {
    assert.equal(calculateSyncwaveTarget(host(), 3_000), 102)
  })

  it('holds while paused', () => {
    assert.equal(calculateSyncwaveTarget(host({ paused: true }), 9_999), 100)
  })

  it('hard-seeks past its tolerance and does nothing inside it', () => {
    assert.equal(decideSyncwaveCorrection(100.5, host(), 1_000).kind, 'none')
    assert.equal(decideSyncwaveCorrection(101.0, host(), 1_000).kind, 'seek')
  })

  it('has no correction between "leave it" and "jump"', () => {
    // A 700 ms error — 17 frames — is simply tolerated, then a 800 ms one jumps.
    // There is no equivalent of the rate trim, which is why every correction it makes
    // is visible to the operator.
    assert.equal(decideSyncwaveCorrection(100.7, host(), 1_000).kind, 'none')
    assert.equal(decideSyncwaveCorrection(100.8, host(), 1_000).kind, 'seek')
  })
})

describe('defects, each present and each removable', () => {
  it('ignoring the message timestamp costs one one-way delay, permanently', () => {
    assert.equal(syncwaveLatencyBias(120, true), 0.12)
    assert.equal(syncwaveLatencyBias(120, false), 0)
  })

  it('a rate change jumps the playhead backward — unless it projects first', () => {
    const current = host({ time: 100, localAt: 1_000 })
    const msg: SyncwaveMsg = { type: 'rate', rate: 2, at: 0, seq: 5 }

    // Five seconds after the anchor, the host is really at 105.
    const buggy = applySyncwaveMessage(msg, current, 6_000, DEFAULT_SYNCWAVE_DEFECTS)!
    assert.equal(buggy.time, 100)
    assert.equal(calculateSyncwaveTarget(buggy, 6_000), 100) // five seconds lost

    const fixed = applySyncwaveMessage(msg, current, 6_000, NO_SYNCWAVE_DEFECTS)!
    assert.equal(fixed.time, 105)
    assert.equal(calculateSyncwaveTarget(fixed, 6_000), 105)
  })

  it('a reordered delivery is applied then undone — unless sequence is checked', () => {
    const current = host({ lastSeq: 10 })
    const stale: SyncwaveMsg = { type: 'seek', time: 50, paused: false, at: 0, seq: 4 }

    const applied = applySyncwaveMessage(stale, current, 2_000, DEFAULT_SYNCWAVE_DEFECTS)!
    assert.equal(applied.time, 50) // jumped to a stale position

    const rejected = applySyncwaveMessage(stale, current, 2_000, NO_SYNCWAVE_DEFECTS)!
    assert.equal(rejected.time, 100) // left alone
  })

  it('a small deliberate seek is discarded — unless seeks bypass the tolerance', () => {
    // The lead nudges back 400 ms to re-watch a touch. Under the defect the follower
    // runs that instruction through the drift tolerance and does not move at all.
    const swallowed = decideSyncwaveCorrection(100.4, host(), 1_000, {
      tolerantSeek: true,
      isExplicitSeek: true,
    })
    assert.equal(swallowed.kind, 'none')

    const honoured = decideSyncwaveCorrection(100.4, host(), 1_000, {
      tolerantSeek: false,
      isExplicitSeek: true,
    })
    assert.equal(honoured.kind, 'seek')

    // Ordinary drift of the same size is still ignored either way — the flag governs
    // instructions, not observations.
    assert.equal(decideSyncwaveCorrection(100.4, host(), 1_000).kind, 'none')
  })
})

describe('what survives with every defect disabled', () => {
  it('a mirrored command carries no way to reach the follower s own coordinate', () => {
    // Collector A is at 76.0 s in its buffer. Collector B joined 14 s later, so the
    // same picture sits at 62.0 s in B's buffer. A publishes "I am at 76.0".
    const applied = applySyncwaveMessage(
      { type: 'seek', time: 76.0, paused: false, at: 0, seq: 1 },
      null,
      1_000,
      NO_SYNCWAVE_DEFECTS,
    )!
    assert.equal(applied.time, 76.0)

    // B does the only thing it can do with that number, and lands 14 s wrong.
    const correction = decideSyncwaveCorrection(62.0, applied, 1_000)
    assert.equal(correction.kind, 'seek')
    assert.equal(correction.targetSeconds, 76.0)
    assert.equal(Math.abs(correction.targetSeconds - 62.0), 14)

    // No flag changes this. The message does not contain the information needed.
    const withDefects = decideSyncwaveCorrection(62.0, applied, 1_000, {
      tolerantSeek: true,
      isExplicitSeek: true,
    })
    assert.equal(withDefects.targetSeconds, 76.0)
  })
})

describe('impairment', () => {
  const config: ImpairmentConfig = {
    seed: 42,
    dropRate: 0.3,
    baseLatencyMs: 100,
    jitterMs: 50,
    dropNextN: 0,
    outage: false,
  }

  it('is deterministic, so both followers get identical treatment', () => {
    for (const seq of [1, 2, 3, 17, 250]) {
      const a = decideImpairment(config, seq, 0)
      const b = decideImpairment(config, seq, 0)
      assert.deepEqual(a, b)
    }
  })

  it('does not depend on call order', () => {
    const forwards = [1, 2, 3].map((seq) => decideImpairment(config, seq, 0))
    const backwards = [3, 2, 1].map((seq) => decideImpairment(config, seq, 0)).reverse()
    assert.deepEqual(forwards, backwards)
  })

  it('drops everything during an outage', () => {
    const outage = decideImpairment({ ...config, outage: true }, 9, 0)
    assert.equal(outage.dropped, true)
  })

  it('honours drop-next before consulting the seed', () => {
    const first = decideImpairment(config, 1, 2)
    assert.equal(first.dropped, true)
    assert.equal(first.dropNextRemaining, 1)
  })

  it('never produces a negative delay', () => {
    const jittery: ImpairmentConfig = { ...config, baseLatencyMs: 5, jitterMs: 500 }
    for (let seq = 0; seq < 200; seq++) {
      assert.ok(decideImpairment(jittery, seq, 0).delayMs >= 0)
    }
  })

  it('produces a usable spread', () => {
    const random = mulberry32(1)
    const values = Array.from({ length: 500 }, random)
    assert.ok(Math.min(...values) < 0.05)
    assert.ok(Math.max(...values) > 0.95)
  })
})

describe('metrics', () => {
  it('reports percentiles over absolute error', () => {
    assert.equal(percentile([0, 10, 20, 30, 40], 50), 20)
    assert.equal(percentile([], 95), 0)
  })

  it('separates a systematic bias from noise', () => {
    const biased = new MetricsAccumulator()
    for (let i = 0; i < 100; i++) biased.record(-120, 'none', i)
    assert.equal(biased.snapshot().meanSignedMs, -120)
    assert.equal(biased.snapshot().p50Ms, 120)

    const noisy = new MetricsAccumulator()
    for (let i = 0; i < 100; i++) noisy.record(i % 2 ? 120 : -120, 'none', i)
    assert.equal(Math.abs(noisy.snapshot().meanSignedMs) < 1e-9, true)
  })

  it('counts frame-accurate samples against one frame at 25 fps', () => {
    const metrics = new MetricsAccumulator()
    metrics.record(20, 'none', 0)
    metrics.record(39, 'none', 1)
    metrics.record(41, 'nudge', 2)
    metrics.record(900, 'seek', 3)
    const snapshot = metrics.snapshot()
    assert.equal(snapshot.frameAccuratePct, 50)
    assert.equal(snapshot.nudges, 1)
    assert.equal(snapshot.hardSeeks, 1)
  })

  it('expresses p95 as a share of the duel-pairing window', () => {
    const metrics = new MetricsAccumulator()
    for (let i = 0; i < 20; i++) metrics.record(750, 'seek', i)
    // 750 ms of 2,000 ms — the number in the audit.
    assert.equal(Math.round(metrics.snapshot().duelWindowConsumedPct), 38)
  })
})
