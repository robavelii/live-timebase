import { CollectorConsole } from './CollectorConsole'
import type { CollectorRole } from '@/lib/protocol'

export default async function CollectPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>
  searchParams: Promise<{ role?: string; src?: string }>
}) {
  const { sessionId } = await params
  const query = await searchParams
  const role: CollectorRole = query.role === 'away' ? 'away' : 'home'
  const src = query.src ?? '/stream/index.m3u8'

  return <CollectorConsole sessionId={sessionId} role={role} src={src} />
}
