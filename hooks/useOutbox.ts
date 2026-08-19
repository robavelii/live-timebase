'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { acknowledge, enqueue, pending } from '@/lib/outbox'
import type { CollectedEvent, DuelPair } from '@/lib/protocol'

export interface AckInfo {
  status: 'stored' | 'replayed'
  serverReceivedAt: number
  /** serverReceivedAt − clientSubmittedAt. The number everyone worries about. */
  wireLagMs: number
}

const FLUSH_INTERVAL_MS = 1_500

/**
 * Append locally, flush in the background.
 *
 * The point being demonstrated: the event's time was fixed at the keystroke and
 * never travels, so how long the flush takes — or whether it happens at all for
 * the next ten minutes — cannot change the data. `wireLagMs` is displayed only so
 * that this is visible rather than asserted.
 *
 * `simulateOffline` holds the flush without touching the queue, which is the
 * cheapest honest way to demonstrate the property in a meeting.
 */
export function useOutbox(
  sessionId: string,
  options: {
    simulateOffline: boolean
    /** Artificial delay before the flush leaves the browser. Demo control. */
    delayMs?: number
    onDuel?: (duel: DuelPair) => void
  },
) {
  const [queued, setQueued] = useState(0)
  const [acks, setAcks] = useState<Record<string, AckInfo>>({})
  const [lastError, setLastError] = useState<string | null>(null)
  const flushingRef = useRef(false)
  const offlineRef = useRef(options.simulateOffline)
  offlineRef.current = options.simulateOffline
  const delayRef = useRef(options.delayMs ?? 0)
  delayRef.current = options.delayMs ?? 0
  const onDuelRef = useRef(options.onDuel)
  onDuelRef.current = options.onDuel
  const deviceSequenceRef = useRef(0)

  const refreshCount = useCallback(async () => {
    setQueued((await pending()).length)
  }, [])

  const flush = useCallback(async () => {
    if (flushingRef.current || offlineRef.current) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) return
    flushingRef.current = true
    try {
      const batch = await pending()
      if (batch.length === 0) return
      if (delayRef.current > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayRef.current))
      }
      const response = await fetch(`/api/sessions/${sessionId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch.slice(0, 500) }),
      })
      if (!response.ok) {
        setLastError(`ingest ${response.status}`)
        return
      }
      const { results } = (await response.json()) as {
        results: {
          clientEventId: string
          status: 'stored' | 'replayed'
          serverReceivedAt: number
          duel: DuelPair | null
        }[]
      }
      const submittedAt = new Map(batch.map((e) => [e.clientEventId, e.clientSubmittedAt]))
      setAcks((current) => {
        const next = { ...current }
        for (const result of results) {
          next[result.clientEventId] = {
            status: result.status,
            serverReceivedAt: result.serverReceivedAt,
            wireLagMs: result.serverReceivedAt - (submittedAt.get(result.clientEventId) ?? 0),
          }
        }
        return next
      })
      for (const result of results) {
        if (result.duel) onDuelRef.current?.(result.duel)
      }
      await acknowledge(results.map((r) => r.clientEventId))
      setLastError(null)
      await refreshCount()
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'flush failed')
    } finally {
      flushingRef.current = false
    }
  }, [sessionId, refreshCount])

  useEffect(() => {
    void refreshCount()
    const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [flush, refreshCount])

  /** Append one event. Resolves as soon as it is durable locally, not on ack. */
  const submit = useCallback(
    async (
      event: Omit<CollectedEvent, 'deviceSequence' | 'clientSubmittedAt'>,
    ): Promise<CollectedEvent> => {
      const complete: CollectedEvent = {
        ...event,
        deviceSequence: ++deviceSequenceRef.current,
        clientSubmittedAt: Date.now(),
      }
      await enqueue(complete)
      await refreshCount()
      void flush()
      return complete
    },
    [flush, refreshCount],
  )

  return { submit, queued, acks, lastError, flush }
}
