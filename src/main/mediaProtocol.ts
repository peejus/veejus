import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { parseRange } from '@shared/httpRange'
import { MEDIA_SCHEME, mediaTypeFor } from '@shared/mediaTypes'
import type { Library } from './library'

/** Must run before app 'ready'. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ])
}

/**
 * Serve `veejus-media://clip/<id>` from disk. Only clips registered in the library are
 * reachable, so a renderer cannot read arbitrary files. Range requests are supported so
 * video elements can seek.
 */
export function handleMediaProtocol(library: Library): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    const id = url.pathname.replace(/^\/+/, '')
    const path = url.hostname === 'clip' ? library.pathFor(id) : undefined
    if (!path) return new Response('Not found', { status: 404 })

    let size: number
    try {
      size = (await stat(path)).size
    } catch {
      return new Response('Not found', { status: 404 })
    }

    const headers = new Headers({
      'Content-Type': mediaTypeFor(path)?.mime ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      // Renderers load these cross-origin (fetch for ImageDecoder, video textures for WebGL).
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    })

    const range = parseRange(request.headers.get('Range'), size)
    if (range === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${size}`)
      return new Response(null, { status: 416, headers })
    }

    const start = range?.start ?? 0
    const end = range?.end ?? size - 1
    headers.set('Content-Length', String(size === 0 ? 0 : end - start + 1))
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    if (request.method === 'HEAD' || size === 0) {
      return new Response(null, { status: range ? 206 : 200, headers })
    }

    const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
    return new Response(body, { status: range ? 206 : 200, headers })
  })
}
