/**
 * The clock exchange. The server replies with its own wall clock and nothing
 * else; the client does all the arithmetic (see `lib/clock-sync.ts`).
 *
 * A plain GET is enough. Cristian's algorithm needs one round trip and no state,
 * so there is no reason for this to live on a socket.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function GET() {
  return new Response(JSON.stringify({ ts: Date.now() }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-transform',
    },
  })
}
