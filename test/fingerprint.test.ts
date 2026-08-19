import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareFingerprints, describeMismatch, isFatal } from '../lib/fingerprint.ts'
import type { StreamFingerprint } from '../lib/protocol.ts'

const T0 = 1_700_000_000_000

const base: StreamFingerprint = {
  src: 'https://cdn.example.com/live/index.m3u8',
  live: true,
  targetDuration: 2,
  pdtPresent: true,
  discontinuitySequence: 0,
  latestPdt: T0,
}

const variant = (overrides: Partial<StreamFingerprint>): StreamFingerprint => ({
  ...base,
  ...overrides,
})

describe('stream identity', () => {
  it('accepts two clients on the same stream at different latencies', () => {
    // Eight seconds of latency difference is ordinary; one console has simply
    // buffered more of the window than the other.
    const mismatches = compareFingerprints(base, variant({ latestPdt: T0 - 8_000 }))
    assert.deepEqual(mismatches, [])
  })

  it('refuses two different stream URLs', () => {
    const mismatches = compareFingerprints(
      base,
      variant({ src: 'https://cdn.example.com/live-backup/index.m3u8' }),
    )
    assert.equal(mismatches.length, 1)
    assert.equal(mismatches[0]!.field, 'src')
    assert.equal(isFatal(mismatches), true)
  })

  it('ignores per-client tokens in the query string', () => {
    // Signed URLs differ per client by design; the path is the identity.
    const mismatches = compareFingerprints(
      base,
      variant({ src: 'https://cdn.example.com/live/index.m3u8?token=abc123&exp=999' }),
    )
    assert.deepEqual(mismatches, [])
  })

  it('refuses a live console joining a recorded session, and the reverse', () => {
    assert.equal(isFatal(compareFingerprints(base, variant({ live: false }))), true)
    assert.equal(
      isFatal(compareFingerprints(variant({ live: false }), variant({ live: true }))),
      true,
    )
  })

  it('refuses when only one console can read an absolute stamp', () => {
    const mismatches = compareFingerprints(base, variant({ pdtPresent: false }))
    assert.equal(mismatches[0]!.field, 'pdtPresent')
    assert.equal(isFatal(mismatches), true)
  })

  it('permits a different rendition, because the stamps still agree', () => {
    const mismatches = compareFingerprints(base, variant({ targetDuration: 6 }))
    assert.equal(mismatches.length, 1)
    assert.equal(mismatches[0]!.field, 'targetDuration')
    assert.equal(isFatal(mismatches), false)
  })

  it('refuses when the two disagree about what time the stream is at', () => {
    // Ten minutes apart is not a latency difference. Either they are on different
    // streams, or one is reading a playlist that has stopped updating — and both of
    // those produce a dataset in which nothing pairs.
    const mismatches = compareFingerprints(base, variant({ latestPdt: T0 - 600_000 }))
    assert.equal(mismatches[0]!.field, 'latestPdt')
    assert.equal(isFatal(mismatches), true)
  })

  it('does not compare absolute time on recorded sources', () => {
    const vod = variant({ live: false, latestPdt: null, pdtPresent: false })
    assert.deepEqual(compareFingerprints(vod, { ...vod, latestPdt: null }), [])
  })

  it('reports every difference, not just the first', () => {
    const mismatches = compareFingerprints(
      base,
      variant({ src: 'https://other/index.m3u8', targetDuration: 6, pdtPresent: false }),
    )
    assert.equal(mismatches.length, 3)
    assert.ok(mismatches.every((mismatch) => describeMismatch(mismatch).length > 0))
  })
})
