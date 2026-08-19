# Live timebase — two collector consoles, one live stream

Two collectors watch one live HLS URL in two windows and tag events from each. Their
events land on one timeline, to the millisecond, even though their players are
seconds apart in the stream.

That last clause is the whole point, and it is measured rather than asserted:

```
home  currentTime=76.040   pdt=11:40:12.490   rvfc/frag   locked, drift 40 ms
away  currentTime=62.040   pdt=11:40:12.490   rvfc/frag   locked, drift 27 ms

playheads      14.000 s apart
event stamps        0 ms apart          → paired, Δ0 ms on program-date-time
```

Two clients on the same live playlist joined 12 seconds apart. Comparing their
playheads would have put their observations of one contest 14 seconds apart. On the
shared coordinate they are identical. Reproduce it with `npm run check:two-window`.

---

## Run it

Two terminals, no external services. **Chrome, and Node 22.6+** (there is an `.nvmrc`;
the tests import `lib/*.ts` directly using Node's type stripping, and the harnesses use
the built-in `WebSocket`).

```bash
npm install
npm run stream          # rolling live HLS with PROGRAM-DATE-TIME and burned-in timecode
npm run dev             # http://localhost:3200
```

Open <http://localhost:3200> and press **Open both consoles** — it opens *away* in a new
window and turns the current tab into *home*. (One `window.open` per click: browsers allow
only one popup per gesture and silently block a second, so asking for two gets you one
console and no error.) Put the two side by side, both visible, and press **Start
collecting** in **each**.

**Each console needs its own click.** A browser will not begin playback without a user
gesture, so starting *home* cannot start *away* — and starting collection for an operator
who is not ready would be wrong anyway. A console opened into a session that is already
running says so, and its button reads **Join session** rather than Start collecting.

To tag: shirt digits, an action letter, a grade, then a keypad zone — `1` `0` `s` `,`
`Numpad8`. The zone terminates the run. `Alt`+digit is the fallback on a keyboard
without a numeric keypad. `Enter` commits without a zone, `Esc` discards.

### Using a real live stream

**Check the URL first.** One command, before you open anything:

```bash
npm run check:pdt -- https://cdn.example.com/live/index.m3u8
```

It follows a master playlist to a variant, then reports whether the stream carries
`EXT-X-PROGRAM-DATE-TIME`, whether the stamps agree with the segment durations, whether the
playlist is actually rolling, how deep the DVR window is, and whether CORS will let a
browser read it. It ends with `USABLE` or `NOT USABLE` and a reason. A live stream with no
stamp is `NOT USABLE` and there is no workaround at the console — it needs a packager.

Then pass the URL on the landing page, or straight in the console link:

```
http://localhost:3200/collect/match-1?role=home&src=https%3A%2F%2Fcdn.example.com%2Flive%2Findex.m3u8
```

The URL must be **percent-encoded** in `src`, directly playable by hls.js (a player *page*
URL will not work), and either same-origin or CORS-permitted. Both consoles must be on the
**same** URL — the join check refuses a mismatch rather than letting you collect two
sources.

### Two separate browsers

The realistic test, and the one that shows why any of this is needed.

1. Start the stream and the server (above), and confirm the URL with `check:pdt`.
2. Open **Chrome** at `/collect/match-1?role=home&src=…` and press **Start collecting**.
3. Wait ~10 seconds. This matters — the gap is what gives the two players different
   `currentTime` origins for the same picture.
4. Open a **second browser** at the same session with `role=away`. It will tell you the
   session is already running; press **Join session**. Any Chromium browser works: a second
   Chrome window, a separate Chrome profile (`google-chrome --user-data-dir=/tmp/away`), or
   Edge. Firefox and Safari are refused — see the Chrome-only note below.
5. Put the two windows **side by side, both visible.** A window that is minimised or fully
   covered has its timers throttled and its frame callbacks stopped; the console detects
   that, says so, and holds position rather than fighting it.

What to look for, in order:

| Look at | You should see |
|---|---|
| The burned-in timecode in each window | **The same frame number** in both |
| `currentTime` under each player | **Different** — often 10–15 s apart |
| `pdt · 1st key` after tagging in each | **The same instant**, to within a frame |
| Drift · Correction | `locked` or `nudge`; repositions rare |
| **Pairs across collectors** | one row, with the cross-collector delta |

Tag the same moment in both windows — `1` `0` `s` `,` then `Numpad8` — and the pair appears
with its delta. That delta is two people's reaction times. The 10–15 s difference in
`currentTime` is not in it, which is the entire point.

Then break things, in the right-hand panel: drag **outbound event delay** up, or **Go
offline** and keep tagging — wire lag climbs, the event times do not move. Drag **this
machine's system clock** to −60 s — the correction state goes to `hold`, then re-converges,
and no stored timestamp changes.

**Two machines on a LAN** is the same procedure: run the app on one, open
`http://<its-ip>:3200/collect/...` on both, and make sure the stream URL is reachable from
each. The clock endpoint is same-origin, so both consoles estimate their offset against the
same server — which is what makes their positions comparable in the first place.


### Verify it

```bash
npm run check:pdt -- <url>  # is a given live stream usable at all?
npm test                    # 65 unit tests: derivation, clock, PDT mapping, identity, the A/B
npm run smoke               # 39 checks against a running server
npm run check:join          # 11 checks on the two-console open-and-join flow
npm run check:two-window    # 15 checks driving two real Chrome instances
npm run check:bench         # 17 checks measuring the head-to-head
```

The two `check:` scripts need Chrome on `PATH` and both the stream and the server
running. They write screenshots to `.artifacts/`.

---

## The comparison

`/bench` runs the alternative — mirroring the host's play/pause/seek commands, as
`syncwave-webrtc` does — against this one, on the same stream and the same impaired
message channel.

The scenario is the one that actually happens: the second collector joins ten seconds
after the first, so their players have different `currentTime` origins for the same
picture. Both followers get **the same** offset buffer and **the same** drops and delays,
seeded on the message sequence number. The only difference is what they do with a message.

Error is the distance between the picture a follower is showing and the picture the lead
is showing, **in absolute time**. Measuring playhead-against-playhead is the mistake under
examination: it would score command mirroring as flawless while it displayed a moment a
minute adrift.

Steady state over 25 s, all four known defects **disabled** — the hardest case for the
argument. The numbers barely move when they are switched back on.

| | Timebase | Command mirroring |
|---|---|---|
| p50 error | **0 – 40 ms** — within one frame | 4.6 – 6.5 s |
| p95 error | **40 – 80 ms** — within two frames | 5.6 – 7.5 s |
| Frame-accurate (inside 40 ms) | 27 – 70% of samples | **0%** |
| **Beyond the 250 ms QC threshold** | **0%** | **100%** |
| **Duel window consumed at p95** | **2 – 4%** | **278 – 374%** |
| Invisible rate nudges available | yes | no |

**The duel-window row is the one that matters.** At 2–4% the timebase follower leaves the
±2 s pairing window intact for what it is meant to measure — inter-collector reaction time.
At 278% and above mirroring has spent it before the operators do anything, so two observations of one
contest will not pair. That is the dataset failing, not a sync inconvenience.

**Its only correction is a jump.** With no equivalent of the rate trim, every correction
mirroring makes is visible, and it makes one on essentially every host snapshot. The
timebase follower repositioned **zero** times across all three configurations above,
including a lossy WAN with a dropped burst.

**80 ms at p95 is the floor here, not slack.** It is the difference between two
*independently* locked players: each is within one frame of the session target, so they may
be two frames from each other. `check:bench` therefore asserts against the 250 ms QC
threshold, not against a frame-accuracy percentage that would be measuring the instrument.

**Reproducing it needs a mature DVR window.** Against a playlist that started seconds ago
the two players' buffers tend to align and mirroring measures far better than it deserves.
Both harnesses wait for a full window and print what they waited for.

`check:two-window` measures the same finding a second, independent way — two consoles in
two separate browsers, **14 s apart on `currentTime`, 0–40 ms on program-date-time**, events
pairing.

The four defects are individually toggleable because the obvious objection — that this only
wins because the alternative has bugs — deserves testing rather than assurance. The figures
above are already with all four **off**; switching them on barely moves them.

---

## What live changes

Everything about the recorded-footage design carries over except one thing, and that
one thing is load-bearing.

On a live playlist, `video.currentTime` is a coordinate in **this client's view of
the stream**. Its origin depends on when the client joined and how deep its buffer
is. Two collectors on the same URL can each be perfectly accurate about their own
playhead and still produce timestamps seconds apart for the same contest, and there
is no shared origin to correct against afterwards.

`EXT-X-PROGRAM-DATE-TIME` is the fix: the packager stamps an absolute instant onto
each segment, so every client reading the same playlist gets the same value for the
same picture. So on live:

| | Recorded | Live |
|---|---|---|
| Event timestamp | media position | **program-date-time instant** |
| Shared coordinate | the asset itself | the packager's stamps |
| Transport `anchor` | seconds into the asset | **PDT in milliseconds** |
| Falling out of sync | safe — data still merges | safe for data, loses shared picture |
| Main risk | wrong encode | **discontinuity resetting the anchor** |

Both timestamps are recorded on every event regardless of mode, each with its
provenance, because which one is authoritative is a property of the session and QC
should not have to infer it.

### The mapping, and why it is per-fragment

[`lib/pdt.ts`](lib/pdt.ts) holds a ring of fragment anchors — `{ start, duration,
pdt, cc, sn }` — and converts in both directions. Two decisions there matter more
than they look:

**One anchor per fragment, never one per stream.** Program-date-time is only reliably
monotonic *within* a discontinuity sequence. An encoder restart, a feed switch, an ad
insert or a clock correction resets it, and the media↔absolute mapping changes
underneath you. A single long-lived anchor keeps answering confidently with a stale
offset. So a change of `frag.cc` discards every earlier anchor, and a PDT that
disagrees with the segment durations by more than 500 ms *without* a discontinuity to
explain it is reported as an encoder clock move rather than averaged in.

Watch it happen: `npm run stream -- --restart-after 120` restarts the encoder every
two minutes, which is how a discontinuity actually arrives.

**Provenance on every answer.** An interpolation inside a fragment we hold is exact
(`frag`). An extrapolation past the newest fragment is good to the encoder's segment
timing and no better (`extrapolated`). No mapping at all is `none`, and on live an
event stamped `none` is **not** cross-comparable — the server refuses to pair those
rather than silently falling back to media position.

---

## How it is put together

```
lib/protocol.ts      the wire contract and every tuning constant, with its reason
lib/timebase.ts      the derivation: target, correction tiers, message ordering, clock maths
lib/pdt.ts           media ↔ program-date-time, discontinuity and continuity tracking
lib/clock-sync.ts    shared time from a monotonic clock, and whether to trust it
lib/frame-clock.ts   reading the presented frame, and knowing when you cannot
lib/event-timer.ts   the first-keystroke timing contract
lib/fingerprint.ts   are both collectors actually on the same stream?
lib/outbox.ts        IndexedDB queue, so a closed lid loses nothing
lib/syncwave.ts      the alternative, for the comparison — faithful, not fair
lib/impair.ts        seeded loss and latency, identical for both followers
lib/metrics.ts       percentiles, frame-accuracy, duel-window consumption
lib/server/store.ts  sessions, transport, presence, identity, idempotent ingest, pairing

hooks/               clock · SSE stream · media · follower · syncwave follower · outbox
app/collect/         the collector console
app/bench/           the head-to-head
app/api/             clock · transport · join · lead · events · report · SSE stream
app/stream/          serves the generated stream (see the traps below)
```

The server publishes one small object per session and every client derives its own
position from it:

```ts
interface Transport {
  epoch, sequence            // total order, so a stale message is dropped not applied
  mode: 'live' | 'vod'
  state: 'playing' | 'paused'
  rate
  anchor                     // PDT ms on live, media seconds on vod
  anchorServerTime           // stamped on arrival, never trusted from a client
}
```

Read as a sentence: *"`anchor` was current at `anchorServerTime`, advancing at
`rate`."* That is a complete description of the session at any future instant, which
is why one message always suffices — and why there is no reconnection path, no
catch-up path and no late-join path anywhere in the client. A client that missed
everything becomes correct on the next heartbeat through the same code as one that
missed nothing.

Corrections come in three tiers because the cost of correcting is not linear:

| Gap | Action | Why |
|---|---|---|
| < 40 ms | nothing | one frame at 25 fps; the right picture is already up |
| < 500 ms | trim `playbackRate` ±10% | closes invisibly, no jump |
| ≥ 500 ms | reposition | genuine divergence; a jump is the lesser evil |

The lock band is asymmetric — 40 ms to enter, 60 ms to leave — because an error
parked near the boundary is the common case, not a rare one, and without the gap the
follower flips between locked and nudging several times a second.

Two states mean *deliberately do nothing*, and they are distinguished because the
remedy differs: **hold** is "the clock estimate cannot be trusted", **wait** is "the
target is known but unreachable — no mapping yet, outside the DVR window, nothing
decoded, or this window is not being drawn".

---

## Decisions worth arguing with

**Transport over SSE, ingest over HTTP, no socket.** Everything pushed to a client is
state, and SSE reconnects on its own with nothing to resynchronise. Ingest goes the
other way as batched `POST` with an idempotency key and a local queue, because a
dropped socket loses in-flight state and needs its own resend protocol on top, while
a queue plus a key survives a lid closing for ten minutes. At ~1,479 events a match
that is 0.27 requests a second — transport is not the constraint, so it is chosen for
how it behaves when the network fails.

**The follower never publishes.** Transport intents come only from explicit operator
commands; the `<video>` has no native controls and nothing watches its `play`/`seeked`
events. The alternative — watching media events and suppressing the ones your own
corrections caused — needs a timing heuristic to tell a correction from an operator,
and on live, where a seek can take longer than any sane guard window, that heuristic
fails and the server re-anchors to the follower. That is a feedback loop, and the
cheapest fix is to not create it.

**The heartbeat does not re-anchor.** It re-sends the same anchor pair with only the
sequence bumped. Projecting the anchor forward every five seconds would make the
server's idea of position an accumulating quantity that never reconciles against any
real playhead — so a buffer stall on the lead's machine would hand every client a
target ahead of reality, and everyone would reposition, repeatedly.

**Epoch is seeded from the wall clock.** A restarted server that handed out epoch 1
again would publish transport that every surviving client correctly rejects as stale
for the rest of the match. It presents as "the other operator's player froze".

**An intent carries the units its anchor is in.** Not redundant with the session's
mode: the console detects live-vs-vod from the playlist a second or two after mount,
so a client can publish an anchor in seconds while the session reads anchors as
absolute instants. That produced a target seven seconds after 1 January 1970 and a
follower correctly reporting no fragment covered it. Carrying the units makes it a
409 instead of an unexplainable stall, and the Start button stays disabled until the
source has been identified.

**A hidden window holds instead of correcting.** Its timers are throttled to about
1 Hz and its frame callbacks have stopped, so every measurement is stale and
repositioning on a stale error flushes the buffer and produces a fresh one. Nobody is
looking at the picture; one heartbeat after it returns, the client is correct.

**An unreachable session position is not self-healed.** When the anchor rolls out of
the DVR window the console says so and offers the lead a **Rejoin at live edge**
button. Jumping automatically would move the other operator too, mid-keystroke, on
the strength of a local buffer condition.

**Pairing never arbitrates.** Two hundred milliseconds of separation is two people's
reaction times on one contest, not a conflict to resolve. Both observations are
stored raw and the pair records the delta.

**Chrome is required, and the console refuses rather than degrades.** Frame callbacks and
Media Source Extensions are preconditions, not enhancements. Without
`requestVideoFrameCallback` every timestamp would be a frame worse for the whole match;
with HLS playing natively there is no program-date-time at all, so two collectors would
have no shared coordinate and nothing downstream could detect it. Both are blocking
banners with Start disabled. **Consequence: iPads cannot be used for live collection.**

**A join is refused if the two consoles are not on the same stream.** The design's claim
holds within one stream, and the failure to check is silent: two collectors on two
renditions, or on a feed and its backup, are each internally consistent — every event
defensible, no record wrong, nothing pairs. So a joining console reports a fingerprint
(playlist path, live flag, target duration, whether a stamp is present, newest resolvable
instant) and a fatal mismatch gets a 409 that changes nothing about the session. A
differing target duration is allowed and reported: that is usually two renditions of one
stream, and the stamps still agree. Per-client tokens in the query string are ignored —
the path is the identity.

---

## Traps this hit, so you do not have to

**`public/` is indexed at build time.** A production Next server returns 404 for
every file created afterwards — and a live stream is nothing but files created
afterwards. The symptom is maddening: the playlist loads (it existed at build time),
the player reports nothing worth reading, and the video simply never buffers. The
stream is written to `.stream/` and served by
[`app/stream/[...file]/route.ts`](app/stream/[...file]/route.ts).

**MPEG-TS segments are also named `.ts`.** `tsc` will try to parse a transport stream
as TypeScript. `.stream/` is excluded in `tsconfig.json`.

**hls.js trims `playbackRate` itself** to hold its live latency target. That is a
second controller on the same actuator as the rate nudge, and they fight.
`maxLiveSyncPlaybackRate: 1` disables it.

**Two consoles must aim at the same latency.** Left to their defaults they join at
whatever the buffer allows, start seconds apart, and the first correction is a visible
reposition instead of a nudge. `liveSyncDuration: 6` on both.

**Two tabs in one browser is not two windows.** Only one is foreground; the other has
its timers throttled and its frame callbacks stopped. A two-tab harness measures the
hidden-window path, not the one operators use. `check:two-window` launches two Chrome
instances for this reason.

**A dependency array can outrun its own timer.** The bench's metrics interval listed a
state object that changed every 300 ms, so the 500 ms timer inside it was torn down before
it ever fired — every metric read zero while both followers were working perfectly. Anything
a long-lived interval needs comes through a ref.

**Joining before the source is identified fixes the session in the wrong mode.** Every
intent published afterwards is then refused for being in the wrong units, and the symptom
is two followers parked at the start of their buffers, looking exactly like a broken
follower loop. Both `/collect` and `/bench` wait for detection before joining. The units
check is what made this diagnosable in minutes.

**Node's type stripping does not desugar constructor parameter properties.** `lib/`
imports its own modules with `.ts` extensions so the tests need no build step, which means
no `enum` and no `constructor(private x: T)` in there either.

---

## Known limits

- **Chrome only** — see the decision above. Firefox has no `requestVideoFrameCallback`;
  Safari's native HLS exposes no program-date-time. Both are refusals, not degradations.
- **Session state is in memory and process-local.** Fine for a proof; a real
  deployment needs the transport in a shared store and the events in the database,
  and SSE needs either a single instance or a pub/sub fan-out.
- **A wrong encoder clock shifts both collectors identically.** Duels still pair and
  intervals are preserved; what breaks is alignment to real-world time, correctable
  afterwards from a known reference such as kickoff. That is a materially smaller
  failure than a per-collector clock error, which would corrupt the relationships
  between events and could not be corrected.
- **Publishing an intent stamps `anchorServerTime` on arrival**, so the session's
  latency-to-live is offset by roughly half a round trip. It applies to every client
  including the publisher, so relative agreement is unaffected.
- **Human reaction time is 200–400 ms** with 80–150 ms of spread, and it dominates
  everything here by an order of magnitude. This makes the instrument precise; the
  observer remains what they are. Reaction offset belongs in calibration metadata,
  never subtracted automatically.
- **The stream fingerprint does not check that two encodes agree frame-for-frame.** It
  cannot: it compares playlist identity and absolute time. For recorded footage the
  seek-and-read-a-frame probe in
  seek-and-read-a-frame probe from the reference design (`timebase-approach/docs/05-integration.md`,
  "Asset identity") is still needed and is not implemented.
- **`window.__timebase` and `window.__bench`** are read-only bridges for the CDP
  harnesses and a devtools console. Deliberate — a quantitative claim you cannot query
  from outside the UI is a claim you have to take on trust.
- **The bench runs three hls.js players on one page**, so it pulls the stream three
  times. Fine locally; not how two collectors would be deployed.

---

## Deploying

**This needs a persistent Node process. It will not work on Vercel's serverless runtime**,
and that is not a configuration problem:

- `/api/sessions/[id]/stream` holds an **open SSE connection** and fans out to subscribers
  from **module state**. Separate serverless invocations do not share that memory, so two
  collectors would land on different instances and never see each other's transport.
- Sessions, events and duel pairs are the same in-memory store. A cold start loses them.
- `/stream/[...file]` reads segments from the local `.stream/` directory, which only exists
  where the generator is running.

So: one always-on Node instance — Railway, Render, Fly, or a plain VPS.

```bash
npm ci && npm run build && npm start      # binds :3200, honours $PORT if you prefer
```

For production, drop the local generator and point the console at the real feed. Confirm it
first:

```bash
npm run check:pdt -- https://cdn.example.com/live/index.m3u8
```

Before this carries real collection, the items in **Known limits** above that say "must not
ship" are the list: move the transport to a shared store, the events to a database, and SSE
to either a single instance or a pub/sub fan-out.

## Related

This app was extracted from a larger R&D repo, where the following sit alongside it:

- `docs/timebase-vs-sync-audit.md` — the audit that led here: why published state beats
  command mirroring, fifteen defects found in the earlier bench, and the way forward.
- `timebase-approach/` — the reference implementation and the written design this is built
  on, including the recorded-footage asset-identity probe still to be done.
- `docs/final/10-media-sync.md` — the media-sync design document.
- `demo/sync-bench/` — the earlier VOD-first bench, now superseded by this app's `/bench`.
