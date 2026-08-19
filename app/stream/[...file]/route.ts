/**
 * Serves the locally generated live stream.
 *
 * This exists because of a trap worth knowing about: Next's `public/` directory is
 * indexed at build time, so a production server returns 404 for any file created
 * afterwards. A live stream is nothing but files created afterwards. The symptom is
 * confusing — the playlist loads (it existed at build time), the player reports no
 * error worth reading, and the video simply never buffers.
 *
 * So the stream is written outside `public/` and read from disk per request. That
 * also keeps MPEG-TS segments away from a directory the TypeScript compiler walks,
 * since `.ts` means two different things here.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { Readable } from 'node:stream'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ROOT = join(process.cwd(), '.stream')

const CONTENT_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string[] }> },
) {
  const { file } = await params
  const relative = normalize(file.join('/'))
  if (relative.startsWith('..') || relative.startsWith('/')) {
    return new Response('not found', { status: 404 })
  }

  const absolute = join(ROOT, relative)
  try {
    const info = await stat(absolute)
    if (!info.isFile()) return new Response('not found', { status: 404 })

    const extension = relative.slice(relative.lastIndexOf('.'))
    const body = Readable.toWeb(createReadStream(absolute)) as ReadableStream
    return new Response(body, {
      headers: {
        'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
        'Content-Length': String(info.size),
        // A live playlist that gets cached is a live playlist that stops updating.
        'Cache-Control': 'no-store, no-transform',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch {
    // A segment can be deleted between the playlist listing it and a client asking
    // for it. That is ordinary for a rolling window, and the player retries.
    return new Response('not found', { status: 404 })
  }
}
