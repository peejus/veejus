import { FrameTimeline, normalizeFrameDurations } from '@core/frameTiming'
import type { ClipInfo } from '@shared/protocol'

/** A still image "plays" for this long (one-shot pads, tempo sync). */
export const STILL_DURATION_MS = 2000

/** ImageDecoder may not know image/apng; APNG is just PNG to it. */
function decoderType(mime: string): string {
  return mime === 'image/apng' ? 'image/png' : mime
}

/**
 * A fully decoded still or animated image (GIF, animated WebP, APNG, PNG, JPEG).
 * All frames are held as premultiplied ImageBitmaps, ready for instant upload.
 */
export class ImageClip {
  readonly kind = 'image'

  private constructor(
    readonly info: ClipInfo,
    readonly frames: ImageBitmap[],
    readonly timeline: FrameTimeline,
    readonly width: number,
    readonly height: number,
  ) {}

  static async load(info: ClipInfo): Promise<ImageClip> {
    const type = decoderType(info.mime)
    if (!(await ImageDecoder.isTypeSupported(type))) {
      throw new Error(`Unsupported image type ${info.mime}`)
    }
    const res = await fetch(info.url)
    if (!res.ok || !res.body) throw new Error(`Could not read file (${res.status})`)

    const decoder = new ImageDecoder({ data: res.body, type })
    const frames: ImageBitmap[] = []
    try {
      await decoder.tracks.ready
      await decoder.completed
      const track = decoder.tracks.selectedTrack
      const count = track?.frameCount ?? 0
      if (count === 0) throw new Error('Image has no frames')

      const durations: number[] = []
      for (let i = 0; i < count; i++) {
        const { image } = await decoder.decode({ frameIndex: i })
        try {
          durations.push((image.duration ?? 0) / 1000)
          frames.push(await createImageBitmap(image, { premultiplyAlpha: 'premultiply' }))
        } finally {
          image.close()
        }
      }
      const first = frames[0]!
      return new ImageClip(
        info,
        frames,
        new FrameTimeline(
          frames.length === 1 ? [STILL_DURATION_MS] : normalizeFrameDurations(durations),
        ),
        first.width,
        first.height,
      )
    } catch (err) {
      for (const f of frames) f.close()
      if (err instanceof Error && err.message.startsWith('Image has no')) throw err
      throw new Error('Could not decode image (corrupt or unsupported)', { cause: err })
    } finally {
      decoder.close()
    }
  }

  get frameCount(): number {
    return this.frames.length
  }

  get estimatedBytes(): number {
    return this.width * this.height * 4 * this.frames.length
  }

  dispose(): void {
    for (const f of this.frames) f.close()
    this.frames.length = 0
  }
}
