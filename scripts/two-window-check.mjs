/**
 * The two-window proof, driven headlessly.
 *
 *   npm run build && npm start
 *   ./scripts/make-live-stream.sh &
 *   node scripts/two-window-check.mjs
 *
 * It opens two real collector consoles in Chrome, deliberately joins them at
 * different times so their buffers diverge, tags the same instant from both, and
 * checks the thing the whole design turns on:
 *
 *   their `currentTime` values disagree, and their event timestamps do not.
 *
 * Chrome is driven over CDP with Node's built-in WebSocket, so there is nothing to
 * install. Uses `Input.dispatchKeyEvent`, so the keystrokes go through the same
 * `KeyboardEvent.code` path an operator's would.
 */

import { requireNode } from './require-node.mjs'
import { waitForStream } from './wait-for-stream.mjs'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

requireNode()

const BASE = process.env.BASE ?? 'http://localhost:3200'
const SESSION = process.env.SESSION ?? `two-window-${Date.now()}`
const SRC = process.env.SRC ?? '/stream/index.m3u8'
const CHROME = process.env.CHROME ?? 'google-chrome'
/** How long the away console joins after home, so their buffers differ. */
const JOIN_GAP_MS = 12_000

let passed = 0
let failed = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed++
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ─── Minimal CDP client ────────────────────────────────────────────────────

class Target {
  #socket
  #nextId = 1
  #pending = new Map()
  exceptions = []

  static async attach(webSocketDebuggerUrl) {
    const target = new Target()
    target.#socket = new WebSocket(webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      target.#socket.addEventListener('open', resolve, { once: true })
      target.#socket.addEventListener('error', reject, { once: true })
    })
    target.#socket.addEventListener('message', (message) => {
      const payload = JSON.parse(message.data)
      if (payload.method === 'Runtime.exceptionThrown') {
        target.exceptions.push(
          payload.params.exceptionDetails.exception?.description ??
            payload.params.exceptionDetails.text,
        )
        return
      }
      const pending = target.#pending.get(payload.id)
      if (!pending) return
      target.#pending.delete(payload.id)
      if (payload.error) pending.reject(new Error(payload.error.message))
      else pending.resolve(payload.result)
    })
    return target
  }

  send(method, params = {}) {
    const id = this.#nextId++
    this.#socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }))
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { return ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    }
    return result.result.value
  }

  async key(code, key, keyCode) {
    for (const type of ['keyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', {
        type,
        code,
        key,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      })
    }
  }

  close() {
    this.#socket.close()
  }
}

// ─── Harness ───────────────────────────────────────────────────────────────

/**
 * One browser per collector, deliberately.
 *
 * Two tabs in one browser is not the same experiment: only one tab is foreground,
 * so the other has its timers throttled and its frame callbacks stopped. The
 * console correctly holds position in that state, which means a two-tab harness
 * measures the hidden-window path instead of the one two operators actually use.
 * Two operators have two visible windows, usually two machines.
 */
const browsers = []

function launchChrome(port) {
  const profile = mkdtempSync(join(tmpdir(), `live-timebase-${port}-`))
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  browsers.push({ chrome, profile, port })
  return { chrome, port }
}

process.on('exit', () => {
  for (const { chrome, profile } of browsers) {
    chrome.kill()
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

async function waitForChrome(port) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return (await response.json())['User-Agent']
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error(`Chrome did not expose a debugging port on ${port}`)
}

async function openConsole(port, url) {
  const response = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  )
  const info = await response.json()
  const tab = await Target.attach(info.webSocketDebuggerUrl)
  await tab.send('Runtime.enable')
  await tab.send('Page.enable')
  await tab.send('Page.bringToFront')
  return tab
}

/** Wait until the console has a usable program-date-time mapping. */
async function waitForMapping(tab, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const stamp = await tab.evaluate('window.__timebase?.readStamp?.() ?? null')
    if (stamp && stamp.pdtSource !== 'none') return stamp
    await sleep(500)
  }
  return null
}

/**
 * Wait for the Start button to become enabled, then click it. The console gates it
 * until the source has been identified, precisely so that no intent can be
 * published in the wrong units.
 */
async function startCollecting(tab, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // Either label: a console joining a session that is already playing says "Join
    // session" instead, so that an operator is not left wondering why nothing happened.
    const clicked = await tab.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((b) => b.textContent.includes('Start collecting') || b.textContent.includes('Join session'))
      if (!button || button.disabled) return false
      button.click()
      return true
    })()`)
    if (clicked) return true
    await sleep(400)
  }
  throw new Error('neither "Start collecting" nor "Join session" became enabled')
}

/** Everything needed to explain a stalled console in one line. */
const probe = (tab) =>
  tab.evaluate(`(() => {
    const v = document.querySelector('video')
    const seekable = v && v.seekable.length
      ? { start: v.seekable.start(0), end: v.seekable.end(v.seekable.length - 1) }
      : null
    return {
      t: window.__timebase.currentTime(),
      s: window.__timebase.readStamp(),
      f: window.__timebase.follower(),
      transport: window.__timebase.transport(),
      pdt: window.__timebase.pdt(),
      video: v ? { paused: v.paused, readyState: v.readyState, rate: v.playbackRate, buffered: v.buffered.length } : null,
      seekable,
    }
  })()`)

/** Type "10 s ," then Numpad8, which terminates the run and commits. */
async function tagEvent(tab) {
  await tab.key('Digit1', '1', 49)
  await tab.key('Digit0', '0', 48)
  await tab.key('KeyS', 's', 83)
  await tab.key('Comma', ',', 188)
  await tab.key('Numpad8', '8', 104)
}

const window_ = await waitForStream(BASE, SRC)
console.log(`\nsession ${SESSION} @ ${BASE}`)
console.log(`window  ${window_.seconds}s DVR (${window_.segments} segments)`)
console.log(`stream  ${SRC}\n`)

launchChrome(9333)
launchChrome(9334)
const userAgent = await waitForChrome(9333)
await waitForChrome(9334)
console.log(`chrome  ${userAgent} (one instance per collector)\n`)

const url = (role) =>
  `${BASE}/collect/${SESSION}?role=${role}&src=${encodeURIComponent(SRC)}`

console.log('home console joins')
const home = await openConsole(9333, url('home'))
const homeStamp = await waitForMapping(home)
check('picks up EXT-X-PROGRAM-DATE-TIME from the live playlist', Boolean(homeStamp),
  homeStamp ? `pdtSource=${homeStamp.pdtSource}` : 'no mapping within 45 s')
if (!homeStamp) {
  console.log('\nCannot continue without a mapping. Is the stream running?\n')
  process.exit(1)
}
await startCollecting(home)

console.log(`\nwaiting ${JOIN_GAP_MS / 1000}s so the two buffers diverge`)
await sleep(JOIN_GAP_MS)

console.log('\naway console joins')
const away = await openConsole(9334, url('away'))
const awayStamp = await waitForMapping(away)
check('second console also resolves the shared coordinate', Boolean(awayStamp))
await startCollecting(away)
await sleep(8_000)

console.log('\nthe two consoles')
const [homeNow, awayNow] = await Promise.all([probe(home), probe(away)])

const describe = (name, state) => {
  console.log(
    `  ${name}  currentTime=${state.t?.toFixed(3)}` +
      `  pdt=${state.s.programDateTime ? new Date(state.s.programDateTime).toISOString().slice(11, 23) : '—'}` +
      `  drift=${state.f.driftMs?.toFixed(0)}ms  ${state.f.kind}${state.f.waitReason ? `(${state.f.waitReason})` : ''}`,
  )
  console.log(
    `        video paused=${state.video?.paused} readyState=${state.video?.readyState} rate=${state.video?.rate}` +
      `  seekable=${state.seekable ? `${state.seekable.start.toFixed(1)}–${state.seekable.end.toFixed(1)}` : 'none'}` +
      `  anchors=${state.pdt?.anchors}  transport=${state.transport?.state}/${state.transport?.reason}`,
  )
  console.log(
    `        target=${state.f.targetShared ? new Date(state.f.targetShared).toISOString().slice(11, 23) : '—'}` +
      `  →local=${state.f.targetSeconds?.toFixed(3) ?? '—'}  mapping=${state.f.mapping ?? '—'}` +
      `  coverage=${
        state.pdt?.coverage
          ? `${new Date(state.pdt.coverage.minPdt).toISOString().slice(11, 19)}–${new Date(state.pdt.coverage.maxPdt).toISOString().slice(11, 19)}`
          : 'none'
      }`,
  )
}
describe('home', homeNow)
describe('away', awayNow)

const pdtGap = Math.abs(homeNow.s.programDateTime - awayNow.s.programDateTime)
check('both consoles agree on the absolute instant they are showing', pdtGap < 1_000,
  `${pdtGap.toFixed(0)} ms apart`)
check('both consoles are decoding', homeNow.video.readyState >= 3 && awayNow.video.readyState >= 3)
check('neither console is holding or waiting',
  !['hold', 'wait'].includes(homeNow.f.kind) && !['hold', 'wait'].includes(awayNow.f.kind),
  `${homeNow.f.kind}${homeNow.f.waitReason ? `(${homeNow.f.waitReason})` : ''} / ${awayNow.f.kind}${awayNow.f.waitReason ? `(${awayNow.f.waitReason})` : ''}`)
check('the shared coordinate resolves into each buffer',
  homeNow.f.mapping !== null && awayNow.f.mapping !== null,
  `${homeNow.f.mapping} / ${awayNow.f.mapping}`)

const sources = [homeNow.s.mediaTimeSource, awayNow.s.mediaTimeSource]
check('both consoles are stamping from the presented frame',
  sources.every((source) => source === 'rvfc'), sources.join(' / '))

console.log('\ntagging one moment from both consoles')
await Promise.all([tagEvent(home), tagEvent(away)])
await sleep(4_000)

const report = await (await fetch(`${BASE}/api/sessions/${SESSION}/report`)).json()
const homeEvent = report.events.find((event) => event.role === 'home')
const awayEvent = report.events.find((event) => event.role === 'away')

check('both consoles produced an event', Boolean(homeEvent && awayEvent),
  `${report.events.length} events`)

if (homeEvent && awayEvent) {
  const mediaGap = Math.abs(homeEvent.mediaTime - awayEvent.mediaTime)
  const stampGap = Math.abs(homeEvent.programDateTime - awayEvent.programDateTime)
  console.log(`  home  media=${homeEvent.mediaTime.toFixed(3)}  pdt=${new Date(homeEvent.programDateTime).toISOString().slice(11, 23)}  src=${homeEvent.mediaTimeSource}/${homeEvent.pdtSource}`)
  console.log(`  away  media=${awayEvent.mediaTime.toFixed(3)}  pdt=${new Date(awayEvent.programDateTime).toISOString().slice(11, 23)}  src=${awayEvent.mediaTimeSource}/${awayEvent.pdtSource}`)

  check('both stamps are exact, not extrapolated',
    homeEvent.pdtSource === 'frag' && awayEvent.pdtSource === 'frag',
    `${homeEvent.pdtSource} / ${awayEvent.pdtSource}`)
  check('the raw playheads do NOT agree — which is why a shared coordinate is needed',
    mediaGap > 1, `${mediaGap.toFixed(3)} s apart on currentTime`)
  check('the timestamps land inside the duel window anyway', stampGap < 2_000,
    `${stampGap.toFixed(0)} ms apart on program-date-time`)
  // The headline number: the shared coordinate removes essentially all of the
  // divergence that comparing playheads would have introduced.
  const removed = (1 - stampGap / (mediaGap * 1000)) * 100
  check('the shared coordinate removes >95% of the divergence', removed > 95,
    `${removed.toFixed(2)}% of ${(mediaGap * 1000).toFixed(0)} ms removed`)
  check('the two observations paired', report.duels.length >= 1,
    `${report.duels.length} pair(s)${report.duels[0] ? `, Δ${report.duels[0].deltaMs} ms on ${report.duels[0].coordinate}` : ''}`)
}

console.log('\nartifacts')
{
  mkdirSync('.artifacts', { recursive: true })
  for (const [name, tab] of [
    ['home', home],
    ['away', away],
  ]) {
    const shot = await tab.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join('.artifacts', `${name}.png`), Buffer.from(shot.data, 'base64'))
  }
  console.log('  wrote .artifacts/home.png and .artifacts/away.png')
}

console.log('\nuncaught exceptions')
for (const [name, tab] of [
  ['home', home],
  ['away', away],
]) {
  check(`${name} console threw nothing`, tab.exceptions.length === 0,
    tab.exceptions.slice(0, 2).join(' | '))
}

home.close()
away.close()

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
