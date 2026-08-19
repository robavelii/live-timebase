'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CORRECTION_INTERVAL_MS,
  DIAGNOSTICS_INTERVAL_MS,
  DVR_EDGE_MARGIN_S,
  FRAME_TOLERANCE_S,
  type Transport,
} from '@/lib/protocol'
import { calculateTarget, CorrectionKind, decideCorrection, type Correction } from '@/lib/timebase'
import type { MediaReading } from '@/lib/pdt'

export interface FollowerDiagnostics {
  kind: CorrectionKind
  driftMs: number
  /** Local position we should be at, seconds. Null when unresolvable. */
  targetSeconds: number | null
  /** The shared coordinate: PDT ms on live, media seconds on vod. */
  targetShared: number | null
  /** How the shared coordinate was mapped into this client's buffer. */
  mapping: MediaReading['source'] | null
  waitReason: Correction['waitReason'] | null
  appliedRate: number | null
  seeks: number
  nudges: number
  /** Share of evaluations inside one frame at 25 fps. */
  frameAccuratePct: number
  p95DriftMs: number
  samples: number
}

const MAX_SAMPLES = 3_000

const INITIAL: FollowerDiagnostics = {
  kind: CorrectionKind.WAIT,
  driftMs: 0,
  targetSeconds: null,
  targetShared: null,
  mapping: null,
  waitReason: 'no-transport',
  appliedRate: null,
  seeks: 0,
  nudges: 0,
  frameAccuratePct: 0,
  p95DriftMs: 0,
  samples: 0,
}

export interface FollowerOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>
  transportRef: React.MutableRefObject<Transport | null>
  /** Session time in ms. Must be stable. */
  sessionNow: () => number
  /** Whether the clock estimate can be acted on. Must be stable. */
  clockTrusted: () => boolean
  /** Absolute instant → local media position. Must be stable. */
  toMedia: (pdt: number) => MediaReading | null
  /** The DVR window this client can reach. Must be stable. */
  seekableRange: () => { start: number; end: number } | null
  /**
   * False when the operator has stepped out of the session to re-check a passage.
   * Passed as a value and read through a ref, so toggling it does not tear the
   * loop down.
   */
  enabled: boolean
  /**
   * False when the window is not being drawn. The follower stops correcting rather
   * than fighting a throttled timer — see the note in `evaluate`.
   */
  visible: boolean
}

/**
 * The loop that keeps one client on the session position.
 *
 * Note what is absent: there is no reconnection path, no catch-up path, no
 * late-join path, no replay of missed messages. A client that has missed
 * everything becomes correct on the next heartbeat through this same code. That
 * property is the entire reason for publishing state rather than mirroring
 * commands, and it is why this file is short.
 *
 * Two things it does **not** do, both deliberate:
 *
 *  - It never publishes. Corrections used to be republished as intents in the
 *    earlier prototype, guarded by a timing heuristic to tell a correction's
 *    `seeked` event from an operator's. On live, where a seek can take longer than
 *    the guard window, that heuristic fails and the server re-anchors to the
 *    follower — a feedback loop. Intents come from explicit operator commands only.
 *
 *  - It writes nothing to React state. Diagnostics are copied out of a ref on a
 *    slow interval. Routing a 5 Hz loop through render state for ninety minutes is
 *    the most likely way for this integration to go wrong in practice.
 */
export function useFollower(options: FollowerOptions) {
  const {
    videoRef,
    transportRef,
    sessionNow,
    clockTrusted,
    toMedia,
    seekableRange,
    enabled,
    visible,
  } = options

  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  const stateRef = useRef({
    lastKind: undefined as CorrectionKind | undefined,
    seeks: 0,
    nudges: 0,
    drifts: [] as number[],
    latest: INITIAL,
  })
  const [diagnostics, setDiagnostics] = useState<FollowerDiagnostics>(INITIAL)

  const evaluate = useCallback(() => {
    const video = videoRef.current
    const transport = transportRef.current
    const memory = stateRef.current
    if (!video) return

    const record = (patch: Partial<FollowerDiagnostics>) => {
      memory.latest = { ...memory.latest, ...patch, seeks: memory.seeks, nudges: memory.nudges }
    }

    if (!transport) {
      record({ kind: CorrectionKind.WAIT, waitReason: 'no-transport', targetSeconds: null })
      return
    }
    if (!enabledRef.current) {
      record({ kind: CorrectionKind.WAIT, waitReason: 'unlocked' })
      return
    }
    // A hidden window has its timers throttled to about 1 Hz and its frame callbacks
    // stopped. Correcting under those conditions is worse than not: each evaluation
    // is late, so the measured error is stale, and repositioning on a stale error
    // flushes the buffer and produces a fresh error. Observed as a console that sits
    // in a permanent reposition loop the moment it loses focus.
    //
    // Holding costs nothing. Nobody is looking at the picture, event timestamps are
    // still captured (and flagged as degraded), and one heartbeat after the window
    // comes back the client is correct again — which is the property the whole
    // design exists to have.
    if (!visibleRef.current) {
      record({ kind: CorrectionKind.WAIT, waitReason: 'hidden' })
      return
    }
    // A seek in flight has no meaningful currentTime to compare, and readyState 0
    // means there is nothing decoded to be right or wrong about.
    //
    // Each early return records *why*. Leaving the previous decision on screen
    // instead is worse than useless: a console stuck at readyState 0 kept reporting
    // "no transport" while the transport was arriving perfectly, which sent the
    // first investigation of this exact bug in entirely the wrong direction.
    if (video.readyState < 1) {
      record({ kind: CorrectionKind.WAIT, waitReason: 'no-media' })
      return
    }
    if (video.seeking) {
      record({ kind: CorrectionKind.WAIT, waitReason: 'seeking' })
      return
    }

    // Match the intended play/pause state first: correcting position against a
    // player that should not be running would fight itself.
    if (transport.state === 'paused') {
      if (!video.paused) video.pause()
    } else if (video.paused) {
      void video.play().catch(() => {
        /* autoplay is gated behind the operator's Start button */
      })
    }

    const shared = calculateTarget(transport, sessionNow())

    // Resolve the shared coordinate into this client's own buffer. On recorded
    // footage that is the identity; on live it is the whole problem.
    let targetSeconds: number
    let mapping: MediaReading['source'] | null = null
    if (transport.mode === 'live') {
      const mapped = toMedia(shared)
      if (!mapped) {
        record({
          kind: CorrectionKind.WAIT,
          waitReason: 'no-pdt-mapping',
          targetShared: shared,
          targetSeconds: null,
          mapping: null,
        })
        memory.lastKind = CorrectionKind.WAIT
        return
      }
      targetSeconds = mapped.mediaTime
      mapping = mapped.source
    } else {
      targetSeconds = shared
    }

    // The target can be a real instant this client simply cannot reach: the
    // segments have not arrived yet, or they have rolled out of the DVR window.
    // That is a different situation from an untrustworthy clock and it deserves a
    // different word in the UI, because the operator can act on one and not the
    // other.
    const range = seekableRange()
    if (range) {
      if (targetSeconds > range.end - 0.2 || targetSeconds < range.start) {
        record({
          kind: CorrectionKind.WAIT,
          waitReason: 'outside-dvr',
          targetShared: shared,
          targetSeconds,
          mapping,
        })
        memory.lastKind = CorrectionKind.WAIT
        return
      }
    }

    const result = decideCorrection(video.currentTime, targetSeconds, transport.rate, {
      clockTrusted: clockTrusted(),
      previousKind: memory.lastKind,
    })

    switch (result.kind) {
      case CorrectionKind.HOLD:
        // Deliberately nothing. Holding a slightly stale position beats moving to
        // a confidently wrong one.
        break
      case CorrectionKind.NONE:
        if (video.playbackRate !== transport.rate) video.playbackRate = transport.rate
        break
      case CorrectionKind.NUDGE:
        video.playbackRate = result.appliedRate!
        memory.nudges++
        break
      case CorrectionKind.SEEK: {
        const clamped = range
          ? Math.min(Math.max(targetSeconds, range.start + DVR_EDGE_MARGIN_S), range.end - 0.2)
          : targetSeconds
        video.currentTime = clamped
        video.playbackRate = transport.rate
        memory.seeks++
        break
      }
      default:
        break
    }

    if (result.kind !== CorrectionKind.HOLD) {
      memory.drifts.push(Math.abs(result.driftSeconds) * 1000)
      if (memory.drifts.length > MAX_SAMPLES) memory.drifts.shift()
    }
    memory.lastKind = result.kind

    record({
      kind: result.kind,
      driftMs: result.driftSeconds * 1000,
      targetSeconds,
      targetShared: shared,
      mapping,
      waitReason: null,
      appliedRate: result.appliedRate ?? null,
    })
  }, [videoRef, transportRef, sessionNow, clockTrusted, toMedia, seekableRange])

  // Coming back from hidden: re-evaluate at once rather than waiting for the next
  // tick, so the operator does not look at a stale frame while they orient.
  useEffect(() => {
    if (visible) evaluate()
  }, [visible, evaluate])

  useEffect(() => {
    const loop = setInterval(evaluate, CORRECTION_INTERVAL_MS)
    return () => clearInterval(loop)
  }, [evaluate])

  useEffect(() => {
    const publish = setInterval(() => {
      const { drifts, latest } = stateRef.current
      const accurate = drifts.filter((d) => d < FRAME_TOLERANCE_S * 1000).length
      const sorted = [...drifts].sort((a, b) => a - b)
      setDiagnostics({
        ...latest,
        frameAccuratePct: drifts.length ? (accurate / drifts.length) * 100 : 0,
        p95DriftMs: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0,
        samples: drifts.length,
      })
    }, DIAGNOSTICS_INTERVAL_MS)
    return () => clearInterval(publish)
  }, [])

  const resetMetrics = useCallback(() => {
    stateRef.current.drifts = []
    stateRef.current.seeks = 0
    stateRef.current.nudges = 0
  }, [])

  return { diagnostics, evaluate, resetMetrics }
}
