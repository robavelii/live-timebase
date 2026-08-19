/**
 * The live claim, tested.
 *
 * Everything else in this app works on recorded footage too. This file is about the
 * one thing that does not: that two clients whose `currentTime` origins differ can
 * still agree, to the millisecond, on when something happened.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PdtMap, type FragAnchor } from '../lib/pdt.ts'

const T0 = 1_700_000_000_000

/** A window of `count` two-second fragments starting at media position `start`. */
function window(start: number, count: number, pdt0 = T0, cc = 0): FragAnchor[] {
  return Array.from({ length: count }, (_, index) => ({
    start: start + index * 2,
    duration: 2,
    pdt: pdt0 + index * 2000,
    cc,
    sn: 100 + index,
  }))
}

function mapOf(fragments: FragAnchor[]): PdtMap {
  const map = new PdtMap()
  for (const fragment of fragments) map.ingest(fragment)
  return map
}

describe('media ↔ absolute mapping', () => {
  it('interpolates exactly inside a fragment it holds', () => {
    const map = mapOf(window(0, 5))
    const reading = map.toPdt(3.5)
    assert.equal(reading?.source, 'frag')
    assert.equal(reading?.pdt, T0 + 3500)
  })

  it('inverts', () => {
    const map = mapOf(window(0, 5))
    const media = map.toMedia(T0 + 7250)
    assert.equal(media?.source, 'frag')
    assert.ok(Math.abs(media!.mediaTime - 7.25) < 1e-9)
  })

  it('extrapolates at most one fragment past what it holds, and says so', () => {
    const map = mapOf(window(0, 3)) // covers media 0–6 s
    const justPast = map.toPdt(6.4)
    assert.equal(justPast?.source, 'extrapolated')
    assert.equal(justPast?.pdt, T0 + 6400)
  })

  it('refuses rather than guessing when it is too far outside', () => {
    const map = mapOf(window(0, 3))
    assert.equal(map.toPdt(45), null)
    assert.equal(map.toMedia(T0 + 45_000), null)
  })

  it('has no answer at all before the first fragment arrives', () => {
    const map = new PdtMap()
    assert.equal(map.toPdt(10), null)
    assert.equal(map.health().present, false)
  })
})

describe('two clients with different buffer origins', () => {
  /**
   * This is the whole argument for live. Both clients are reading the same playlist
   * and hold the same PROGRAM-DATE-TIME stamps, but they joined at different times,
   * so the same picture sits at a different `currentTime` in each of them.
   */
  const home = mapOf(window(0, 10, T0))
  const away = mapOf(window(137.5, 10, T0)) // joined earlier; 137.5 s deeper

  it('produces the same absolute instant for the same picture', () => {
    const homeReading = home.toPdt(4.2)
    const awayReading = away.toPdt(137.5 + 4.2)
    assert.equal(homeReading!.pdt, awayReading!.pdt)
    assert.equal(homeReading!.pdt, T0 + 4200)
  })

  it('resolves one published instant into each client\'s own position', () => {
    const target = T0 + 11_000
    assert.ok(Math.abs(home.toMedia(target)!.mediaTime - 11) < 1e-9)
    assert.ok(Math.abs(away.toMedia(target)!.mediaTime - 148.5) < 1e-9)
  })

  it('shows why currentTime alone would be wrong by the join offset', () => {
    // Comparing raw playheads for the same picture: 137.5 s of pure error, and
    // neither client is doing anything wrong.
    const homePlayhead = 4.2
    const awayPlayhead = 141.7
    assert.equal(Math.abs(awayPlayhead - homePlayhead), 137.5)
    // On the shared coordinate the same two observations are identical.
    assert.equal(home.toPdt(homePlayhead)!.pdt, away.toPdt(awayPlayhead)!.pdt)
  })
})

describe('continuity', () => {
  it('rebuilds the mapping on a discontinuity instead of averaging two timelines', () => {
    const map = mapOf(window(0, 5))
    // Feed switch: new discontinuity sequence, absolute time jumps back a day.
    const result = map.ingest({
      start: 10,
      duration: 2,
      pdt: T0 - 86_400_000,
      cc: 1,
      sn: 200,
    })
    assert.equal(result.discontinuity, true)
    assert.equal(map.health().discontinuities, 1)
    assert.equal(map.health().anchors, 1)
    // The old mapping is gone rather than lingering as a plausible wrong answer.
    assert.equal(map.toPdt(3.5), null)
    assert.equal(map.toPdt(10.5)?.pdt, T0 - 86_400_000 + 500)
  })

  it('flags a program-date-time jump that no discontinuity explains', () => {
    const map = mapOf(window(0, 5)) // fragments at media 0,2,4,6,8
    // Same cc, but the encoder's clock moved 4 s forward. Presence of a stamp at
    // registration would not have caught this; only watching continuity does.
    const result = map.ingest({
      start: 10,
      duration: 2,
      pdt: T0 + 10_000 + 4_000,
      cc: 0,
      sn: 105,
    })
    assert.equal(result.pdtBreak, true)
    assert.equal(map.health().pdtBreaks, 1)
    assert.equal(map.health().anchors, 1)
  })

  it('tolerates rounding in the stamps', () => {
    const map = mapOf(window(0, 3))
    const result = map.ingest({
      start: 6,
      duration: 2,
      pdt: T0 + 6_000 + 120, // 120 ms of encoder jitter, not a correction
      cc: 0,
      sn: 103,
    })
    assert.equal(result.pdtBreak, false)
    assert.equal(map.health().anchors, 4)
  })

  it('is idempotent on re-ingesting the same fragment', () => {
    const map = mapOf(window(0, 3))
    map.ingest(window(0, 3)[1])
    assert.equal(map.health().anchors, 3)
  })

  it('reports the absolute span it can currently answer for', () => {
    const map = mapOf(window(0, 4))
    const coverage = map.health().coverage
    assert.equal(coverage?.minPdt, T0)
    assert.equal(coverage?.maxPdt, T0 + 8_000)
  })
})
