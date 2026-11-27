/** A strip of small frames across a video, for the trim editor. Cached per clip. */

const STRIP_HEIGHT = 54
const SEEK_TIMEOUT_MS = 5000

const cache = new Map<string, Promise<string[]>>()

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('Timed out seeking')), SEEK_TIMEOUT_MS)
    const done = (err?: Error) => {
      clearTimeout(timer)
      v.removeEventListener('seeked', onSeeked)
      v.removeEventListener('error', onError)
      if (err) reject(err)
      else resolve()
    }
    const onSeeked = () => done()
    const onError = () => done(new Error('Could not read video'))
    v.addEventListener('seeked', onSeeked)
    v.addEventListener('error', onError)
    v.currentTime = t
  })
}

async function build(url: string, durationMs: number, count: number): Promise<string[]> {
  const v = document.createElement('video')
  v.crossOrigin = 'anonymous'
  v.muted = true
  v.preload = 'auto'
  v.src = url
  try {
    await new Promise<void>((resolve, reject) => {
      v.addEventListener('loadeddata', () => resolve(), { once: true })
      v.addEventListener('error', () => reject(new Error('Could not read video')), { once: true })
    })
    const h = STRIP_HEIGHT
    const w = Math.max(1, Math.round((h * v.videoWidth) / Math.max(1, v.videoHeight)))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    const frames: string[] = []
    for (let i = 0; i < count; i++) {
      await seek(v, ((i + 0.5) / count) * (durationMs / 1000))
      ctx.drawImage(v, 0, 0, w, h)
      frames.push(canvas.toDataURL('image/jpeg', 0.7))
    }
    return frames
  } finally {
    v.removeAttribute('src')
    v.load()
  }
}

/** `count` evenly spaced frames of a video as data URLs (cached; a failure isn't). */
export function thumbStrip(
  id: string,
  url: string,
  durationMs: number,
  count: number,
): Promise<string[]> {
  const key = `${id}:${count}`
  let p = cache.get(key)
  if (!p) {
    p = build(url, durationMs, count)
    p.catch(() => cache.delete(key))
    cache.set(key, p)
  }
  return p
}
