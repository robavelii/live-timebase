'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ClockSync } from '@/lib/clock-sync'
import { CLOCK_PING_INTERVAL_MS, DIAGNOSTICS_INTERVAL_MS } from '@/lib/protocol'

export interface ClockDiagnostics {
  trusted: boolean
  offsetMs: number
  minRttMs: number
  worstCaseErrorMs: number
  stepsDetected: number
  samples: number
}

/**
 * Owns the session's shared-time estimate.
 *
 * Two things are deliberate. The `ClockSync` instance lives in a ref and the hot
 * accessors (`now`, `isTrusted`) are stable for the hook's lifetime, so the
 * correction loop can close over them without restarting on every estimate. And
 * diagnostics are pushed into React state on a slow, separate interval, because
 * routing a clock estimate through render state five times a second for ninety
 * minutes is how this integration goes wrong in practice.
 *
 * `skewMs` deliberately breaks the machine's wall clock, so the claim that a wrong
 * laptop clock cannot corrupt a timestamp is falsifiable rather than asserted.
 */
export function useClockSync(skewMs = 0) {
  const clockRef = useRef<ClockSync | null>(null)
  const skewRef = useRef(skewMs)
  skewRef.current = skewMs

  if (!clockRef.current) {
    clockRef.current = new ClockSync({
      wallNow: () => Date.now() + skewRef.current,
    })
  }

  const [diagnostics, setDiagnostics] = useState<ClockDiagnostics>({
    trusted: false,
    offsetMs: 0,
    minRttMs: 0,
    worstCaseErrorMs: 0,
    stepsDetected: 0,
    samples: 0,
  })

  useEffect(() => {
    const clock = clockRef.current!
    let cancelled = false

    const ping = async () => {
      const pendingPing = clock.send()
      try {
        const response = await fetch('/api/clock', { cache: 'no-store' })
        const { ts } = (await response.json()) as { ts: number }
        if (!cancelled) clock.receive(pendingPing, ts)
      } catch {
        // A failed exchange is not an error condition: the last estimate stands
        // and `isTrusted()` already reports whether it can be acted on.
      }
    }

    // Burst on connect so the estimate converges before the operator does
    // anything, then settle into the steady cadence.
    void ping()
    const burst = [400, 900, 1600].map((delay) => setTimeout(() => void ping(), delay))
    const interval = setInterval(() => void ping(), CLOCK_PING_INTERVAL_MS)

    const diagnosticsTimer = setInterval(() => {
      setDiagnostics({
        trusted: clock.isTrusted(),
        offsetMs: clock.offsetMs(),
        minRttMs: clock.minRttMs(),
        worstCaseErrorMs: clock.worstCaseErrorMs(),
        stepsDetected: clock.stepsDetected(),
        samples: clock.sampleCount(),
      })
    }, DIAGNOSTICS_INTERVAL_MS * 3)

    return () => {
      cancelled = true
      burst.forEach(clearTimeout)
      clearInterval(interval)
      clearInterval(diagnosticsTimer)
    }
  }, [])

  /**
   * Stable for the hook's lifetime *by construction* — they read through the ref
   * rather than closing over an estimate. The correction loop depends on these, so
   * a changing identity here would tear the loop down and rebuild it roughly once
   * a second.
   */
  const now = useCallback(() => clockRef.current!.now(), [])
  const isTrusted = useCallback(() => clockRef.current!.isTrusted(), [])

  return { diagnostics, now, isTrusted }
}
