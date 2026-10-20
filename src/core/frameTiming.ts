/**
 * Timing for frame-based (animated image) clips: GIF, animated WebP, APNG.
 */

/**
 * Browsers treat very short GIF delays (0 or 10 ms, common in old GIFs) as 100 ms.
 * Chromium applies this to any delay under 11 ms; we match it so clips look the same
 * as in a browser.
 */
export const SHORT_DELAY_THRESHOLD_MS = 11
export const SHORT_DELAY_REPLACEMENT_MS = 100

export function normalizeFrameDurations(durationsMs: readonly number[]): number[] {
  return durationsMs.map((d) =>
    !Number.isFinite(d) || d < SHORT_DELAY_THRESHOLD_MS ? SHORT_DELAY_REPLACEMENT_MS : d,
  )
}

export interface FramePosition {
  index: number
  /** True once a non-looping playthrough has passed the end of the last frame. */
  done: boolean
}

/** Maps elapsed play time to a frame index. Durations are used as given; normalize first. */
export class FrameTimeline {
  /** End time of each frame, cumulative from 0. */
  private readonly ends: number[]
  readonly totalMs: number

  constructor(durationsMs: readonly number[]) {
    if (durationsMs.length === 0) throw new Error('FrameTimeline needs at least one frame')
    let t = 0
    this.ends = durationsMs.map((d) => (t += Math.max(0, d)))
    this.totalMs = t
  }

  get frameCount(): number {
    return this.ends.length
  }

  frameAt(elapsedMs: number, loop: boolean): FramePosition {
    const last = this.ends.length - 1
    if (last === 0 || this.totalMs <= 0)
      return { index: 0, done: !loop && elapsedMs >= this.totalMs }
    if (elapsedMs < 0) return { index: 0, done: false }
    if (!loop && elapsedMs >= this.totalMs) return { index: last, done: true }

    const t = loop ? elapsedMs % this.totalMs : elapsedMs
    // First frame whose end is after t.
    let lo = 0
    let hi = last
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.ends[mid]! > t) hi = mid
      else lo = mid + 1
    }
    return { index: lo, done: false }
  }
}
