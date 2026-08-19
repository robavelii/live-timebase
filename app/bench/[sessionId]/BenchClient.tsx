'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useClockSync } from '@/hooks/useClockSync'
import { useFollower } from '@/hooks/useFollower'
import { useImpairedTransport } from '@/hooks/useImpairedTransport'
import { useMediaSource } from '@/hooks/useMediaSource'
import { useSyncwaveFollower } from '@/hooks/useSyncwaveFollower'
import { IMPAIRMENT_PRESETS } from '@/lib/impair'
import { EMPTY_METRICS, MetricsAccumulator, type Metrics, type SamplePoint } from '@/lib/metrics'
import { DEFAULT_SYNCWAVE_DEFECTS, type SyncwaveDefectFlags } from '@/lib/syncwave'
import {
  BENCH_JOIN_GAP_MS,
  BENCH_SAMPLE_INTERVAL_MS,
  type ImpairmentConfig,
} from '@/lib/protocol'
import { DriftChart } from '@/components/DriftChart'
import { ImpairmentPanel } from '@/components/ImpairmentPanel'
import { MetricsTable } from '@/components/MetricsTable'
import Link from 'next/link'

const SKIP_SECONDS = 10
const LIVE_EDGE_OFFSET_MS = 6_000
const PUBLISH_METRICS_MS = 500
/** The `syncwave-webrtc` host's snapshot cadence. */
const SYNCWAVE_SNAPSHOT_MS = 2_000

/**
 * Head-to-head, on live.
 *
 * The scenario is the one that actually happens: a second collector joins some
 * seconds after the first, so their players have different `currentTime` origins for
 * the same picture. Both followers are given **the same** offset buffer and **the
 * same** impaired message stream — the only thing that differs is what they do with
 * a message.
 *
 * Error is measured against program-date-time: the distance between the picture a
 * follower is showing and the picture the lead is showing, in absolute time. Measuring
 * playhead-against-playhead instead is the mistake being examined, and would score
 * command mirroring as flawless while it displayed a moment ten seconds adrift.
 */
export function BenchClient({ sessionId, src }: { sessionId: string; src: string }) {
  const leadRef = useRef<HTMLVideoElement>(null)
  const timebaseRef = useRef<HTMLVideoElement>(null)
  const syncwaveRef = useRef<HTMLVideoElement>(null)

  const [joinGapMs, setJoinGapMs] = useState(BENCH_JOIN_GAP_MS)
  const [followersJoined, setFollowersJoined] = useState(false)
  const [started, setStarted] = useState(false)
  const [visible, setVisible] = useState(true)
  const [config, setConfig] = useState<ImpairmentConfig>(IMPAIRMENT_PRESETS.clean!)
  const [defects, setDefects] = useState<SyncwaveDefectFlags>(DEFAULT_SYNCWAVE_DEFECTS)
  const [publishError, setPublishError] = useState<string | null>(null)

  const clock = useClockSync(0)
  const leadMedia = useMediaSource(leadRef, src)
  // Empty src keeps the follower players unattached, which is how the join gap is
  // produced: hls.js assigns fragment start times relative to the window it first
  // loaded, so an instance created later has a different origin for the same picture.
  const followerSrc = followersJoined ? src : ''
  const timebaseMedia = useMediaSource(timebaseRef, followerSrc)
  const syncwaveMedia = useMediaSource(syncwaveRef, followerSrc)

  const channel = useImpairedTransport(sessionId, config)

  const timebaseMetrics = useRef(new MetricsAccumulator())
  const syncwaveMetrics = useRef(new MetricsAccumulator())
  const [snapshot, setSnapshot] = useState<{ timebase: Metrics; syncwave: Metrics }>({
    timebase: EMPTY_METRICS,
    syncwave: EMPTY_METRICS,
  })
  const [history, setHistory] = useState<{
    timebase: readonly SamplePoint[]
    syncwave: readonly SamplePoint[]
  }>({ timebase: [], syncwave: [] })

  const followersActive = started && followersJoined

  /**
   * The lead follows the session too.
   *
   * This matches the real console, where publishing an intent does not exempt you from
   * the state you published — and it removes a confound that made the bench misleading.
   * An unmanaged lead plays at whatever rate its decoder actually achieves, so it drifts
   * slowly away from the anchor it published. Since error is measured follower-against-
   * lead, that drift was being attributed to the followers: a steady 240 ms appeared under
   * impairment with the followers making no corrections at all, which is the signature of
   * the reference moving rather than the thing being measured.
   */
  const leadFollower = useFollower({
    videoRef: leadRef,
    transportRef: channel.transportRef,
    sessionNow: clock.now,
    clockTrusted: clock.isTrusted,
    toMedia: leadMedia.toMedia,
    seekableRange: leadMedia.seekableRange,
    enabled: started,
    visible,
  })

  const timebaseFollower = useFollower({
    videoRef: timebaseRef,
    transportRef: channel.transportRef,
    sessionNow: clock.now,
    clockTrusted: clock.isTrusted,
    toMedia: timebaseMedia.toMedia,
    seekableRange: timebaseMedia.seekableRange,
    enabled: followersActive,
    visible,
  })

  const syncwaveFollower = useSyncwaveFollower({
    videoRef: syncwaveRef,
    msgRef: channel.syncwaveMsgRef,
    seqRef: channel.syncwaveSeqRef,
    enabled: followersActive && visible,
    defects,
  })

  /**
   * The host snapshot every two seconds, carrying the lead's *current* playhead — which
   * is what `syncwave-webrtc` does alongside mirroring its element's DOM events.
   */
  const publishSnapshot = channel.publishSyncwaveSnapshot
  useEffect(() => {
    if (!started) return
    const snapshots = setInterval(() => {
      const video = leadRef.current
      if (!video || video.readyState < 1) return
      publishSnapshot(video.currentTime, video.paused, video.playbackRate)
    }, SYNCWAVE_SNAPSHOT_MS)
    return () => clearInterval(snapshots)
  }, [started, publishSnapshot])

  const timebaseKindRef = useRef('idle')
  timebaseKindRef.current = timebaseFollower.diagnostics.kind
  const syncwaveKindRef = useRef('idle')
  syncwaveKindRef.current = syncwaveFollower.diagnostics.kind

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  /**
   * Join once, and only once the playlist has said what it is.
   *
   * Joining earlier creates the session in whatever mode the default happens to be,
   * and the mode is then fixed — so every intent the lead publishes afterwards is
   * refused as being in the wrong units, the transport never leaves its initial
   * paused-at-zero state, and both followers sit at the start of their buffers looking
   * exactly like a broken follower loop. The units check is what made that legible
   * instead of mysterious; the fix is to not join early.
   */
  const joinedRef = useRef(false)
  useEffect(() => {
    if (!leadMedia.info.detected || joinedRef.current) return
    joinedRef.current = true
    void fetch(`/api/sessions/${sessionId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'home',
        mode: leadMedia.mode,
        src,
        takeLead: true,
        fingerprint: leadMedia.fingerprint(),
      }),
    }).catch(() => {
      joinedRef.current = false
    })
  }, [sessionId, src, leadMedia.info.detected, leadMedia.mode, leadMedia.fingerprint])

  // ─── The sampler ─────────────────────────────────────────────────────────

  const readStamps = useRef({
    lead: leadMedia.readStamp,
    timebase: timebaseMedia.readStamp,
    syncwave: syncwaveMedia.readStamp,
  })
  readStamps.current = {
    lead: leadMedia.readStamp,
    timebase: timebaseMedia.readStamp,
    syncwave: syncwaveMedia.readStamp,
  }

  useEffect(() => {
    if (!followersActive || !visible) return
    const sampler = setInterval(() => {
      const lead = readStamps.current.lead()
      if (lead.pdtSource === 'none' || lead.programDateTime === null) return
      const at = Date.now()

      const timebase = readStamps.current.timebase()
      if (timebase.pdtSource !== 'none' && timebase.programDateTime !== null) {
        timebaseMetrics.current.record(
          timebase.programDateTime - lead.programDateTime,
          timebaseKindRef.current,
          at,
        )
      }

      const syncwave = readStamps.current.syncwave()
      if (syncwave.pdtSource !== 'none' && syncwave.programDateTime !== null) {
        syncwaveMetrics.current.record(
          syncwave.programDateTime - lead.programDateTime,
          syncwaveKindRef.current,
          at,
        )
      }
    }, BENCH_SAMPLE_INTERVAL_MS)
    return () => clearInterval(sampler)
  }, [followersActive, visible])

  /**
   * Pane readouts are captured here rather than during render. `readStamp()` counts
   * stale reads, so calling it from a render pass would make a diagnostic count depend
   * on how often React happened to re-render.
   */
  const [readouts, setReadouts] = useState<
    { key: string; currentTime: number | null; pdt: number | null }[]
  >([])

  const channelStatsRef = channel.statsRef

  // Empty dependencies on purpose. Listing `channel.stats` here rebuilt this effect
  // every 300 ms — faster than its own 500 ms timer could fire, so nothing was ever
  // published and every metric read as zero while both followers were working
  // perfectly. The channel numbers come through a ref for exactly this reason.
  useEffect(() => {
    const publish = setInterval(() => {
      const channelStats = channelStatsRef.current
      timebaseMetrics.current.recordChannel(channelStats.delivered, channelStats.dropped)
      syncwaveMetrics.current.recordChannel(channelStats.delivered, channelStats.dropped)
      setSnapshot({
        timebase: timebaseMetrics.current.snapshot(),
        syncwave: syncwaveMetrics.current.snapshot(),
      })
      setHistory({
        timebase: timebaseMetrics.current.getHistory(),
        syncwave: syncwaveMetrics.current.getHistory(),
      })
      setReadouts([
        { key: 'lead', currentTime: leadRef.current?.currentTime ?? null, pdt: readStamps.current.lead().programDateTime },
        { key: 'timebase', currentTime: timebaseRef.current?.currentTime ?? null, pdt: readStamps.current.timebase().programDateTime },
        { key: 'syncwave', currentTime: syncwaveRef.current?.currentTime ?? null, pdt: readStamps.current.syncwave().programDateTime },
      ])
    }, PUBLISH_METRICS_MS)
    return () => clearInterval(publish)
  }, [channelStatsRef])

  const resetMetrics = useCallback(() => {
    timebaseMetrics.current.reset()
    syncwaveMetrics.current.reset()
    timebaseFollower.resetMetrics()
    leadFollower.resetMetrics()
    syncwaveFollower.reset()
  }, [timebaseFollower, leadFollower, syncwaveFollower])

  // ─── Lead controls ───────────────────────────────────────────────────────

  const leadShared = useCallback((): number | null => {
    const video = leadRef.current
    if (!video) return null
    if (leadMedia.mode !== 'live') return video.currentTime
    const notStarted = video.readyState < 3 || video.currentTime === 0
    const reading = notStarted ? null : leadMedia.toPdt(video.currentTime)
    if (reading) return reading.pdt
    const latest = leadMedia.latestPdt()
    return latest === null ? null : latest - LIVE_EDGE_OFFSET_MS
  }, [leadMedia])

  const publish = useCallback(
    async (reason: 'play' | 'pause' | 'seek', state: 'playing' | 'paused', anchor: number) => {
      const response = await fetch(`/api/sessions/${sessionId}/transport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: 'home',
          reason,
          state,
          rate: 1,
          anchor,
          mode: leadMedia.mode,
          leadMediaTime: leadRef.current?.currentTime ?? null,
        }),
      })
      // Surfaced rather than swallowed: a silently refused intent looks identical to a
      // broken follower loop, and it cost an afternoon once already.
      if (!response.ok) {
        setPublishError(
          `Intent refused (${response.status}). ` +
            (response.status === 409
              ? 'This page and the session disagree about whether the source is live.'
              : 'Check the session lead.'),
        )
      } else {
        setPublishError(null)
      }
    },
    [sessionId, leadMedia.mode],
  )

  const start = useCallback(async () => {
    const video = leadRef.current
    if (!video) return
    try {
      await video.play()
    } catch {
      /* muted, so this should not happen */
    }
    setStarted(true)
    const anchor = leadShared()
    if (anchor !== null) await publish('play', 'playing', anchor)
    // The gap is the experiment: the followers join later, so their buffers differ.
    window.setTimeout(() => setFollowersJoined(true), joinGapMs)
  }, [leadShared, publish, joinGapMs])

  const skip = useCallback(
    async (seconds: number) => {
      const anchor = leadShared()
      if (anchor === null) return
      const delta = leadMedia.mode === 'live' ? seconds * 1000 : seconds
      await publish('seek', 'playing', anchor + delta)
    },
    [leadShared, publish, leadMedia.mode],
  )

  const jumpToLive = useCallback(async () => {
    const latest = leadMedia.latestPdt()
    if (latest === null) return
    await publish('seek', 'playing', latest - LIVE_EDGE_OFFSET_MS)
  }, [leadMedia, publish])

  /** Read-only bridge, for `scripts/bench-check.mjs`. See the note in the console. */
  useEffect(() => {
    const bridge = {
      metrics: () => snapshot,
      /**
       * True correction counts, straight from each follower. The metrics table's
       * reposition row is derived from sample labels, so one reposition spanning two
       * 100 ms samples shows up as two — fine for a proportion on screen, not for an
       * assertion.
       */
      corrections: () => ({
        timebase: {
          repositions: timebaseFollower.diagnostics.seeks,
          nudges: timebaseFollower.diagnostics.nudges,
        },
        syncwave: { repositions: syncwaveFollower.diagnostics.hardSeeks, nudges: 0 },
      }),
      readouts: () => readouts,
      state: () => ({ started, followersJoined, joinGapMs, config, defects }),
      media: () => ({
        lead: leadMedia.info,
        timebase: timebaseMedia.info,
        syncwave: syncwaveMedia.info,
      }),
      setPreset: (preset: ImpairmentConfig) => setConfig(preset),
      setDefects: (next: SyncwaveDefectFlags) => setDefects(next),
      dropNext: (count: number) => channel.dropNext(count),
      joinFollowers: () => setFollowersJoined(true),
    }
    ;(window as unknown as { __bench?: typeof bridge }).__bench = bridge
  }, [
    snapshot,
    readouts,
    started,
    followersJoined,
    joinGapMs,
    config,
    defects,
    channel,
    leadMedia.info,
    timebaseMedia.info,
    syncwaveMedia.info,
    timebaseFollower.diagnostics,
    syncwaveFollower.diagnostics,
  ])

  const pdtOf = (stamp: number | null) =>
    stamp === null ? '—' : new Date(stamp).toISOString().slice(11, 23)
  const readout = (key: string) => readouts.find((entry) => entry.key === key)
  const latestError = (series: readonly SamplePoint[], samples: number) =>
    samples ? `${(series.at(-1)?.errorMs ?? 0).toFixed(0)} ms` : '—'

  const panes = [
    {
      key: 'lead',
      title: 'Lead — collector A',
      accent: '',
      ref: leadRef,
      subtitle: 'publishes intent · follows the session like any console',
      status: `pdt ${pdtOf(readout('lead')?.pdt ?? null)} · ${leadFollower.diagnostics.kind}`,
    },
    {
      key: 'timebase',
      title: 'Timebase — collector B',
      accent: 'ok',
      ref: timebaseRef,
      subtitle: 'derives its own position from the shared coordinate',
      status: `error ${latestError(history.timebase, snapshot.timebase.samples)} · ${timebaseFollower.diagnostics.kind}`,
    },
    {
      key: 'syncwave',
      title: 'Command mirroring — collector B',
      accent: 'bad',
      ref: syncwaveRef,
      subtitle: "applies the lead's playhead directly",
      status: `error ${latestError(history.syncwave, snapshot.syncwave.samples)} · ${syncwaveFollower.diagnostics.kind}`,
    },
  ]

  return (
    <main className="grid" style={{ gap: 14 }}>
      <header className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <p className="eyebrow">
            Bench · {channel.connected ? 'connected' : 'reconnecting'} ·{' '}
            {followersJoined ? 'followers joined' : `followers join ${joinGapMs / 1000}s after play`}
          </p>
          <h1>
            Timebase vs command mirroring{' '}
            <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>
              {leadMedia.info.live ? 'live' : 'recorded'}
            </span>
          </h1>
        </div>
        <Link href={`/collect/${sessionId}?role=home&src=${encodeURIComponent(src)}`}>
          collector console
        </Link>
      </header>

      {leadMedia.info.unsupported ? (
        <div className="banner bad">
          <strong>This browser cannot run the bench.</strong> {leadMedia.info.unsupported}
        </div>
      ) : null}

      {publishError ? <div className="banner bad">{publishError}</div> : null}

      <div className="panel">
        <div className="row">
          {!started ? (
            <button
              className="primary"
              onClick={() => void start()}
              disabled={!leadMedia.info.detected || leadMedia.info.unsupported !== null}
            >
              {leadMedia.info.detected ? 'Play lead' : 'Identifying source…'}
            </button>
          ) : (
            <>
              <button onClick={() => void skip(-SKIP_SECONDS)}>−{SKIP_SECONDS}s</button>
              <button onClick={() => void skip(SKIP_SECONDS)}>+{SKIP_SECONDS}s</button>
              {leadMedia.info.live ? (
                <button onClick={() => void jumpToLive()}>Jump to live</button>
              ) : null}
            </>
          )}
          {started && !followersJoined ? (
            <button onClick={() => setFollowersJoined(true)}>Join followers now</button>
          ) : null}
          <button onClick={resetMetrics}>Reset metrics</button>
          <label className="row muted" style={{ fontSize: 12, gap: 6 }}>
            join gap
            <input
              type="range"
              min={0}
              max={30000}
              step={1000}
              value={joinGapMs}
              onChange={(event) => setJoinGapMs(Number(event.target.value))}
              disabled={started}
              style={{ width: 120 }}
            />
            <span className="mono">{joinGapMs / 1000}s</span>
          </label>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
          Three hls.js players on one page pull the stream three times. That is fine locally;
          it is not how two collectors would be deployed.
        </p>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        {panes.map((pane) => (
          <div className="panel" key={pane.key}>
            <h2 className={pane.accent}>{pane.title}</h2>
            <video ref={pane.ref} muted playsInline />
            <p className="muted" style={{ fontSize: 11, margin: '8px 0 2px' }}>
              {pane.subtitle}
            </p>
            <div className="mono" style={{ fontSize: 12 }}>
              currentTime {readout(pane.key)?.currentTime?.toFixed(3) ?? '—'}
            </div>
            <div className="mono" style={{ fontSize: 12 }}>
              {pane.status}
            </div>
          </div>
        ))}
      </div>

      <div className="grid two">
        <div className="panel">
          <h2>Error against program-date-time</h2>
          <DriftChart timebase={history.timebase} syncwave={history.syncwave} />
        </div>
        <div className="panel">
          <h2>Impairment</h2>
          <ImpairmentPanel
            config={config}
            onConfig={setConfig}
            defects={defects}
            onDefects={setDefects}
            onDropNext={channel.dropNext}
            stats={channel.stats}
          />
        </div>
      </div>

      <div className="panel">
        <h2>Measured</h2>
        <MetricsTable timebase={snapshot.timebase} syncwave={snapshot.syncwave} />
      </div>

      <div className="panel">
        <h2>What to do, in order</h2>
        <ol className="muted" style={{ margin: 0, paddingLeft: 18, maxWidth: 780, fontSize: 13 }}>
          <li>
            <strong>Press Play lead and wait for the followers to join.</strong> Watch the three
            <span className="mono"> currentTime</span> readings diverge while the burned-in
            timecodes on the lead and the timebase pane stay identical.
          </li>
          <li>
            <strong>Read the p95 row.</strong> Command mirroring is out by roughly the join gap,
            permanently, on a clean network. It is not a tuning problem — the message it receives
            does not contain the information it would need.
          </li>
          <li>
            <strong>Look at &ldquo;duel window eaten&rdquo;.</strong> Anything approaching 100%
            means two collectors&apos; observations of one contest will not pair.
          </li>
          <li>
            <strong>Switch impairment to Lossy WAN, then Drop next 5, then seek.</strong> The
            timebase follower closes the gap on the next heartbeat with no visible jump; the
            mirror stays on the wrong segment until a snapshot arrives and then jumps.
          </li>
          <li>
            <strong>Turn all four defect toggles off.</strong> The gap that remains is the one
            that is not a bug.
          </li>
        </ol>
      </div>
    </main>
  )
}
