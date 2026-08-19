/**
 * These tests are meant to be read as the specification. If a claim in the README
 * is not backed by something here, treat it as unproven.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  bestOffset,
  calculateTarget,
  CorrectionKind,
  cristianSample,
  decideCorrection,
  detectClockStep,
  shouldAcceptTransport,
} from '../lib/timebase.ts'
import type { Transport } from '../lib/protocol.ts'

const vod = (partial: Partial<Transport> = {}): Transport => ({
  epoch: 1,
  sequence: 0,
  mode: 'vod',
  state: 'playing',
  rate: 1,
  anchor: 100,
  anchorServerTime: 1_000_000,
  reason: 'play',
  origin: 'home',
  leadMediaTime: null,
  ...partial,
})

describe('calculateTarget', () => {
  it('holds the anchor while paused, whatever time it is', () => {
    const transport = vod({ state: 'paused' })
    assert.equal(calculateTarget(transport, 1_000_000), 100)
    assert.equal(calculateTarget(transport, 9_999_999), 100)
  })

  it('advances a vod anchor in seconds', () => {
    assert.equal(calculateTarget(vod(), 1_010_000), 110)
  })

  it('advances a live anchor in milliseconds, because it is an instant', () => {
    const live = vod({ mode: 'live', anchor: 1_700_000_000_000 })
    assert.equal(calculateTarget(live, 1_010_000), 1_700_000_010_000)
  })

  it('scales elapsed time by the rate in both modes', () => {
    assert.equal(calculateTarget(vod({ rate: 2 }), 1_010_000), 120)
    assert.equal(
      calculateTarget(vod({ mode: 'live', anchor: 0, rate: 2 }), 1_010_000),
      20_000,
    )
  })

  it('is stateless: the same inputs give the same answer regardless of history', () => {
    const transport = vod()
    const first = calculateTarget(transport, 1_007_500)
    const second = calculateTarget(transport, 1_007_500)
    assert.equal(first, second)
  })
})

describe('decideCorrection', () => {
  it('leaves the player alone inside one frame', () => {
    const result = decideCorrection(100.02, 100, 1)
    assert.equal(result.kind, CorrectionKind.NONE)
  })

  it('trims the rate for a small error rather than jumping', () => {
    const result = decideCorrection(100.2, 100, 1)
    assert.equal(result.kind, CorrectionKind.NUDGE)
    // Ahead of target → slow down.
    assert.ok(result.appliedRate! < 1)
  })

  it('speeds up when behind', () => {
    const result = decideCorrection(99.8, 100, 1)
    assert.equal(result.kind, CorrectionKind.NUDGE)
    assert.ok(result.appliedRate! > 1)
  })

  it('clamps the rate to ±10%', () => {
    const ahead = decideCorrection(100.49, 100, 1)
    const behind = decideCorrection(99.51, 100, 1)
    assert.ok(ahead.appliedRate! >= 0.9 - 1e-9)
    assert.ok(behind.appliedRate! <= 1.1 + 1e-9)
  })

  it('repositions only past the point where a nudge would be slower', () => {
    assert.equal(decideCorrection(100.49, 100, 1).kind, CorrectionKind.NUDGE)
    assert.equal(decideCorrection(100.51, 100, 1).kind, CorrectionKind.SEEK)
  })

  it('holds rather than chasing a target derived from an untrusted clock', () => {
    const result = decideCorrection(140, 100, 1, { clockTrusted: false })
    assert.equal(result.kind, CorrectionKind.HOLD)
    // The drift is still reported — holding is a decision, not an absence of one.
    assert.equal(result.driftSeconds, 40)
  })

  it('needs 60 ms to leave lock but only 40 ms to enter it', () => {
    // An error parked at 50 ms is the common case, because a startup offset inside
    // the tolerance is never corrected away. Without hysteresis this alternates
    // between locked and nudging several times a second.
    const whileLocked = decideCorrection(100.05, 100, 1, {
      previousKind: CorrectionKind.NONE,
    })
    assert.equal(whileLocked.kind, CorrectionKind.NONE)

    const whileNudging = decideCorrection(100.05, 100, 1, {
      previousKind: CorrectionKind.NUDGE,
    })
    assert.equal(whileNudging.kind, CorrectionKind.NUDGE)

    const wellOutside = decideCorrection(100.07, 100, 1, {
      previousKind: CorrectionKind.NONE,
    })
    assert.equal(wellOutside.kind, CorrectionKind.NUDGE)
  })
})

describe('shouldAcceptTransport', () => {
  const base = vod({ epoch: 5, sequence: 10 })

  it('accepts anything when nothing is held', () => {
    assert.equal(shouldAcceptTransport(base, null), true)
  })

  it('accepts a later sequence in the same epoch', () => {
    assert.equal(shouldAcceptTransport(vod({ epoch: 5, sequence: 11 }), base), true)
  })

  it('drops a stale sequence instead of briefly applying it', () => {
    assert.equal(shouldAcceptTransport(vod({ epoch: 5, sequence: 9 }), base), false)
    assert.equal(shouldAcceptTransport(vod({ epoch: 5, sequence: 10 }), base), false)
  })

  it('accepts a higher epoch even when its sequence restarts at zero', () => {
    assert.equal(shouldAcceptTransport(vod({ epoch: 6, sequence: 0 }), base), true)
  })

  it('drops a lower epoch even when its sequence is higher', () => {
    // This is the case a reconnect produces: a snapshot from an older generation.
    assert.equal(shouldAcceptTransport(vod({ epoch: 4, sequence: 999 }), base), false)
  })
})

describe('clock offset estimation', () => {
  it('cancels a constant local skew exactly, however large', () => {
    // A collector whose laptop is an hour wrong. One-way delay 20 ms each way.
    const skew = 3_600_000
    const trueServerTime = 5_000_000
    const t0 = trueServerTime + skew
    const serverTs = trueServerTime + 20
    const t1 = trueServerTime + 40 + skew

    const sample = cristianSample(t0, serverTs, t1)
    assert.equal(sample.offset, -skew)
    assert.equal(sample.rtt, 40)
    // localNow + offset recovers true session time.
    assert.equal(t1 + sample.offset, trueServerTime + 40)
  })

  it('leaves half the path asymmetry as residual error', () => {
    // 10 ms out, 50 ms back: 20 ms of asymmetry, so 20 ms of error.
    const sample = cristianSample(0, 10, 60)
    assert.equal(sample.offset, -20)
    assert.equal(sample.rtt, 60)
  })

  it('picks the lowest-RTT sample rather than averaging', () => {
    const offset = bestOffset([
      { offset: 100, rtt: 400 },
      { offset: 7, rtt: 12 },
      { offset: -250, rtt: 900 },
    ])
    assert.equal(offset, 7)
  })

  it('returns zero with no samples, so callers must check trust separately', () => {
    assert.equal(bestOffset([]), 0)
  })
})

describe('detectClockStep', () => {
  it('ignores ordinary drift', () => {
    assert.equal(detectClockStep(10_000, 10_050), false)
  })

  it('catches an NTP correction', () => {
    assert.equal(detectClockStep(10_000, 4_000), true)
  })

  it('catches a resume from sleep, where the monotonic clock stopped', () => {
    // 90 s of wall clock, 0.2 s of monotonic clock.
    assert.equal(detectClockStep(90_000, 200), true)
  })
})
