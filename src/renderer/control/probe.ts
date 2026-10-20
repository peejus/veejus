import type { ClipInfo } from '@shared/protocol'

/** What the control UI knows about a clip from probing it (independent of the output). */
export interface ClipMeta {
  width: number
  height: number
  /** Videos only. */
  durationMs?: number
  /** Images only (1 for stills). */
  frameCount?: number
  /** Transparency seen in the sampled thumbnail frame. */
  hasAlpha: boolean
  /** Object URL of a small PNG thumbnail. */
  thumbUrl: string
}

export type ProbeResult = { ok: true; meta: ClipMeta } | { ok: false; error: string }

const THUMB_WIDTH = 192
const PROBE_TIMEOUT_MS = 15_000
const PROBE_CONCURRENCY = 3

function makeCanvas(srcW: number, srcH: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const scale = Math.min(1, THUMB_WIDTH / srcW)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(srcW * scale))
  canvas.height = Math.max(1, Math.round(srcH * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  return [canvas, ctx]
}

/** True if any pixel of the canvas is noticeably transparent. */
function canvasHasAlpha(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): boolean {
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 250) return true
  return false
}

async function toThumbUrl(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
  if (!blob) throw new Error('Could not encode thumbnail')
  return URL.createObjectURL(blob)
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

function once(target: EventTarget, ok: string, fail = 'error'): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(ok, onOk)
      target.removeEventListener(fail, onFail)
    }
    const onOk = () => {
      cleanup()
      resolve()
    }
    const onFail = () => {
      cleanup()
      reject(new Error('media error'))
    }
    target.addEventListener(ok, onOk)
    target.addEventListener(fail, onFail)
  })
}

async function probeVideo(info: ClipInfo): Promise<ClipMeta> {
  const v = document.createElement('video')
  v.crossOrigin = 'anonymous'
  v.muted = true
  v.preload = 'auto'
  try {
    const loaded = once(v, 'loadeddata')
    v.src = info.url
    await loaded.catch(() => {
      const code = v.error?.code
      throw new Error(
        code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
          ? 'Unsupported format or codec'
          : 'Could not decode video (corrupt file?)',
      )
    })
    if (!v.videoWidth || !v.videoHeight) throw new Error('Video has no picture track')
    const duration = Number.isFinite(v.duration) ? v.duration : 0
    // Grab a frame a little way in; the very first frame is often black.
    const seekTo = Math.min(0.5, duration * 0.25)
    if (seekTo > 0) {
      const seeked = once(v, 'seeked')
      v.currentTime = seekTo
      await seeked
    }
    const [canvas, ctx] = makeCanvas(v.videoWidth, v.videoHeight)
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
    return {
      width: v.videoWidth,
      height: v.videoHeight,
      durationMs: duration * 1000,
      hasAlpha: canvasHasAlpha(canvas, ctx),
      thumbUrl: await toThumbUrl(canvas),
    }
  } finally {
    v.removeAttribute('src')
    v.load()
  }
}

async function probeImage(info: ClipInfo): Promise<ClipMeta> {
  const type = info.mime === 'image/apng' ? 'image/png' : info.mime
  const res = await fetch(info.url)
  if (!res.ok || !res.body) throw new Error('Could not read file')
  const decoder = new ImageDecoder({ data: res.body, type })
  try {
    let frameCount: number
    let image: VideoFrame
    try {
      await decoder.tracks.ready
      await decoder.completed
      frameCount = decoder.tracks.selectedTrack?.frameCount ?? 0
      if (frameCount === 0) throw new Error()
      image = (await decoder.decode({ frameIndex: 0 })).image
    } catch {
      throw new Error('Could not decode image (corrupt or unsupported)')
    }
    try {
      const w = image.displayWidth
      const h = image.displayHeight
      const [canvas, ctx] = makeCanvas(w, h)
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      return {
        width: w,
        height: h,
        frameCount,
        hasAlpha: canvasHasAlpha(canvas, ctx),
        thumbUrl: await toThumbUrl(canvas),
      }
    } finally {
      image.close()
    }
  } finally {
    decoder.close()
  }
}

export async function probeClip(info: ClipInfo): Promise<ProbeResult> {
  try {
    const meta = await withTimeout(
      info.kind === 'video' ? probeVideo(info) : probeImage(info),
      PROBE_TIMEOUT_MS,
      'Timed out reading clip',
    )
    return { ok: true, meta }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Runs probes a few at a time so a big import fills in progressively without stalling the UI. */
export class ProbeQueue {
  private readonly queue: ClipInfo[] = []
  private readonly queued = new Set<string>()
  private active = 0

  constructor(private readonly onResult: (id: string, result: ProbeResult) => void) {}

  enqueue(clips: readonly ClipInfo[]): void {
    for (const c of clips) {
      if (this.queued.has(c.id)) continue
      this.queued.add(c.id)
      this.queue.push(c)
    }
    this.pump()
  }

  /** Forget a clip so it is skipped if still queued, and can be probed again later. */
  forget(id: string): void {
    this.queued.delete(id)
  }

  private pump(): void {
    while (this.active < PROBE_CONCURRENCY && this.queue.length > 0) {
      const clip = this.queue.shift()!
      if (!this.queued.has(clip.id)) continue
      this.active++
      void probeClip(clip)
        .then((result) => {
          if (this.queued.has(clip.id)) this.onResult(clip.id, result)
          else if (result.ok) URL.revokeObjectURL(result.meta.thumbUrl)
        })
        .finally(() => {
          this.active--
          this.pump()
        })
    }
  }
}
