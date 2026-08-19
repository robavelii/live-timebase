import { report } from '@/lib/server/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const data = report(id)
  if (!data) return Response.json({ error: 'unknown session' }, { status: 404 })
  return Response.json(data)
}
