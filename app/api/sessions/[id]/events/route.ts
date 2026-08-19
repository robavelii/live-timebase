/**
 * Ingest.
 *
 * A batch POST rather than a socket message, and the reason is about failure
 * rather than speed. A dropped socket loses in-flight state and needs its own
 * resend protocol layered on top. A local queue plus an idempotency key survives a
 * laptop lid closing for ten minutes and needs nothing extra — and collected data
 * costs two people ninety minutes a match, so losing it is the one unacceptable
 * outcome.
 *
 * At the measured ~1,479 events per match this is roughly 0.27 requests a second.
 * Transport is not the constraint here, so it should be chosen for how it behaves
 * when the network fails.
 */

import { getSession, submitEvent } from '@/lib/server/store'
import type { CollectedEvent } from '@/lib/protocol'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function isEvent(value: unknown): value is CollectedEvent {
  if (!value || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return (
    typeof e.clientEventId === 'string' &&
    (e.role === 'home' || e.role === 'away') &&
    (e.mode === 'live' || e.mode === 'vod') &&
    typeof e.mediaTime === 'number' &&
    Number.isFinite(e.mediaTime) &&
    typeof e.mediaTimeSource === 'string' &&
    (e.programDateTime === null || typeof e.programDateTime === 'number') &&
    typeof e.pdtSource === 'string'
  )
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = (await request.json()) as { events?: unknown }
  const incoming = Array.isArray(body.events) ? body.events : []
  if (incoming.length === 0) {
    return Response.json({ error: 'events must be a non-empty array' }, { status: 400 })
  }
  if (incoming.length > 500) {
    return Response.json({ error: 'batch limit is 500 events' }, { status: 413 })
  }
  if (!incoming.every(isEvent)) {
    return Response.json({ error: 'malformed event in batch' }, { status: 400 })
  }

  const results = incoming.map((event) => {
    const result = submitEvent(id, event)
    return {
      clientEventId: event.clientEventId,
      status: result.status,
      serverReceivedAt: result.event.serverReceivedAt,
      duel: result.duel,
    }
  })

  return Response.json({ results })
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const session = getSession(id)
  if (!session) return Response.json({ events: [], duels: [] })
  return Response.json({
    events: [...session.events.values()],
    duels: session.duels,
  })
}
