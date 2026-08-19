'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ImpairmentScheduler } from '@/lib/impair'
import { intentToSyncwaveMsg, type SyncwaveMsg } from '@/lib/syncwave'
import { shouldAcceptTransport } from '@/lib/timebase'
import { DIAGNOSTICS_INTERVAL_MS, type ImpairmentConfig, type Transport } from '@/lib/protocol'

const POLL_INTERVAL_MS = 25

/**
 * Host snapshots are numbered above the transport messages so the two streams cannot
 * collide on a sequence number — which would make the seeded impairment treat two
 * different messages as the same one.
 */
const SNAPSHOT_SEQ_BASE = 1_000_000

/**
 * One subscription, two impaired copies of it.
 *
 * The comparison is only worth anything if both followers suffer exactly the same
 * network. So messages are numbered as they arrive and each copy is scheduled by a
 * scheduler seeded identically — `decideImpairment` keys on the sequence number, not
 * on call order, so both agree on what happened to message 47 no matter when they
 * poll. A run where one follower happened to lose a different message proves nothing.
 *
 * The wire sequence is assigned here rather than taken from `(epoch, sequence)`
 * because an intent resets `sequence` to zero, so two different messages can carry
 * the same one. What is needed is a count of deliveries, which is a client-side fact.
 */
export function useImpairedTransport(sessionId: string, config: ImpairmentConfig) {
  const [connected, setConnected] = useState(false)

  /** What the timebase follower reads. */
  const transportRef = useRef<Transport | null>(null)
  /** What the command-mirroring follower reads. */
  const syncwaveMsgRef = useRef<SyncwaveMsg | null>(null)
  const syncwaveSeqRef = useRef(0)
  const snapshotSeqRef = useRef(0)

  const [transport, setTransport] = useState<Transport | null>(null)
  const [stats, setStats] = useState({ delivered: 0, dropped: 0, inFlight: 0 })
  /**
   * The same numbers, reachable without subscribing to them. A consumer that wants
   * these inside a long-lived interval must not depend on the state object: it gets a
   * fresh identity several times a second, and an effect that lists it as a dependency
   * is torn down and rebuilt faster than its own timer can fire.
   */
  const statsRef = useRef({ delivered: 0, dropped: 0, inFlight: 0 })

  const timebaseScheduler = useRef<ImpairmentScheduler<Transport> | null>(null)
  const syncwaveScheduler = useRef<ImpairmentScheduler<SyncwaveMsg> | null>(null)
  timebaseScheduler.current ??= new ImpairmentScheduler<Transport>(config)
  syncwaveScheduler.current ??= new ImpairmentScheduler<SyncwaveMsg>(config)

  useEffect(() => {
    timebaseScheduler.current!.updateConfig(config)
    syncwaveScheduler.current!.updateConfig(config)
  }, [config])

  useEffect(() => {
    const source = new EventSource(`/api/sessions/${sessionId}/stream`)
    let wireSeq = 0

    const ingest = (incoming: Transport) => {
      const seq = ++wireSeq
      const now = Date.now()
      timebaseScheduler.current!.enqueue(incoming, seq, now)

      // Only *commands* are derived from the transport. Snapshots come from the host's
      // live playhead via `publishSyncwaveSnapshot` — a heartbeat carries whatever
      // position the host last published an intent at, and mirroring that would grow
      // staler every beat for reasons that have nothing to do with the approach.
      if (incoming.reason === 'join' || incoming.reason === 'heartbeat') return

      // What a command-mirroring host actually puts on the wire: its own playhead. On
      // live that is not a coordinate the follower shares, which is the entire finding.
      syncwaveScheduler.current!.enqueue(
        intentToSyncwaveMsg(
          incoming.reason,
          incoming.leadMediaTime ?? 0,
          incoming.state === 'paused',
          incoming.rate,
          seq,
          incoming.anchorServerTime,
        ),
        seq,
        now,
      )
    }

    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    source.onmessage = (raw) => {
      const message = JSON.parse(raw.data) as {
        type: string
        transport?: Transport
        snapshot?: { transport: Transport }
      }
      if (message.type === 'snapshot' && message.snapshot) ingest(message.snapshot.transport)
      if (message.type === 'transport' && message.transport) ingest(message.transport)
      setConnected(true)
    }

    const pump = setInterval(() => {
      const now = Date.now()
      for (const delivered of timebaseScheduler.current!.poll(now)) {
        if (shouldAcceptTransport(delivered, transportRef.current)) {
          transportRef.current = delivered
        }
      }
      for (const delivered of syncwaveScheduler.current!.poll(now)) {
        // Deliberately no ordering check here by default — see
        // `SyncwaveDefectFlags.noSequence`. The follower applies what arrives.
        syncwaveMsgRef.current = delivered
        syncwaveSeqRef.current++
      }
    }, POLL_INTERVAL_MS)

    const publish = setInterval(() => {
      setTransport(transportRef.current)
      const current = timebaseScheduler.current!.stats()
      statsRef.current = current
      setStats(current)
    }, DIAGNOSTICS_INTERVAL_MS)

    return () => {
      clearInterval(pump)
      clearInterval(publish)
      source.close()
    }
  }, [sessionId])

  const dropNext = useCallback((count: number) => {
    timebaseScheduler.current!.dropNext(count)
    syncwaveScheduler.current!.dropNext(count)
  }, [])

  /**
   * A host snapshot, carrying the host's position *now*.
   *
   * The `syncwave-webrtc` host mirrors its element's DOM events and additionally emits a
   * snapshot every two seconds. Deriving those snapshots from the transport heartbeat
   * instead would re-send whatever position the host was at when it last published an
   * intent — which grows staler every beat and made the comparison unfairly bad. The
   * host has its own playhead to hand, so it sends that, and the remaining gap is the
   * structural one rather than an artefact of the port.
   */
  const publishSyncwaveSnapshot = useCallback(
    (time: number, paused: boolean, rate: number) => {
      const seq = ++snapshotSeqRef.current
      syncwaveScheduler.current!.enqueue(
        { type: 'state', time, paused, rate, at: Date.now(), seq: SNAPSHOT_SEQ_BASE + seq },
        SNAPSHOT_SEQ_BASE + seq,
        Date.now(),
      )
    },
    [],
  )

  return {
    connected,
    transport,
    transportRef,
    syncwaveMsgRef,
    syncwaveSeqRef,
    stats,
    statsRef,
    dropNext,
    publishSyncwaveSnapshot,
  }
}
