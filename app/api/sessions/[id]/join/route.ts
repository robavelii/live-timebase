import { getSnapshot, join, transferLead } from '@/lib/server/store'
import type { CollectorRole, SessionMode, StreamFingerprint } from '@/lib/protocol'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = (await request.json()) as {
    role?: CollectorRole
    mode?: SessionMode
    src?: string
    takeLead?: boolean
    fingerprint?: StreamFingerprint
  }

  if (body.role !== 'home' && body.role !== 'away') {
    return Response.json({ error: 'role must be home or away' }, { status: 400 })
  }

  const result = join(id, body.role, {
    mode: body.mode,
    src: body.src,
    fingerprint: body.fingerprint,
  })

  // 409: the join was refused because this client is not on the session's stream.
  // Nothing about the session changed, and the client must not start collecting.
  if (result.refused) return Response.json(result, { status: 409 })

  if (body.takeLead) transferLead(id, body.role)
  return Response.json({
    ...getSnapshot(id),
    modeMismatch: result.modeMismatch,
    fingerprintMismatches: result.fingerprintMismatches,
    refused: false,
  })
}
