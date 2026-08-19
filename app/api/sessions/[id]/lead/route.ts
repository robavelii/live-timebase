import { getSnapshot, transferLead } from '@/lib/server/store'
import type { CollectorRole } from '@/lib/protocol'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = (await request.json()) as { role?: CollectorRole }
  if (body.role !== 'home' && body.role !== 'away') {
    return Response.json({ error: 'role must be home or away' }, { status: 400 })
  }
  transferLead(id, body.role)
  return Response.json(getSnapshot(id))
}
