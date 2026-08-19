/**
 * Server → client push: transport, presence, events, duels.
 *
 * Server-sent events rather than a socket, for one reason: everything pushed here
 * is *state*, and SSE reconnects on its own. There is nothing to resynchronise
 * after a drop, because the next heartbeat fully describes the session. That is
 * the same property the transport object has, applied to the transport itself.
 *
 * Ingest deliberately does not come back this way — see `../events/route.ts`.
 */

import { subscribe, getOrCreateSession, snapshot, type ServerMessage } from '@/lib/server/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true
      const write = (message: ServerMessage) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`))
        } catch {
          open = false
        }
      }

      // A late joiner and a reconnecting client are the same case: hand over the
      // current state and let the ordinary loop take it from there.
      const session = getOrCreateSession(id)
      const initial = snapshot(session)
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'snapshot', snapshot: initial })}\n\n`),
      )

      const unsubscribe = subscribe(id, write)

      // Comment frames keep intermediaries from closing an idle stream. They are
      // not the mechanism that keeps clients correct — the transport heartbeat is.
      const keepAlive = setInterval(() => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          open = false
        }
      }, 15_000)

      const cleanup = () => {
        open = false
        clearInterval(keepAlive)
        unsubscribe()
      }
      _request.signal.addEventListener('abort', cleanup)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
