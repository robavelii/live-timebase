/**
 * The two-console join flow, which had two bugs worth a regression test.
 *
 *   node scripts/join-flow-check.mjs
 *
 * 1. "Open both consoles" called `window.open` twice from one click. Browsers allow one
 *    popup per gesture and silently block the second, so you got one console and no error.
 * 2. Starting one console does nothing visible on the other — correctly, since a browser
 *    will not begin playback without a gesture — but nothing said so, which made a working
 *    session look broken.
 */

import { requireNode } from './require-node.mjs'
import { waitForStream } from './wait-for-stream.mjs'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

requireNode()

const BASE = process.env.BASE ?? 'http://localhost:3200'
const SESSION = process.env.SESSION ?? `join-${Date.now()}`
const SRC = process.env.SRC ?? '/stream/index.m3u8'
const CHROME = process.env.CHROME ?? 'google-chrome'
const PORT = 9339

let passed = 0
let failed = 0
const check = (name, condition, detail = '') => {
  if (condition) { passed++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Target {
  #socket; #nextId = 1; #pending = new Map()
  static async attach(url) {
    const t = new Target()
    t.#socket = new WebSocket(url)
    await new Promise((res, rej) => {
      t.#socket.addEventListener('open', res, { once: true })
      t.#socket.addEventListener('error', rej, { once: true })
    })
    t.#socket.addEventListener('message', (m) => {
      const p = JSON.parse(m.data)
      const q = t.#pending.get(p.id)
      if (!q) return
      t.#pending.delete(p.id)
      p.error ? q.reject(new Error(p.error.message)) : q.resolve(p.result)
    })
    return t
  }
  send(method, params = {}) {
    const id = this.#nextId++
    this.#socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }))
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { return ${expression} })()`,
      awaitPromise: true, returnByValue: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'failed')
    return r.result.value
  }
  close() { this.#socket.close() }
}

const profile = mkdtempSync(join(tmpdir(), 'live-timebase-join-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--disable-gpu',
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' })
process.on('exit', () => {
  chrome.kill()
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
})

for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break } catch {}
  await sleep(250)
}

const open = async (url) => {
  const info = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' },
  )).json()
  const tab = await Target.attach(info.webSocketDebuggerUrl)
  await tab.send('Runtime.enable')
  await tab.send('Page.enable')
  return tab
}

const buttons = (tab) =>
  tab.evaluate(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim())`)

const clickText = (tab, text) => tab.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(text)}))
  if (!b || b.disabled) return false
  b.click(); return true
})()`)

const waitFor = async (tab, expr, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await tab.evaluate(expr)) return true
    await sleep(400)
  }
  return false
}

const window_ = await waitForStream(BASE, SRC)
console.log(`\nsession ${SESSION} @ ${BASE}`)
console.log(`window  ${window_.seconds}s DVR (${window_.segments} segments)\n`)

console.log('the landing page opener')
{
  const landing = await open(`${BASE}/`)
  // `json/new` returns as soon as the target exists, before the document has loaded, so
  // wait for the page rather than racing it.
  const ready = await waitFor(landing, `Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.includes('Open both consoles')))`)
  check('the button is there', ready)
  // A blocked popup is what a default Chrome profile does with the second window. Force
  // that condition rather than hoping for it.
  await landing.evaluate(`(() => { window.__opens = 0; window.open = () => { window.__opens++; return null }; return true })()`)
  // The button is in the server-rendered HTML before React has attached its handler, so a
  // single click can land on nothing. Click until one takes effect. Clicks before
  // hydration are no-ops, so the count that results is from the one that worked.
  let opens = 0
  for (let attempt = 0; attempt < 40; attempt++) {
    await clickText(landing, 'Open both consoles')
    await sleep(300)
    opens = (await landing.evaluate('window.__opens')) ?? 0
    if (opens > 0) break
  }
  check('it asks for exactly one popup, not two', opens === 1, `${opens} window.open call(s)`)
  check('a blocked popup is reported instead of silently losing a console',
    await landing.evaluate(`document.body.innerText.includes('blocked the second window')`))
  check('and it did not navigate away, so the fallback links are reachable',
    await landing.evaluate(`location.pathname === '/'`))
  landing.close()
}

console.log('\nstarting one console does not silently strand the other')
const url = (role) => `${BASE}/collect/${SESSION}?role=${role}&src=${encodeURIComponent(SRC)}`
{
  const home = await open(url('home'))
  check('home offers "Start collecting" for a fresh session',
    await waitFor(home, `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Start collecting'))`),
  )
  await clickText(home, 'Start collecting')
  check('home starts', await waitFor(home, `document.querySelector('video').readyState >= 3 && !document.querySelector('video').paused`))

  await sleep(4_000)
  const away = await open(url('away'))
  check('away is told the session is already running',
    await waitFor(away, `document.body.innerText.includes('has not joined it yet')`),
  )
  check('and its button says "Join session", not "Start collecting"',
    await waitFor(away, `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Join session'))`),
  )
  check('away is not playing until its operator clicks',
    await away.evaluate(`document.querySelector('video').paused`))

  await clickText(away, 'Join session')
  check('clicking it joins and starts following',
    await waitFor(away, `(() => {
      const f = window.__timebase?.follower?.()
      return !document.querySelector('video').paused && f && !['wait','hold'].includes(f.kind)
    })()`, 40_000),
  )
  check('the banner clears once joined',
    !(await away.evaluate(`document.body.innerText.includes('has not joined it yet')`))),

  home.close(); away.close()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
