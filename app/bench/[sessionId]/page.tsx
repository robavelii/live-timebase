import { BenchClient } from './BenchClient'

export default async function BenchPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>
  searchParams: Promise<{ src?: string }>
}) {
  const { sessionId } = await params
  const query = await searchParams
  return <BenchClient sessionId={sessionId} src={query.src ?? '/stream/index.m3u8'} />
}
