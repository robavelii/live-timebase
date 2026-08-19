'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applySyncwaveMessage,
  DEFAULT_SYNCWAVE_DEFECTS,
  decideSyncwaveCorrection,
  type SyncwaveDefectFlags,
  type SyncwaveHostState,
  type SyncwaveMsg,
} from '@/lib/syncwave'
import { CORRECTION_INTERVAL_MS, DIAGNOSTICS_INTERVAL_MS } from '@/lib/protocol'

export interface SyncwaveDiagnostics {
  kind: 'none' | 'seek' | 'idle'
  /** Against the host's timeline — which is the mistake, and is shown as such. */
  driftSeconds: number
  targetSeconds: number | null
  hostTime: number | null
  hardSeeks: number
}

const INITIAL: SyncwaveDiagnostics = {
  kind: 'idle',
  driftSeconds: 0,
  targetSeconds: null,
  hostTime: null,
  hardSeeks: 0,
}

/**
 * The command-mirroring follower, run against the same impaired stream as the
 * timebase one.
 *
 * Structurally the same loop and the same cadence, so the comparison is between the
 * two ideas rather than between two amounts of engineering. The differences are the
 * ones that matter: it applies a position rather than deriving one, it has a single
 * 750 ms threshold with a hard seek beyond it, and it has no notion of a coordinate
 * that is not its own.
 */
export function useSyncwaveFollower(options: {
  videoRef: React.RefObject<HTMLVideoElement | null>
  msgRef: React.MutableRefObject<SyncwaveMsg | null>
  seqRef: React.MutableRefObject<number>
  enabled: boolean
  defects?: SyncwaveDefectFlags
  onHardSeek?: (displacementSeconds: number) => void
}) {
  const { videoRef, msgRef, seqRef, enabled, defects, onHardSeek } = options

  const hostRef = useRef<SyncwaveHostState | null>(null)
  const appliedSeqRef = useRef(0)
  const stateRef = useRef({ hardSeeks: 0, latest: INITIAL })
  const [diagnostics, setDiagnostics] = useState<SyncwaveDiagnostics>(INITIAL)

  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const defectsRef = useRef(defects ?? DEFAULT_SYNCWAVE_DEFECTS)
  defectsRef.current = defects ?? DEFAULT_SYNCWAVE_DEFECTS
  const onHardSeekRef = useRef(onHardSeek)
  onHardSeekRef.current = onHardSeek

  const evaluate = useCallback(() => {
    const video = videoRef.current
    const memory = stateRef.current
    if (!video || !enabledRef.current) return

    // Apply anything newly delivered. `localAt` is stamped on arrival, which is the
    // `ignoreAt` defect: the host's position is treated as current *now* rather than
    // when it was true, so the follower sits one one-way delay behind for good.
    let isExplicitSeek = false
    if (seqRef.current !== appliedSeqRef.current && msgRef.current) {
      appliedSeqRef.current = seqRef.current
      isExplicitSeek = msgRef.current.type === 'seek'
      hostRef.current = applySyncwaveMessage(
        msgRef.current,
        hostRef.current,
        performance.now(),
        defectsRef.current,
      )
    }

    const host = hostRef.current
    if (!host) return
    if (video.readyState < 1 || video.seeking) return

    if (host.paused) {
      if (!video.paused) video.pause()
    } else if (video.paused) {
      void video.play().catch(() => {})
    }

    const result = decideSyncwaveCorrection(video.currentTime, host, performance.now(), {
      tolerantSeek: defectsRef.current.tolerantSeek,
      isExplicitSeek,
    })

    if (result.kind === 'seek') {
      const displacement = Math.abs(video.currentTime - result.targetSeconds)
      video.currentTime = result.targetSeconds
      memory.hardSeeks++
      onHardSeekRef.current?.(displacement)
    }
    video.playbackRate = host.rate

    memory.latest = {
      kind: result.kind,
      driftSeconds: result.driftSeconds,
      targetSeconds: result.targetSeconds,
      hostTime: host.time,
      hardSeeks: memory.hardSeeks,
    }
  }, [videoRef, msgRef, seqRef])

  useEffect(() => {
    const loop = setInterval(evaluate, CORRECTION_INTERVAL_MS)
    return () => clearInterval(loop)
  }, [evaluate])

  useEffect(() => {
    const publish = setInterval(() => setDiagnostics(stateRef.current.latest), DIAGNOSTICS_INTERVAL_MS)
    return () => clearInterval(publish)
  }, [])

  const reset = useCallback(() => {
    stateRef.current.hardSeeks = 0
  }, [])

  return { diagnostics, reset }
}
