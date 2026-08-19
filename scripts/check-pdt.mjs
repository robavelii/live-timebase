/**
 * Does this live stream carry a usable shared coordinate?
 *
 *   node scripts/check-pdt.mjs https://cdn.example.com/live/index.m3u8
 *
 * Answers the one question the whole live design rests on, without opening a browser.
 * Two collectors can only be compared through `EXT-X-PROGRAM-DATE-TIME`, so a stream
 * without it cannot be collected against by two people — not degraded, impossible.
 *
 * Checks presence, and then the things presence does not tell you: that the stamps agree
 * with the segment durations, that the playlist is actually rolling, and that the window
 * is deep enough for an operator to fall behind and catch up.
 */

import { requireNode } from './require-node.mjs'

requireNode([18, 0])

const url = process.argv[2]
if (!url) {
  console.error('\nusage: node scripts/check-pdt.mjs <playlist-url>\n')
  process.exit(64)
}

const fetchText = async (target) => {
  const response = await fetch(target, { cache: 'no-store', redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${target}`)
  return { text: await response.text(), finalUrl: response.url, headers: response.headers }
}

const resolve = (base, ref) => new URL(ref, base).toString()

/** A master playlist lists variants; the tags we care about live in the variants. */
async function resolveMedia(target) {
  const { text, finalUrl, headers } = await fetchText(target)
  if (!text.includes('#EXT-X-STREAM-INF')) return { text, finalUrl, headers, variants: 0 }

  const lines = text.split('\n').map((line) => line.trim())
  const variants = lines.filter((line) => line.startsWith('#EXT-X-STREAM-INF')).length
  const first = lines.findIndex((line) => line.startsWith('#EXT-X-STREAM-INF'))
  const ref = lines.slice(first + 1).find((line) => line && !line.startsWith('#'))
  if (!ref) throw new Error('master playlist lists no variant URI')
  console.log(`  master playlist with ${variants} variant(s) — inspecting the first`)
  const media = await fetchText(resolve(finalUrl, ref))
  return { ...media, variants }
}

function parse(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const segments = []
  let pendingDuration = null
  let pendingPdt = null
  let discontinuities = 0
  let sawDiscontinuityBeforeNext = false

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) pendingDuration = parseFloat(line.slice(8))
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pendingPdt = Date.parse(line.slice(25))
    else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      discontinuities++
      sawDiscontinuityBeforeNext = true
    } else if (!line.startsWith('#')) {
      segments.push({
        uri: line,
        duration: pendingDuration ?? 0,
        pdt: pendingPdt,
        afterDiscontinuity: sawDiscontinuityBeforeNext,
      })
      pendingDuration = null
      pendingPdt = null
      sawDiscontinuityBeforeNext = false
    }
  }

  return {
    segments,
    discontinuities,
    live: !text.includes('#EXT-X-ENDLIST'),
    targetDuration: Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(text)?.[1] ?? 0),
    mediaSequence: Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)?.[1] ?? 0),
  }
}

let fatal = 0
let warn = 0
const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`)
const bad = (m) => { fatal++; console.log(`  \x1b[31mFATAL\x1b[0m ${m}`) }
const meh = (m) => { warn++; console.log(`  \x1b[33mwarn\x1b[0m  ${m}`) }

console.log(`\nchecking ${url}\n`)

const first = await resolveMedia(url)
const a = parse(first.text)

console.log(`  ${a.segments.length} segments · target duration ${a.targetDuration}s · media sequence ${a.mediaSequence}`)
console.log()

// 1 · Live or recorded.
if (a.live) ok('playlist is live (no EXT-X-ENDLIST)')
else meh('playlist is a complete recording — the live rules do not apply; media position is the shared coordinate')

// 2 · The load-bearing check.
const stamped = a.segments.filter((s) => s.pdt !== null && !Number.isNaN(s.pdt))
if (stamped.length === 0 && a.live) {
  bad('NO EXT-X-PROGRAM-DATE-TIME on a live playlist. Two collectors here have no shared coordinate at all — not a degraded one, none. It must pass through a packager that stamps one.')
} else if (stamped.length === 0) {
  // On a recording the asset itself is the shared coordinate, so a stamp is not needed.
  ok('no EXT-X-PROGRAM-DATE-TIME, and none needed — on a recording, position in the asset is already common to every client')
} else if (stamped.length < a.segments.length) {
  ok(`EXT-X-PROGRAM-DATE-TIME present on ${stamped.length}/${a.segments.length} segments`)
  meh('not every segment carries one — usual and fine, so long as it reappears after each discontinuity')
} else {
  ok(`EXT-X-PROGRAM-DATE-TIME on all ${stamped.length} segments`)
}

// 3 · Do the stamps agree with the durations? Presence is not sufficient.
if (stamped.length >= 2) {
  let worst = 0
  let breaks = 0
  for (let i = 1; i < stamped.length; i++) {
    if (stamped[i].afterDiscontinuity) continue
    const expected = stamped[i - 1].pdt + stamped[i - 1].duration * 1000
    const error = Math.abs(stamped[i].pdt - expected)
    worst = Math.max(worst, error)
    if (error > 500) breaks++
  }
  if (breaks === 0) ok(`stamps agree with segment durations (worst gap ${worst.toFixed(0)} ms)`)
  else bad(`${breaks} stamp(s) disagree with the durations by >500 ms (worst ${worst.toFixed(0)} ms) — the encoder clock is moving; absolute alignment is unreliable`)
}

// 4 · Discontinuities.
if (a.discontinuities === 0) ok('no discontinuities in the current window')
else meh(`${a.discontinuities} discontinuity marker(s) in the window — each one resets the media↔absolute mapping; the console handles it, but events either side are not on one continuous timeline`)

// 5 · DVR depth: can an operator fall behind and catch up?
const windowSeconds = a.segments.reduce((total, s) => total + s.duration, 0)
if (!a.live) ok(`${windowSeconds.toFixed(0)}s of media`)
else if (windowSeconds >= 30) ok(`${windowSeconds.toFixed(0)}s DVR window — an operator can fall behind and catch up within it`)
else meh(`only ${windowSeconds.toFixed(0)}s of DVR window — an operator who falls behind will hit the trailing edge`)

// 6 · Is it actually rolling, and does the absolute time advance in step with real time?
if (a.live) {
  const waitMs = Math.max(4000, (a.targetDuration || 2) * 1500)
  process.stdout.write(`  … re-reading in ${(waitMs / 1000).toFixed(0)}s to confirm it is rolling`)
  await new Promise((r) => setTimeout(r, waitMs))
  process.stdout.write('\n')

  const second = parse((await resolveMedia(url)).text)
  if (second.mediaSequence > a.mediaSequence || second.segments.at(-1)?.uri !== a.segments.at(-1)?.uri) {
    ok(`playlist advanced (media sequence ${a.mediaSequence} → ${second.mediaSequence})`)
  } else {
    bad('playlist did not change — it is not rolling. Either the encoder has stopped or a cache is serving a stale copy.')
  }

  const edgeA = stamped.at(-1)
  const edgeB = parse((await resolveMedia(url)).text).segments.filter((s) => s.pdt).at(-1)
  if (edgeA && edgeB && edgeB.pdt > edgeA.pdt) {
    const advanced = (edgeB.pdt - edgeA.pdt) / 1000
    ok(`absolute time advanced ${advanced.toFixed(1)}s while ~${(waitMs / 1000).toFixed(0)}s of real time passed`)
  }

  // Skew against our own clock is informational: PDT is the encoder's wall clock, and a
  // wrong one shifts both collectors identically. It cannot make them disagree.
  if (edgeA) {
    const skew = (Date.now() - edgeA.pdt) / 1000
    console.log(`  note  live edge is stamped ${skew.toFixed(1)}s behind this machine's clock`)
    if (Math.abs(skew) > 120) {
      meh("the encoder's clock is a long way from yours — harmless for pairing (it shifts both collectors equally) but absolute alignment to real-world time will need a known reference such as kickoff")
    }
  }
}

// 7 · CORS, since the console fetches this from a browser.
const allowOrigin = first.headers.get('access-control-allow-origin')
if (allowOrigin) ok(`CORS: Access-Control-Allow-Origin: ${allowOrigin}`)
else meh('no Access-Control-Allow-Origin header — a browser on a different origin will be blocked. Fine if you serve the console from the same origin.')

const kind = a.live ? 'live' : 'recorded'
console.log()
if (fatal > 0) {
  console.log(`\x1b[31mNOT USABLE\x1b[0m for two-collector collection (${kind}) — ${fatal} fatal, ${warn} warning(s)\n`)
  process.exit(1)
}
console.log(`\x1b[32mUSABLE\x1b[0m for two-collector collection (${kind})${warn ? ` — ${warn} warning(s) worth reading` : ''}\n`)
