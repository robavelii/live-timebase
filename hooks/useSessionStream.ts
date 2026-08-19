'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { shouldAcceptTransport } from '@/lib/timebase'
import type {
  CollectedEvent,
  CollectorRole,
  DuelPair,
  PresencePeer,
  SessionSnapshot,
  Transport,
} from '@/lib/protocol'

interface StreamMessage {
  type: 'snapshot' | 'transport' | 'peers' | 'event' | 'duel' | 'mode'
  snapshot?: SessionSnapshot
  transport?: Transport
  peers?: PresencePeer[]
  lead?: CollectorRole | null
  event?: CollectedEvent
  duel?: DuelPair
  mode?: string
  src?: string
}

/**
 * Subscribes to the session's server-sent stream.
 *
 * The accepted transport is held in a **ref**, which is what the correction loop
 * reads. It is mirrored into state only so the diagnostics panel can show the
 * epoch and anchors; nothing in the hot path depends on that copy.
 *
 * `shouldAcceptTransport` is applied here rather than in the follower so that a
 * stale message never reaches anything. On a reconnect the browser replays the
 * snapshot, which may well be older than what we already hold.
 */
export function useSessionStream(sessionId: string) {
  const transportRef = useRef<Transport | null>(null)
  const [transport, setTransport] = useState<Transport | null>(null)
  const [connected, setConnected] = useState(false)
  const [peers, setPeers] = useState<PresencePeer[]>([])
  const [lead, setLead] = useState<CollectorRole | null>(null)
  const [duels, setDuels] = useState<DuelPair[]>([])
  const [peerEvents, setPeerEvents] = useState<CollectedEvent[]>([])

  const accept = useCallback((incoming: Transport) => {
    if (!shouldAcceptTransport(incoming, transportRef.current)) return
    transportRef.current = incoming
    setTransport(incoming)
  }, [])

  useEffect(() => {
    const source = new EventSource(`/api/sessions/${sessionId}/stream`)

    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    source.onmessage = (raw) => {
      const message = JSON.parse(raw.data) as StreamMessage
      switch (message.type) {
        case 'snapshot':
          if (message.snapshot) {
            accept(message.snapshot.transport)
            setPeers(message.snapshot.peers)
            setDuels(message.snapshot.duels)
          }
          setConnected(true)
          break
        case 'transport':
          if (message.transport) accept(message.transport)
          break
        case 'peers':
          setPeers(message.peers ?? [])
          setLead(message.lead ?? null)
          break
        case 'duel':
          if (message.duel) setDuels((current) => [...current, message.duel!])
          break
        case 'event':
          if (message.event) {
            setPeerEvents((current) => [...current.slice(-199), message.event!])
          }
          break
        default:
          break
      }
    }

    return () => source.close()
  }, [sessionId, accept])

  return { connected, transport, transportRef, peers, lead, duels, peerEvents }
}
