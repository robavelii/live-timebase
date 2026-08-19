/**
 * The live shared coordinate: `EXT-X-PROGRAM-DATE-TIME`.
 *
 * On a live playlist `video.currentTime` is a coordinate in *this client's* view
 * of the stream. Its origin depends on when the client joined and how deep its
 * buffer is, so two collectors on the same URL can sit seconds apart and each be
 * perfectly accurate about their own playhead while producing timestamps that do
 * not compare. There is no shared origin to fall back on.
 *
 * PROGRAM-DATE-TIME is the fix: the packager stamps an absolute instant onto each
 * segment, so every client reading the same playlist gets the same value for the
 * same picture. This module owns the mapping in both directions and — more
 * importantly — owns the question of whether the mapping can currently be
 * trusted, because that is the thing most likely to go wrong in live operation.
 *
 * Two properties are deliberate:
 *
 *  1. **One anchor per fragment, never one per stream.** PROGRAM-DATE-TIME is
 *     only reliably monotonic within a discontinuity sequence. An encoder
 *     restart, a feed switch, an ad insert or a clock correction resets it, and
 *     the media↔absolute mapping changes underneath you. A single long-lived
 *     anchor would keep answering confidently with a stale offset.
 *
 *  2. **Provenance on every answer.** An interpolation inside a fragment we hold
 *     is exact. An extrapolation past the newest fragment is good to the
 *     encoder's segment timing and no better. Those are different data qualities
 *     and the difference belongs in the event record, not in a log line.
 */

import { PDT_CONTINUITY_TOLERANCE_MS, type PdtSource } from './protocol.ts'

/** One fragment's contribution to the mapping. */
export interface FragAnchor {
  /** Media position where the fragment starts, in seconds (hls.js `frag.start`). */
  start: number
  /** Fragment duration in seconds. */
  duration: number
  /** PROGRAM-DATE-TIME of the fragment's first sample, ms since the Unix epoch. */
  pdt: number
  /** Discontinuity sequence (`frag.cc`). The mapping is only valid within one. */
  cc: number
  /** Media sequence number, for logging. */
  sn: number
}

export interface PdtReading {
  /** The absolute instant, ms. */
  pdt: number
  source: PdtSource
  cc: number
}

export interface MediaReading {
  /** Local media position, seconds. */
  mediaTime: number
  source: PdtSource
  cc: number
}

export interface PdtHealth {
  /** Have we ever been given a PROGRAM-DATE-TIME? */
  present: boolean
  /** Fragments currently held in the mapping. */
  anchors: number
  /** Current discontinuity sequence. */
  cc: number | null
  /** How many times cc changed. Each one invalidates the previous mapping. */
  discontinuities: number
  /**
   * How many times PROGRAM-DATE-TIME jumped by more than the segment durations
   * account for, without a discontinuity to explain it. Non-zero means the
   * encoder's clock moved and absolute alignment before that point is suspect.
   */
  pdtBreaks: number
  /** Absolute span currently mapped, ms. Null before the first fragment. */
  coverage: { minPdt: number; maxPdt: number } | null
}

const MAX_ANCHORS = 64

export class PdtMap {
  /** Ordered by `start`, capped. Only anchors of the current `cc` are kept. */
  private anchors: FragAnchor[] = []
  private cc: number | null = null
  private discontinuities = 0
  private pdtBreaks = 0
  private everPresent = false

  /**
   * Record a fragment. Call from `FRAG_CHANGED` and from playlist updates — it is
   * idempotent on `(cc, sn)`.
   *
   * Returns what the new fragment revealed, so the console can tell an operator
   * that the stream's absolute timeline moved rather than silently carrying on
   * with an anchor that no longer describes it.
   */
  ingest(frag: FragAnchor): { discontinuity: boolean; pdtBreak: boolean } {
    this.everPresent = true

    // A change of discontinuity sequence invalidates every earlier anchor: the
    // mapping from media position to absolute time is simply different now.
    if (this.cc !== null && frag.cc !== this.cc) {
      this.anchors = []
      this.discontinuities++
      this.cc = frag.cc
      this.anchors.push(frag)
      return { discontinuity: true, pdtBreak: false }
    }
    this.cc = frag.cc

    const existing = this.anchors.findIndex((a) => a.sn === frag.sn)
    if (existing >= 0) {
      this.anchors[existing] = frag
      return { discontinuity: false, pdtBreak: false }
    }

    // Continuity check *within* a discontinuity sequence. Presence of a stamp at
    // registration is necessary and not sufficient; the stamps have to keep
    // agreeing with the segment durations, and when they stop it is an encoder
    // clock correction, not noise.
    let pdtBreak = false
    const previous = this.anchors[this.anchors.length - 1]
    if (previous && frag.start >= previous.start) {
      const expectedPdt = previous.pdt + (frag.start - previous.start) * 1000
      if (Math.abs(frag.pdt - expectedPdt) > PDT_CONTINUITY_TOLERANCE_MS) {
        pdtBreak = true
        this.pdtBreaks++
        // The old anchors describe a different absolute timeline. Drop them
        // rather than average two truths together.
        this.anchors = []
      }
    }

    this.anchors.push(frag)
    this.anchors.sort((a, b) => a.start - b.start)
    if (this.anchors.length > MAX_ANCHORS) {
      this.anchors = this.anchors.slice(-MAX_ANCHORS)
    }
    return { discontinuity: false, pdtBreak }
  }

  /** Forget everything. Call when the source URL changes. */
  reset(): void {
    this.anchors = []
    this.cc = null
    this.everPresent = false
  }

  /**
   * Media position → absolute instant.
   *
   * Interpolating *inside* a fragment is exact: PROGRAM-DATE-TIME is the instant
   * of the fragment's first sample and media time advances with it. Beyond the
   * newest fragment we extrapolate at most one fragment's worth and say so —
   * playback routinely runs a little ahead of the last `FRAG_CHANGED` we saw.
   */
  toPdt(mediaTime: number): PdtReading | null {
    const containing = this.anchors.find(
      (a) => mediaTime >= a.start && mediaTime < a.start + a.duration,
    )
    if (containing) {
      return {
        pdt: containing.pdt + (mediaTime - containing.start) * 1000,
        source: 'frag',
        cc: containing.cc,
      }
    }

    const nearest = this.nearestAnchor(mediaTime)
    if (!nearest) return null
    const gap = mediaTime < nearest.start
      ? nearest.start - mediaTime
      : mediaTime - (nearest.start + nearest.duration)
    if (gap > nearest.duration) return null // too far to claim anything useful
    return {
      pdt: nearest.pdt + (mediaTime - nearest.start) * 1000,
      source: 'extrapolated',
      cc: nearest.cc,
    }
  }

  /**
   * Absolute instant → media position.
   *
   * This is the direction the follower needs: the transport publishes a PDT and
   * each client has to work out where that is *in its own buffer*.
   */
  toMedia(pdt: number): MediaReading | null {
    const containing = this.anchors.find(
      (a) => pdt >= a.pdt && pdt < a.pdt + a.duration * 1000,
    )
    if (containing) {
      return {
        mediaTime: containing.start + (pdt - containing.pdt) / 1000,
        source: 'frag',
        cc: containing.cc,
      }
    }

    if (this.anchors.length === 0) return null
    const nearest = this.anchors.reduce((best, a) =>
      Math.abs(a.pdt - pdt) < Math.abs(best.pdt - pdt) ? a : best,
    )
    const gapMs = pdt < nearest.pdt
      ? nearest.pdt - pdt
      : pdt - (nearest.pdt + nearest.duration * 1000)
    if (gapMs > nearest.duration * 1000) return null
    return {
      mediaTime: nearest.start + (pdt - nearest.pdt) / 1000,
      source: 'extrapolated',
      cc: nearest.cc,
    }
  }

  /** Newest absolute instant we hold a fragment for. */
  latestPdt(): number | null {
    const last = this.anchors[this.anchors.length - 1]
    return last ? last.pdt + last.duration * 1000 : null
  }

  health(): PdtHealth {
    const first = this.anchors[0]
    const last = this.anchors[this.anchors.length - 1]
    return {
      present: this.everPresent,
      anchors: this.anchors.length,
      cc: this.cc,
      discontinuities: this.discontinuities,
      pdtBreaks: this.pdtBreaks,
      coverage:
        first && last
          ? { minPdt: first.pdt, maxPdt: last.pdt + last.duration * 1000 }
          : null,
    }
  }

  private nearestAnchor(mediaTime: number): FragAnchor | undefined {
    if (this.anchors.length === 0) return undefined
    return this.anchors.reduce((best, a) =>
      Math.abs(a.start - mediaTime) < Math.abs(best.start - mediaTime) ? a : best,
    )
  }
}
