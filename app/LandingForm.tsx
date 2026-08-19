'use client'

import { useState } from 'react'

const LOCAL_STREAM = '/stream/index.m3u8'

export function LandingForm() {
  const [src, setSrc] = useState(LOCAL_STREAM)
  const [sessionId, setSessionId] = useState('match-1')
  const [popupBlocked, setPopupBlocked] = useState(false)

  const href = (role: 'home' | 'away') =>
    `/collect/${encodeURIComponent(sessionId || 'match-1')}?role=${role}&src=${encodeURIComponent(src)}`

  /**
   * One popup, then navigate this tab.
   *
   * Calling `window.open` twice from one click does not work: browsers allow a single
   * popup per user gesture and silently block the second, so you get one console and no
   * error. Opening `away` in a window and turning *this* tab into `home` needs only the
   * one allowance.
   */
  const openBoth = () => {
    const away = window.open(href('away'), 'collector-away', 'width=1200,height=980')
    if (!away) {
      setPopupBlocked(true)
      return
    }
    window.location.href = href('home')
  }

  return (
    <section className="panel grid" style={{ gap: 12 }}>
      <div>
        <h2>Stream</h2>
        <input
          type="url"
          value={src}
          onChange={(event) => setSrc(event.target.value)}
          placeholder="https://cdn.example.com/live/index.m3u8"
          spellCheck={false}
        />
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Must be directly playable by hls.js, CORS-permitted for this origin, and — for live —
          must carry <span className="mono">EXT-X-PROGRAM-DATE-TIME</span>. The console checks and
          says so if it does not. <span className="mono">{LOCAL_STREAM}</span> is the local stream
          from <span className="mono">npm run stream</span>: rolling live HLS with PDT and burned-in
          timecode, so you can verify agreement by eye rather than trusting the readout.
        </p>
      </div>

      <div>
        <h2>Session</h2>
        <div className="row">
          <input
            type="text"
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            style={{ maxWidth: 220 }}
            spellCheck={false}
          />
          <button className="primary" onClick={openBoth}>
            Open both consoles
          </button>
          <a href={href('home')}>home only</a>
          <a href={href('away')}>away only</a>
          <a
            href={`/bench/${encodeURIComponent(sessionId || 'match-1')}?src=${encodeURIComponent(src)}`}
          >
            A/B bench
          </a>
        </div>
        {popupBlocked ? (
          <p className="warn" style={{ fontSize: 12, marginTop: 6 }}>
            Your browser blocked the second window. Allow popups for this site, or open the two
            links below yourself — <a href={href('home')}>home</a> and{' '}
            <a href={href('away')} target="_blank" rel="noreferrer">away</a>.
          </p>
        ) : null}
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Opens <strong>away</strong> in a new window and turns this tab into <strong>home</strong>.
          Put the two side by side, both visible, and press <strong>Start collecting</strong> in
          each — every console joins on its own gesture, because a browser will not start playback
          without one. Two machines on a LAN works too: run this app on one and open the same URL on
          both, with the stream reachable from each.
        </p>
      </div>
    </section>
  )
}
