/**
 * Frame-drop watchdog: steps output quality down while the frame rate stays low, and back up
 * once it has been healthy for a while. Quality goes first where the audience won't see it:
 *
 *   level 0  normal
 *   level 1  preview monitor at a lower rate and size
 *   level 2  preview monitor off
 *   level 3  render the picture at 75% (the GPU scales it up)
 */

export const MAX_LEVEL = 3
/** Below this many fps counts as struggling. */
export const LOW_FPS = 52
/** At or above this counts as healthy. */
export const GOOD_FPS = 58.5
/** Struggling this long steps down one level. */
export const DEGRADE_AFTER_MS = 3000
/** Healthy this long steps back up one level. */
export const RECOVER_AFTER_MS = 15000

export const LEVEL_LABELS = [
  'Normal',
  'Preview monitor reduced',
  'Preview monitor paused',
  'Picture rendered at 75%',
] as const

export class Watchdog {
  level = 0
  private lowSince: number | null = null
  private goodSince: number | null = null

  /** Feed the rolling fps; returns the new level when it changes, else null. */
  update(fps: number, nowMs: number): number | null {
    if (fps < LOW_FPS) {
      this.goodSince = null
      this.lowSince ??= nowMs
      if (nowMs - this.lowSince >= DEGRADE_AFTER_MS && this.level < MAX_LEVEL) {
        this.level++
        this.lowSince = nowMs // give the change time to work before stepping again
        return this.level
      }
    } else if (fps >= GOOD_FPS) {
      this.lowSince = null
      this.goodSince ??= nowMs
      if (nowMs - this.goodSince >= RECOVER_AFTER_MS && this.level > 0) {
        this.level--
        this.goodSince = nowMs
        return this.level
      }
    } else {
      // In between: neither clock runs.
      this.lowSince = null
      this.goodSince = null
    }
    return null
  }

  reset(): void {
    this.level = 0
    this.lowSince = null
    this.goodSince = null
  }
}
