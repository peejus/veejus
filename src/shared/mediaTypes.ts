/** How a clip is decoded and played. */
export type ClipKind = 'video' | 'image'

export interface MediaType {
  kind: ClipKind
  mime: string
}

/**
 * Supported file extensions. `image` covers stills and animated images (GIF, WebP, APNG),
 * which are all decoded with WebCodecs ImageDecoder.
 */
const MEDIA_TYPES: Record<string, MediaType> = {
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  png: { kind: 'image', mime: 'image/png' },
  apng: { kind: 'image', mime: 'image/apng' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
}

export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function mediaTypeFor(path: string): MediaType | null {
  return MEDIA_TYPES[extensionOf(path)] ?? null
}

export function isSupportedMedia(path: string): boolean {
  return mediaTypeFor(path) !== null
}

/** Custom scheme the renderers use to load imported media from disk. */
export const MEDIA_SCHEME = 'veejus-media'

export function clipUrl(id: string): string {
  return `${MEDIA_SCHEME}://clip/${id}`
}
