/**
 * Playback intent in, transport state out.
 *
 * The client says what the operator did; the server decides whether they were
 * allowed to, stamps the arrival time, bumps the epoch and broadcasts. A refusal
 * returns 403 with the current state, so a client that tried to seek without the
 * lead snaps back to the session rather than diverging silently.
 */

import { applyIntent } from '@/lib/server/store'
import type { TransportIntent } from '@/lib/protocol'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = (await request.json()) as Partial<TransportIntent>

  if (
    (body.role !== 'home' && body.role !== 'away') ||
    (body.state !== 'playing' && body.state !== 'paused') ||
    typeof body.rate !== 'number' ||
    !Number.isFinite(body.rate) ||
    body.rate <= 0 ||
    typeof body.anchor !== 'number' ||
    !Number.isFinite(body.anchor) ||
    (body.mode !== 'live' && body.mode !== 'vod') ||
    (body.leadMediaTime !== undefined &&
      body.leadMediaTime !== null &&
      (typeof body.leadMediaTime !== 'number' || !Number.isFinite(body.leadMediaTime))) ||
    (body.reason !== 'play' && body.reason !== 'pause' && body.reason !== 'seek' && body.reason !== 'rate')
  ) {
    return Response.json({ error: 'invalid intent' }, { status: 400 })
  }

  const result = applyIntent(id, body as TransportIntent)
  if (result.ok) return Response.json(result)
  // 409 for a units mismatch, 403 for an authority refusal: one is a bug in the
  // client, the other is the rules working.
  return Response.json(result, { status: result.refusedBecause === 'mode-mismatch' ? 409 : 403 })
}
