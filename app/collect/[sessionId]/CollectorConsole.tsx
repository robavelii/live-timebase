'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useClockSync } from '@/hooks/useClockSync'
import { useFollower } from '@/hooks/useFollower'
import { useMediaSource } from '@/hooks/useMediaSource'
import { useOutbox } from '@/hooks/useOutbox'
import { useSessionStream } from '@/hooks/useSessionStream'
import { EventTimer } from '@/lib/event-timer'
import { Diagnostics } from '@/components/Diagnostics'
import { DuelTable } from '@/components/DuelTable'
import { EventTable } from '@/components/EventTable'
import { Notices } from '@/components/Notices'
import { describeMismatch } from '@/lib/fingerprint'
import type {
  CollectedEvent,
  CollectorRole,
  DuelPair,
  FingerprintMismatch,
  TransportIntent,
} from '@/lib/protocol'

const SKIP_SECONDS = 10
/** Where "jump to live" lands: far enough back that segments are reliably there. */
const LIVE_EDGE_OFFSET_MS = 6_000

interface Props {
  sessionId: string
  role: CollectorRole
  src: string
}

interface Run {
  chars: string[]
  zone: number | null
}

const EMPTY_RUN: Run = { chars: [], zone: null }

/** Physical key codes, not characters. See the note by the keydown handler. */
const GRADE_CODES = new Set(['Comma', 'Period', 'Semicolon', 'Slash'])

export function CollectorConsole({ sessionId, role, src }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)

  const [skewMs, setSkewMs] = useState(0)
  const [delayMs, setDelayMs] = useState(0)
  const [offline, setOffline] = useState(false)
  const [following, setFollowing] = useState(true)
  const [started, setStarted] = useState(false)
  const [pageVisible, setPageVisible] = useState(true)
  const [localEvents, setLocalEvents] = useState<CollectedEvent[]>([])
  const [localDuels, setLocalDuels] = useState<DuelPair[]>([])
  const [runDisplay, setRunDisplay] = useState<Run>(EMPTY_RUN)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [joinRefused, setJoinRefused] = useState<FingerprintMismatch[] | null>(null)
  const [streamWarnings, setStreamWarnings] = useState<FingerprintMismatch[]>([])

  const clock = useClockSync(skewMs)
  const stream = useSessionStream(sessionId)
  const media = useMediaSource(videoRef, src)

  const follower = useFollower({
    videoRef,
    transportRef: stream.transportRef,
    sessionNow: clock.now,
    clockTrusted: clock.isTrusted,
    toMedia: media.toMedia,
    seekableRange: media.seekableRange,
    enabled: following && started,
    visible: pageVisible,
  })

  const onDuel = useCallback((duel: DuelPair) => {
    setLocalDuels((current) =>
      current.some((existing) => existing.id === duel.id) ? current : [...current, duel],
    )
  }, [])

  const outbox = useOutbox(sessionId, { simulateOffline: offline, delayMs, onDuel })

  // ─── Session membership ──────────────────────────────────────────────────

  /**
   * Join once the source has actually told us what it is. Announcing a mode on the
   * strength of a default, then correcting it, is how a session ends up in the wrong
   * one — and the server refuses to change mode on a join precisely so that this
   * cannot quietly reset a transport the other operator is following.
   */
  const joinedRef = useRef(false)
  useEffect(() => {
    if (!media.info.detected || joinedRef.current) return
    joinedRef.current = true
    void fetch(`/api/sessions/${sessionId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role,
        mode: media.mode,
        src,
        fingerprint: media.fingerprint(),
      }),
    })
      .then(async (response) => ({
        status: response.status,
        body: (await response.json()) as {
          modeMismatch?: string
          fingerprintMismatches?: FingerprintMismatch[]
        },
      }))
      .then(({ status, body }) => {
        if (status === 409) {
          // Refused. Nothing about the session changed and this console must not
          // collect — two sources means a dataset in which nothing pairs and no
          // individual event looks wrong.
          setJoinRefused(body.fingerprintMismatches ?? [])
          return
        }
        setStreamWarnings((body.fingerprintMismatches ?? []).filter((m) => !m.fatal))
        if (body.modeMismatch) {
          setRefusal(
            `This session was opened as "${body.modeMismatch}" but this source looks like "${media.mode}". ` +
              'Both collectors must be on the same kind of source — the shared coordinate is different for each.',
          )
        }
      })
      .catch(() => {
        joinedRef.current = false
      })
  }, [sessionId, role, src, media.mode, media.info.detected, media.fingerprint])

  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // ─── Event capture ───────────────────────────────────────────────────────

  const timerRef = useRef<EventTimer | null>(null)
  timerRef.current ??= new EventTimer({ readStamp: media.readStamp })
  const runRef = useRef<Run>({ ...EMPTY_RUN })

  const commit = useCallback(async () => {
    const timing = timerRef.current!.commit()
    const run = runRef.current
    runRef.current = { ...EMPTY_RUN }
    setRunDisplay({ ...EMPTY_RUN })
    if (!timing) return

    const keys = run.chars.join('')
    const shirtDigits = keys.match(/^\d+/)?.[0] ?? ''

    const event = await outbox.submit({
      clientEventId: crypto.randomUUID(),
      role,
      mode: media.mode,
      sequenceKeys: run.zone ? `${keys}·z${run.zone}` : keys,
      shirt: shirtDigits ? Number(shirtDigits) : null,
      zone: run.zone,
      mediaTime: timing.mediaTime,
      mediaTimeSource: timing.mediaTimeSource,
      programDateTime: timing.programDateTime,
      pdtSource: timing.pdtSource,
      discontinuitySequence: timing.discontinuitySequence,
      commitMediaTime: timing.commitMediaTime,
      inputDurationMs: timing.inputDurationMs,
      keystrokes: timing.keystrokes,
    })

    // Local-first: the operator sees it now, not on acknowledgement. The
    // timestamp is already fixed, so nothing about the send can change it.
    setLocalEvents((current) => [...current, event])
  }, [outbox, role, media.mode])

  /**
   * Bound to `KeyboardEvent.code`, never `key`.
   *
   * Physical codes are independent of keyboard layout, and they are what makes
   * inline location entry unambiguous: a zone on `Numpad8` cannot be confused
   * with a shirt digit on `Digit8`, even though both produce "8". Bind `key` and
   * that distinction — which is the reason zones cost one keystroke rather than a
   * second station — simply does not exist.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return
      if (event.metaKey || event.ctrlKey) return
      const timer = timerRef.current!

      if (event.code === 'Escape') {
        timer.discard()
        runRef.current = { ...EMPTY_RUN }
        setRunDisplay({ ...EMPTY_RUN })
        return
      }
      if (event.code === 'Enter' || event.code === 'NumpadEnter') {
        event.preventDefault()
        if (timer.isOpen()) void commit()
        return
      }
      if (event.code === 'Backspace') {
        event.preventDefault()
        runRef.current.chars = runRef.current.chars.slice(0, -1)
        setRunDisplay({ ...runRef.current })
        return
      }

      const numpadZone = /^Numpad([1-9])$/.exec(event.code)
      // Alt+digit is the fallback for keyboards without a numeric keypad. It has
      // to be a modifier rather than a bare digit, or it would collide with shirt
      // numbers, which is the whole problem the physical codes solve.
      const altZone = event.altKey ? /^Digit([1-9])$/.exec(event.code) : null
      const zone = numpadZone ?? altZone

      if (zone) {
        event.preventDefault()
        timer.keystroke()
        runRef.current.zone = Number(zone[1])
        setRunDisplay({ ...runRef.current })
        // The zone terminates the run: location costs one keystroke, not a
        // separate station or a second pass.
        void commit()
        return
      }

      const digit = /^Digit(\d)$/.exec(event.code)
      const letter = /^Key([A-Z])$/.exec(event.code)
      const character = digit?.[1] ?? letter?.[1].toLowerCase() ?? (GRADE_CODES.has(event.code) ? event.key : null)
      if (character === null) return

      event.preventDefault()
      // The first keystroke fixes the time. Everything after it is transcription.
      timer.keystroke()
      runRef.current.chars = [...runRef.current.chars, character]
      setRunDisplay({ ...runRef.current })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [commit])

  // ─── Transport commands ──────────────────────────────────────────────────

  /**
   * This client's position expressed in the session's shared coordinate.
   *
   * On live that is a program-date-time instant, because this client's
   * `currentTime` means nothing to the other console.
   */
  const sharedPosition = useCallback((): number | null => {
    const video = videoRef.current
    if (!video) return null
    if (media.mode !== 'live') return video.currentTime

    // Before playback begins, `currentTime` is 0 — which on a live playlist maps to
    // the *trailing* edge of the DVR window, sixty seconds in the past. Publishing
    // that as the session anchor starts everyone a minute behind and, worse, the
    // anchor then rolls out of the window entirely a minute later and the session
    // has no reachable position at all. Anchor at the live edge instead.
    const notStartedYet = video.readyState < 3 || video.currentTime === 0
    const reading = notStartedYet ? null : media.toPdt(video.currentTime)
    if (reading) return reading.pdt

    const latest = media.latestPdt()
    return latest === null ? null : latest - LIVE_EDGE_OFFSET_MS
  }, [media])

  const publish = useCallback(
    async (intent: Omit<TransportIntent, 'role' | 'mode'>) => {
      const response = await fetch(`/api/sessions/${sessionId}/transport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...intent,
          role,
          mode: media.mode,
          // Relayed for the comparison bench only; nothing here reads it back.
          leadMediaTime: videoRef.current?.currentTime ?? null,
        }),
      })
      if (response.status === 403) {
        setRefusal('Only the session lead may seek — a seek drags the other operator off the passage they are working on.')
        setTimeout(() => setRefusal(null), 4_000)
      } else if (response.status === 409) {
        setRefusal(
          `This console thinks the source is "${media.mode}" but the session does not. ` +
            'The intent was refused rather than published in the wrong units.',
        )
      }
    },
    [sessionId, role, media.mode],
  )

  const start = useCallback(async () => {
    const video = videoRef.current
    if (!video) return
    // Autoplay: a follower calls play() programmatically, which browsers block
    // without a gesture unless muted. The console is muted and gated behind this
    // button rather than relying on either.
    try {
      await video.play()
    } catch {
      /* the follower retries on its next tick */
    }
    setStarted(true)
    const anchor = sharedPosition()
    if (anchor !== null) await publish({ reason: 'play', state: 'playing', rate: 1, anchor })
  }, [publish, sharedPosition])

  const pause = useCallback(async () => {
    const anchor = sharedPosition()
    if (anchor === null) return
    await publish({ reason: 'pause', state: 'paused', rate: 1, anchor })
  }, [publish, sharedPosition])

  const resume = useCallback(async () => {
    const anchor = sharedPosition()
    if (anchor === null) return
    await publish({ reason: 'play', state: 'playing', rate: 1, anchor })
  }, [publish, sharedPosition])

  const skip = useCallback(
    async (seconds: number) => {
      const anchor = sharedPosition()
      if (anchor === null) return
      const transport = stream.transportRef.current
      const delta = media.mode === 'live' ? seconds * 1000 : seconds
      await publish({
        reason: 'seek',
        state: transport?.state ?? 'playing',
        rate: 1,
        anchor: anchor + delta,
      })
    },
    [publish, sharedPosition, media.mode, stream.transportRef],
  )

  const jumpToLive = useCallback(async () => {
    const latest = media.latestPdt()
    if (latest === null) return
    await publish({
      reason: 'seek',
      state: 'playing',
      rate: 1,
      anchor: latest - LIVE_EDGE_OFFSET_MS,
    })
  }, [publish, media])

  const takeLead = useCallback(async () => {
    await fetch(`/api/sessions/${sessionId}/lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
  }, [sessionId, role])

  const isLead = stream.lead === null || stream.lead === role
  const otherRole: CollectorRole = role === 'home' ? 'away' : 'home'
  const duels = useMemo(() => {
    const merged = new Map<string, DuelPair>()
    for (const duel of [...stream.duels, ...localDuels]) merged.set(duel.id, duel)
    return [...merged.values()]
  }, [stream.duels, localDuels])

  const liveWithoutPdt = media.info.live && !media.info.pdt.present

  /**
   * The session is playing and this console has not joined it yet.
   *
   * Each console has to be started by its own operator: a browser will not begin playback
   * without a user gesture, and starting collection for someone who is not ready is worse
   * than making them click. But nothing said so, which made a perfectly working session
   * look broken — one console playing, the other apparently ignoring it.
   */
  const sessionRunningNotJoined = !started && stream.transport?.state === 'playing'

  /**
   * The session is pointing somewhere this client cannot go. Deliberately not
   * self-healed: jumping to the live edge automatically would move the *other*
   * operator too, mid-keystroke, on the strength of a local buffer condition.
   */
  const sessionPositionUnreachable =
    started &&
    following &&
    media.info.pdt.present &&
    follower.diagnostics.kind === 'wait' &&
    (follower.diagnostics.waitReason === 'outside-dvr' ||
      follower.diagnostics.waitReason === 'no-pdt-mapping')

  /**
   * A read-only bridge for driving this console from a devtools console or a CDP
   * harness (see `scripts/two-window-check.mjs`). It is here on purpose: the
   * argument this app exists to make is quantitative, and a claim you cannot query
   * from outside the UI is a claim you have to take on trust.
   */
  useEffect(() => {
    const bridge = {
      role,
      readStamp: media.readStamp,
      sharedPosition,
      currentTime: () => videoRef.current?.currentTime ?? null,
      follower: () => follower.diagnostics,
      transport: () => stream.transportRef.current,
      pdt: () => media.info.pdt,
    }
    ;(window as unknown as { __timebase?: typeof bridge }).__timebase = bridge
  }, [role, media.readStamp, media.info.pdt, sharedPosition, follower.diagnostics, stream.transportRef])

  return (
    <main className="grid" style={{ gap: 14 }}>
      <header className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <p className="eyebrow">
            Collector {role} · {stream.connected ? 'connected' : 'reconnecting'}
            {isLead ? ' · lead' : ''}
          </p>
          <h1>
            {sessionId}{' '}
            <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>
              {media.info.live ? 'live' : 'recorded'} · {media.mode}
            </span>
          </h1>
        </div>
        <div className="row">
          {!isLead ? <button onClick={takeLead}>Take lead</button> : null}
          <a
            href={`/collect/${sessionId}?role=${otherRole}&src=${encodeURIComponent(src)}`}
            target="_blank"
            rel="noreferrer"
          >
            open {otherRole}
          </a>
        </div>
      </header>

      {media.info.unsupported ? (
        <div className="banner bad">
          <strong>This browser cannot collect.</strong> {media.info.unsupported}
        </div>
      ) : null}

      {joinRefused ? (
        <div className="banner bad">
          <strong>Refused: this console is not on the session&apos;s stream.</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {joinRefused.map((mismatch) => (
              <li key={mismatch.field}>{describeMismatch(mismatch)}</li>
            ))}
          </ul>
          <p style={{ margin: '6px 0 0' }}>
            Collecting from two sources produces a dataset in which nothing pairs and no
            individual event looks wrong, so this is refused rather than warned about.
          </p>
        </div>
      ) : null}

      {streamWarnings.length > 0 ? (
        <div className="banner warn">
          <strong>Stream differences worth knowing:</strong>{' '}
          {streamWarnings.map((mismatch) => describeMismatch(mismatch)).join('; ')}.
        </div>
      ) : null}

      {liveWithoutPdt ? (
        <div className="banner bad">
          <strong>This live stream carries no EXT-X-PROGRAM-DATE-TIME.</strong> Two collectors on
          this URL have no shared coordinate at all — not a degraded one, none. Their events cannot
          be compared. Route the feed through a packager that stamps one before collecting.
        </div>
      ) : null}

      {!pageVisible ? (
        <div className="banner warn">
          <strong>This window is not being drawn.</strong> Frame callbacks have stopped while
          playback continues, so events are being stamped from the decoder position and flagged.
          Bring the window to the front.
        </div>
      ) : null}

      {refusal ? <div className="banner info">{refusal}</div> : null}

      {sessionRunningNotJoined ? (
        <div className="banner info">
          <strong>{stream.lead === role ? 'You' : `Collector ${stream.lead ?? 'the other operator'}`} started the session
          — this console has not joined it yet.</strong>{' '}
          Press <strong>Join session</strong> below. Each console needs its own click: a browser
          will not start playback without one, and your events are not being captured until you do.
        </div>
      ) : null}

      {sessionPositionUnreachable ? (
        <div className="banner warn row" style={{ justifyContent: 'space-between' }}>
          <span>
            <strong>The session position is no longer reachable</strong> —{' '}
            {follower.diagnostics.waitReason === 'outside-dvr'
              ? 'it has rolled out of the DVR window.'
              : 'no fragment covers it.'}{' '}
            Playback is held rather than guessing. Someone has to decide where to rejoin.
          </span>
          {isLead ? (
            <button className="primary" onClick={() => void jumpToLive()}>
              Rejoin at live edge
            </button>
          ) : (
            <span className="muted">The lead can rejoin at the live edge.</span>
          )}
        </div>
      ) : null}

      <div className="grid two">
        <section className="grid" style={{ gap: 12 }}>
          <div className="panel">
            {/* No native controls: every transport change goes through an explicit
                command that publishes an intent. Watching the element's own events
                instead means a correction looks like an operator action. */}
            <video ref={videoRef} muted playsInline />
            <div className="row" style={{ marginTop: 10 }}>
              {!started ? (
                <button
                  className="primary"
                  onClick={() => void start()}
                  // Nothing may be published before the source has said what it is.
                  // An anchor in the wrong units is silently, confidently wrong.
                  disabled={
                    !media.info.detected ||
                    media.info.unsupported !== null ||
                    joinRefused !== null
                  }
                >
                  {media.info.unsupported
                    ? 'Unsupported browser'
                    : joinRefused
                      ? 'Wrong stream'
                      : !media.info.detected
                        ? 'Identifying source…'
                        : sessionRunningNotJoined
                          ? 'Join session'
                          : 'Start collecting'}
                </button>
              ) : stream.transport?.state === 'playing' ? (
                <button onClick={() => void pause()}>Pause</button>
              ) : (
                <button onClick={() => void resume()}>Play</button>
              )}
              <button onClick={() => void skip(-SKIP_SECONDS)} disabled={!isLead || !started}>
                −{SKIP_SECONDS}s
              </button>
              <button onClick={() => void skip(SKIP_SECONDS)} disabled={!isLead || !started}>
                +{SKIP_SECONDS}s
              </button>
              {media.info.live ? (
                <button onClick={() => void jumpToLive()} disabled={!isLead || !started}>
                  Jump to live
                </button>
              ) : null}
              <button onClick={() => setFollowing((value) => !value)}>
                {following ? 'Work independently' : 'Re-lock to session'}
              </button>
            </div>
            {!following ? (
              <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
                Unlocked. On <strong>recorded</strong> footage this is safe — timestamps are
                coordinates in the file, so your events still merge exactly. On <strong>live</strong>{' '}
                it is safe too, because events are stamped against program-date-time rather than
                your playhead; what you lose is the shared picture, not the data.
              </p>
            ) : null}
          </div>

          <div className="panel">
            <h2>Sequence</h2>
            <div className="seq">
              {runDisplay.chars.join(' ') || <span className="muted">—</span>}
              {runDisplay.zone ? <span className="info"> · z{runDisplay.zone}</span> : null}
            </div>
            <p className="keymap" style={{ marginBottom: 0 }}>
              <kbd>0</kbd>–<kbd>9</kbd> shirt · <kbd>a</kbd>–<kbd>z</kbd> action · <kbd>,</kbd>{' '}
              <kbd>.</kbd> <kbd>;</kbd> <kbd>/</kbd> grade · <kbd>Numpad 1</kbd>–<kbd>9</kbd> zone
              (commits) · <kbd>Alt</kbd>+<kbd>1</kbd>–<kbd>9</kbd> zone without a keypad ·{' '}
              <kbd>Enter</kbd> commit · <kbd>Esc</kbd> discard
            </p>
          </div>

          <div className="panel">
            <h2>Diagnostics</h2>
            <Diagnostics
              clock={clock.diagnostics}
              follower={follower.diagnostics}
              media={media.info}
              transport={stream.transport}
            />
          </div>

          <div className="panel">
            <h2>Stream continuity</h2>
            <Notices notices={media.notices} />
          </div>
        </section>

        <section className="grid" style={{ gap: 12 }}>
          <div className="panel">
            <h2>Break things</h2>
            <div className="grid" style={{ gap: 12 }}>
              <label>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted" style={{ fontSize: 12 }}>
                    This machine&apos;s system clock
                  </span>
                  <span className="mono">{(skewMs / 1000).toFixed(0)} s</span>
                </div>
                <input
                  type="range"
                  min={-60000}
                  max={60000}
                  step={1000}
                  value={skewMs}
                  onChange={(event) => setSkewMs(Number(event.target.value))}
                />
              </label>
              <label>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted" style={{ fontSize: 12 }}>
                    Outbound event delay
                  </span>
                  <span className="mono">{delayMs} ms</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={8000}
                  step={250}
                  value={delayMs}
                  onChange={(event) => setDelayMs(Number(event.target.value))}
                />
              </label>
              <div className="row">
                <button onClick={() => setOffline((value) => !value)}>
                  {offline ? 'Go back online' : 'Go offline'}
                </button>
                <button onClick={follower.resetMetrics}>Reset metrics</button>
                <span className="muted mono" style={{ fontSize: 12 }}>
                  {outbox.queued} queued
                </span>
                {outbox.lastError ? (
                  <span className="warn mono" style={{ fontSize: 12 }}>
                    {outbox.lastError}
                  </span>
                ) : null}
              </div>
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                Break the clock and watch the correction state go to <span className="mono">hold</span>{' '}
                — the follower refuses to chase a target it knows is derived from a bad clock —
                then re-converge. Nothing in the event table moves either way.
              </p>
            </div>
          </div>

          <div className="panel">
            <h2>My events</h2>
            <EventTable events={localEvents} acks={outbox.acks} />
          </div>

          <div className="panel">
            <h2>Pairs across collectors</h2>
            <DuelTable duels={duels} />
          </div>

          <div className="panel">
            <h2>Peers</h2>
            <table>
              <tbody>
                {stream.peers.map((peer) => (
                  <tr key={peer.role}>
                    <td>{peer.role}</td>
                    <td className={peer.lead ? 'info' : 'muted'}>{peer.lead ? 'lead' : 'follower'}</td>
                    <td className="muted">
                      {new Date(peer.lastSeenAt).toISOString().slice(11, 19)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  )
}
