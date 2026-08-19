'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Hls, { Events, type FragChangedData, type LevelUpdatedData } from 'hls.js'
import { FrameClock } from '@/lib/frame-clock'
import { PdtMap, type PdtHealth } from '@/lib/pdt'
import { DIAGNOSTICS_INTERVAL_MS, type SessionMode, type StreamFingerprint } from '@/lib/protocol'
import type { Stamp } from '@/lib/event-timer'

export interface SourceNotice {
  at: number
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface MediaInfo {
  /**
   * Has the source told us what it is yet? `live` is meaningless before this, and
   * announcing a mode to the session on the strength of a default is how a session
   * ends up in the wrong one.
   */
  detected: boolean
  /** Did the playlist declare itself live? */
  live: boolean
  /** Are we going through hls.js, or straight at the element? */
  engine: 'hls.js' | 'native'
  /** Is `requestVideoFrameCallback` available on this platform? */
  frameCallbacks: boolean
  targetDuration: number
  pdt: PdtHealth
  staleReads: number
  /**
   * Non-null when this browser cannot collect. Chrome is the only supported
   * browser, and the two things it provides that the alternatives do not —
   * `requestVideoFrameCallback` and Media Source Extensions for hls.js — are both
   * load-bearing rather than nice to have. Refusing up front beats producing a
   * match of quietly degraded data.
   */
  unsupported: string | null
}

const EMPTY_HEALTH: PdtHealth = {
  present: false,
  anchors: 0,
  cc: null,
  discontinuities: 0,
  pdtBreaks: 0,
  coverage: null,
}

/**
 * Owns the media element: the player engine, the frame clock, and the mapping
 * between this client's media positions and the stream's absolute timeline.
 *
 * The mapping is the part that matters. Everything else in this app could be
 * copied from the recorded-footage design unchanged; live needs this, because
 * `currentTime` on a live playlist is a coordinate in *this client's* buffer and
 * two collectors on the same URL routinely sit seconds apart in it.
 */
export function useMediaSource(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  src: string,
) {
  const pdtRef = useRef<PdtMap | null>(null)
  const frameRef = useRef<FrameClock | null>(null)
  pdtRef.current ??= new PdtMap()
  frameRef.current ??= new FrameClock()

  const [info, setInfo] = useState<MediaInfo>({
    detected: false,
    live: false,
    engine: 'native',
    frameCallbacks: false,
    targetDuration: 0,
    pdt: EMPTY_HEALTH,
    staleReads: 0,
    unsupported: null,
  })
  const [notices, setNotices] = useState<SourceNotice[]>([])
  const unsupportedRef = useRef<string | null>(null)
  const detectedRef = useRef(false)
  const liveRef = useRef(false)
  const engineRef = useRef<'hls.js' | 'native'>('native')
  const targetDurationRef = useRef(0)

  const notice = useCallback((level: SourceNotice['level'], text: string) => {
    setNotices((current) => [...current.slice(-19), { at: Date.now(), level, text }])
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return

    const pdtMap = pdtRef.current!
    const frameClock = frameRef.current!
    pdtMap.reset()
    frameClock.attach(video)
    detectedRef.current = false
    unsupportedRef.current = null

    if (!frameClock.frameCallbackSupported()) {
      unsupportedRef.current =
        'This browser has no requestVideoFrameCallback, so an event cannot be stamped ' +
        'against the frame that was actually on screen. Collect in Chrome.'
      notice('error', unsupportedRef.current)
    }

    // Extension matching alone is not enough: signed and tokenised live URLs
    // frequently have no `.m3u8` suffix, and those are exactly the URLs a
    // broadcaster hands you. `?type=m3u8` is the explicit override.
    const looksLikeHls = /\.m3u8(\?|$)/i.test(src) || /[?&]type=m3u8/i.test(src)
    let hls: Hls | null = null

    if (looksLikeHls && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        // Both consoles have to aim at the same latency. Left to their defaults
        // they join at whatever the buffer happens to allow, start seconds apart,
        // and the first correction is a visible reposition instead of a nudge.
        liveSyncDuration: 6,
        liveMaxLatencyDuration: 30,
        // hls.js will trim playbackRate itself to hold its latency target. That
        // is a second controller on the same actuator as our rate nudge, and the
        // two fight. 1 disables it and leaves the follower in sole charge.
        maxLiveSyncPlaybackRate: 1,
        backBufferLength: 120,
      })
      engineRef.current = 'hls.js'

      const ingestFragment = (frag: {
        start: number
        duration: number
        programDateTime: number | null
        cc: number
        sn: number | 'initSegment'
      }) => {
        if (frag.programDateTime === null || frag.sn === 'initSegment') return
        const result = pdtMap.ingest({
          start: frag.start,
          duration: frag.duration,
          pdt: frag.programDateTime,
          cc: frag.cc,
          sn: frag.sn,
        })
        if (result.discontinuity) {
          notice(
            'warn',
            `Discontinuity — now sequence ${frag.cc}. The media↔absolute mapping was rebuilt; ` +
              `events either side of it are not on one continuous timeline.`,
          )
        }
        if (result.pdtBreak) {
          notice(
            'error',
            'PROGRAM-DATE-TIME jumped without a discontinuity — the encoder clock moved. ' +
              'Absolute alignment before this point is suspect; relative structure is intact.',
          )
        }
      }

      hls.on(Events.LEVEL_UPDATED, (_event, data: LevelUpdatedData) => {
        liveRef.current = data.details.live
        detectedRef.current = true
        targetDurationRef.current = data.details.targetduration
        // Ingesting the whole window, not just the playing fragment, is what lets
        // this client resolve a program-date-time anywhere in the DVR range — which
        // is what a seek published by the other operator needs.
        for (const frag of data.details.fragments) ingestFragment(frag)
      })

      hls.on(Events.FRAG_CHANGED, (_event, data: FragChangedData) => {
        ingestFragment(data.frag)
      })

      hls.on(Events.MANIFEST_PARSED, () => {
        // Deliberately checked at load, not at kickoff. A stream without
        // PROGRAM-DATE-TIME has no shared coordinate at all — not a degraded one,
        // none — and discovering that as the match starts leaves no options.
        setTimeout(() => {
          if (liveRef.current && !pdtMap.health().present) {
            notice(
              'error',
              'Live playlist carries no EXT-X-PROGRAM-DATE-TIME. There is no coordinate ' +
                'the two collectors share; this stream must pass through a packager that stamps one.',
            )
          }
        }, 2_000)
      })

      hls.on(Events.ERROR, (_event, data) => {
        notice(data.fatal ? 'error' : 'warn', `hls.js ${data.details}`)
      })

      hls.loadSource(src)
      hls.attachMedia(video)
    } else {
      engineRef.current = 'native'
      video.src = src
      video.load()
      // Native playback exposes duration rather than a playlist, so `live` is
      // inferred from an infinite duration.
      video.addEventListener(
        'loadedmetadata',
        () => {
          liveRef.current = !Number.isFinite(video.duration)
          detectedRef.current = true
        },
        { once: true },
      )
      if (looksLikeHls) {
        // Native HLS (Safari) plays the stream perfectly and exposes no
        // program-date-time, so the shared coordinate simply does not exist. There
        // is no degraded mode to offer here — two collectors would produce events
        // that cannot be compared, and nothing downstream could detect it.
        unsupportedRef.current =
          'This browser is playing HLS natively, which does not expose ' +
          'EXT-X-PROGRAM-DATE-TIME. There is no coordinate the two collectors would ' +
          'share. Collect in Chrome.'
        notice('error', unsupportedRef.current)
      }
    }

    const diagnostics = setInterval(() => {
      setInfo({
        detected: detectedRef.current,
        live: liveRef.current,
        engine: engineRef.current,
        frameCallbacks: frameClock.frameCallbackSupported(),
        targetDuration: targetDurationRef.current,
        pdt: pdtMap.health(),
        staleReads: frameClock.staleReadCount(),
        unsupported: unsupportedRef.current,
      })
    }, DIAGNOSTICS_INTERVAL_MS * 3)

    return () => {
      clearInterval(diagnostics)
      frameClock.detach()
      hls?.destroy()
    }
  }, [videoRef, src, notice])

  /**
   * Everything the console can say about "now", read in one go.
   *
   * On live, `programDateTime` is the event's time and `mediaTime` is a diagnostic.
   * On recorded footage it is the other way round. Both are always recorded, with
   * provenance, because which one is authoritative is a property of the session and
   * QC should not have to infer it.
   */
  const readStamp = useCallback((): Stamp => {
    const reading = frameRef.current!.read()
    const pdt = pdtRef.current!.toPdt(reading.mediaTime)
    return {
      mediaTime: reading.mediaTime,
      mediaTimeSource: reading.source,
      programDateTime: pdt?.pdt ?? null,
      pdtSource: pdt?.source ?? 'none',
      discontinuitySequence: pdt?.cc ?? null,
    }
  }, [])

  /** Absolute instant → this client's media position. Null when unmapped. */
  const toMedia = useCallback(
    (pdt: number) => pdtRef.current!.toMedia(pdt),
    [],
  )

  const toPdt = useCallback(
    (mediaTime: number) => pdtRef.current!.toPdt(mediaTime),
    [],
  )

  const latestPdt = useCallback(() => pdtRef.current!.latestPdt(), [])

  /** The DVR window this client can actually reach. */
  const seekableRange = useCallback((): { start: number; end: number } | null => {
    const video = videoRef.current
    if (!video || video.seekable.length === 0) return null
    return {
      start: video.seekable.start(0),
      end: video.seekable.end(video.seekable.length - 1),
    }
  }, [videoRef])

  const mode: SessionMode = info.live ? 'live' : 'vod'

  /**
   * What this client can say about the stream it is on, for the join check. Read at
   * join time rather than continuously — it is an identity claim, not a metric.
   */
  const fingerprint = useCallback(
    (): StreamFingerprint => ({
      src,
      live: liveRef.current,
      targetDuration: targetDurationRef.current,
      pdtPresent: pdtRef.current!.health().present,
      discontinuitySequence: pdtRef.current!.health().cc,
      latestPdt: pdtRef.current!.latestPdt(),
    }),
    [src],
  )

  return { info, notices, mode, readStamp, toMedia, toPdt, latestPdt, seekableRange, fingerprint }
}
