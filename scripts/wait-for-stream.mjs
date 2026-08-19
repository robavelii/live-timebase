/**
 * Wait until the live stream has an established DVR window.
 *
 * A playlist that has only just started has a short window, and a short window makes the
 * followers legitimately report `wait(outside-dvr)` — the session position really is
 * outside what they hold. That produces a confusing run of failures which look like a
 * bug in the follower and are actually "the stream started twenty seconds ago".
 */

export async function waitForStream(base, src, { minSeconds = 55, timeoutMs = 120_000 } = {}) {
  const url = src.startsWith('http') ? src : `${base}${src}`
  const deadline = Date.now() + timeoutMs
  let last = ''

  while (Date.now() < deadline) {
    try {
      const text = await (await fetch(url, { cache: 'no-store' })).text()
      const segments = (text.match(/^[^#\s].*$/gm) ?? []).length
      const target = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(text)?.[1] ?? 0)
      const seconds = segments * (target || 2)
      const advancing = text !== last
      last = text

      if (seconds >= minSeconds && advancing) {
        return { segments, seconds }
      }
      if (!advancing && seconds >= minSeconds) {
        // Full window but not changing: the encoder has stopped.
        throw new Error(
          `Playlist at ${url} has a ${seconds}s window but is not advancing — is the encoder running?`,
        )
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('not advancing')) throw error
      // Not serving yet; keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }

  throw new Error(`Stream at ${url} did not reach a ${minSeconds}s DVR window in time`)
}
