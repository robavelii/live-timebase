import { LandingForm } from './LandingForm'

export default function Home() {
  return (
    <main className="grid" style={{ gap: 18 }}>
      <header>
        <p className="eyebrow">Timebase approach · live</p>
        <h1>Two collector consoles, one live stream</h1>
        <p className="muted" style={{ maxWidth: 720 }}>
          Paste a live HLS URL and open a console per collector. Each derives its own
          playback position from one shared object, and stamps every event against the
          stream&apos;s <span className="mono">EXT-X-PROGRAM-DATE-TIME</span> — the only
          coordinate two clients on a live playlist actually share.
        </p>
      </header>

      <LandingForm />

      <section className="panel">
        <h2>What to watch</h2>
        <ol className="muted" style={{ margin: 0, paddingLeft: 18, maxWidth: 760 }}>
          <li>
            <strong>The two consoles show different <span className="mono">currentTime</span> for the
            same picture</strong>, and the same program-date-time. That is the whole reason live
            needs its own coordinate: <span className="mono">currentTime</span> is a position in
            each client&apos;s buffer, not in the match.
          </li>
          <li>
            <strong>Tag on both sides of one contest.</strong> The pair appears in the duel table
            with the cross-collector separation. That pairing is the only place the two
            operators&apos; independent captures are ever compared.
          </li>
          <li>
            <strong>Raise the outbound delay, or go offline and keep tagging.</strong> Wire lag
            climbs; the event times do not move. The timestamp never crossed the network.
          </li>
          <li>
            <strong>Break a machine&apos;s system clock.</strong> Playback holds, then re-converges.
            No stored timestamp changes — they were read off the video.
          </li>
          <li>
            <strong>Restart the stream&apos;s encoder.</strong> The console says the absolute
            timeline moved, instead of carrying on with a stale anchor. This is the failure
            most likely to actually happen in live operation.
          </li>
        </ol>
      </section>
    </main>
  )
}
