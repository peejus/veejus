/** Output picture options (Phase 8): render resolution and aspect-ratio letterbox. */

/** `fill` uses the whole output window; the others letterbox (black bars) to that shape. */
export const ASPECTS = ['fill', '16:9', '4:3', '1:1', '9:16'] as const
export type Aspect = (typeof ASPECTS)[number]
export const ASPECT_LABELS: Record<Aspect, string> = {
  fill: 'Fill the screen',
  '16:9': '16:9 (widescreen)',
  '4:3': '4:3',
  '1:1': '1:1 (square)',
  '9:16': '9:16 (portrait / phone)',
}

/**
 * How many pixels the compositor renders. `native` matches the output window; the others cap
 * the longer side's height-equivalent (a 1080p picture on a 4K screen is upscaled by the GPU,
 * which saves GPU time on slower machines).
 */
export const RESOLUTIONS = ['native', '1080p', '720p'] as const
export type Resolution = (typeof RESOLUTIONS)[number]
export const RESOLUTION_LABELS: Record<Resolution, string> = {
  native: 'Native (window size)',
  '1080p': '1080p',
  '720p': '720p (lighter on the GPU)',
}

export interface OutputOptions {
  aspect: Aspect
  resolution: Resolution
}

export const DEFAULT_OUTPUT_OPTIONS: OutputOptions = { aspect: 'fill', resolution: 'native' }

export function isOutputOptions(v: unknown): v is OutputOptions {
  return (
    typeof v === 'object' &&
    v !== null &&
    ASPECTS.includes((v as OutputOptions).aspect) &&
    RESOLUTIONS.includes((v as OutputOptions).resolution)
  )
}

const ASPECT_RATIO: Record<Exclude<Aspect, 'fill'>, number> = {
  '16:9': 16 / 9,
  '4:3': 4 / 3,
  '1:1': 1,
  '9:16': 9 / 16,
}
const RESOLUTION_LINES: Record<Exclude<Resolution, 'native'>, number> = {
  '1080p': 1080,
  '720p': 720,
}

export interface PictureLayout {
  /** Where the picture sits in the window, in device pixels (y down). */
  viewport: { x: number; y: number; width: number; height: number }
  /** The size the compositor renders at. */
  render: { width: number; height: number }
}

/**
 * Where the picture goes in a `windowW` x `windowH` window, and how big to render it.
 * Letterboxing centers the largest box of the chosen shape; the resolution cap scales the
 * render size down (never up) so its shorter side is at most 1080 / 720 lines.
 */
export function pictureLayout(windowW: number, windowH: number, o: OutputOptions): PictureLayout {
  const w = Math.max(1, windowW)
  const h = Math.max(1, windowH)
  let vw = w
  let vh = h
  if (o.aspect !== 'fill') {
    const r = ASPECT_RATIO[o.aspect]
    if (w / h > r) vw = Math.round(h * r)
    else vh = Math.round(w / r)
  }
  const viewport = {
    x: Math.floor((w - vw) / 2),
    y: Math.floor((h - vh) / 2),
    width: vw,
    height: vh,
  }
  let rw = vw
  let rh = vh
  if (o.resolution !== 'native') {
    const lines = RESOLUTION_LINES[o.resolution]
    const scale = Math.min(1, lines / Math.min(vw, vh))
    rw = Math.max(1, Math.round(vw * scale))
    rh = Math.max(1, Math.round(vh * scale))
  }
  return { viewport, render: { width: rw, height: rh } }
}
