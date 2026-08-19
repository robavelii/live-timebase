/**
 * Are both collectors actually looking at the same stream?
 *
 * Everything else here assumes they are, and the assumption is worth exactly nothing
 * unless it is checked, because its failure is silent. Two collectors on two
 * renditions of one match, or on a primary feed and its backup, are each internally
 * consistent: every event carries a defensible timestamp, no single record looks
 * wrong, and nothing pairs. By the time anyone notices, the match is collected.
 *
 * So this compares behaviour rather than bytes, and it distinguishes differences that
 * make the data incomparable from differences that are merely worth knowing.
 */

import {
  FINGERPRINT_PDT_TOLERANCE_MS,
  type FingerprintMismatch,
  type StreamFingerprint,
} from './protocol.ts'

/**
 * Compare a joining client's fingerprint against the session's.
 *
 * Fatal means refuse the join: the two clients could not produce comparable events.
 * Non-fatal means report it — a differing target duration is usually two renditions of
 * one stream, which is survivable for timestamps but worth an operator seeing.
 */
export function compareFingerprints(
  session: StreamFingerprint,
  joining: StreamFingerprint,
): FingerprintMismatch[] {
  const mismatches: FingerprintMismatch[] = []

  if (normaliseSrc(session.src) !== normaliseSrc(joining.src)) {
    mismatches.push({
      field: 'src',
      ours: session.src,
      theirs: joining.src,
      fatal: true,
    })
  }

  if (session.live !== joining.live) {
    mismatches.push({
      field: 'live',
      ours: String(session.live),
      theirs: String(joining.live),
      // A live stream and a recording of it use different coordinates entirely.
      fatal: true,
    })
  }

  if (session.pdtPresent !== joining.pdtPresent) {
    mismatches.push({
      field: 'pdtPresent',
      ours: String(session.pdtPresent),
      theirs: String(joining.pdtPresent),
      // On live, one client without an absolute stamp cannot be compared with one
      // that has it. There is no partial credit.
      fatal: session.live || joining.live,
    })
  }

  if (
    session.targetDuration > 0 &&
    joining.targetDuration > 0 &&
    session.targetDuration !== joining.targetDuration
  ) {
    mismatches.push({
      field: 'targetDuration',
      ours: `${session.targetDuration}s`,
      theirs: `${joining.targetDuration}s`,
      // Different segment cadence usually means a different rendition of the same
      // stream. The absolute stamps still agree, so timestamps remain comparable.
      fatal: false,
    })
  }

  if (
    session.live &&
    joining.live &&
    session.latestPdt !== null &&
    joining.latestPdt !== null
  ) {
    const gap = Math.abs(session.latestPdt - joining.latestPdt)
    if (gap > FINGERPRINT_PDT_TOLERANCE_MS) {
      mismatches.push({
        field: 'latestPdt',
        ours: new Date(session.latestPdt).toISOString(),
        theirs: new Date(joining.latestPdt).toISOString(),
        // Two clients on one live stream differ here by their latency. Two minutes
        // apart is not latency; it is two different streams, or one of them is
        // reading a stale playlist.
        fatal: true,
      })
    }
  }

  return mismatches
}

export function isFatal(mismatches: readonly FingerprintMismatch[]): boolean {
  return mismatches.some((mismatch) => mismatch.fatal)
}

export function describeMismatch(mismatch: FingerprintMismatch): string {
  switch (mismatch.field) {
    case 'src':
      return `different stream URL — the session is on ${mismatch.ours}, this console is on ${mismatch.theirs}`
    case 'live':
      return `one console has a live stream and the other does not (${mismatch.ours} vs ${mismatch.theirs})`
    case 'pdtPresent':
      return `only one console can read EXT-X-PROGRAM-DATE-TIME (${mismatch.ours} vs ${mismatch.theirs}), so there is no shared coordinate`
    case 'targetDuration':
      return `different segment duration (${mismatch.ours} vs ${mismatch.theirs}) — probably two renditions; timestamps still compare`
    case 'latestPdt':
      return `the two consoles disagree about what time the stream is at (${mismatch.ours} vs ${mismatch.theirs}) by more than latency explains`
    default:
      return 'streams differ'
  }
}

/** Ignore query strings that carry per-client tokens rather than identity. */
function normaliseSrc(src: string): string {
  try {
    const url = new URL(src, 'http://local')
    return `${url.origin === 'http://local' ? '' : url.origin}${url.pathname}`
  } catch {
    return src
  }
}
