import type { FrameStatsSnapshot } from '@shared/protocol'

/**
 * Rolling frame-timing statistics over a fixed time window.
 * Pure: feed it frame timestamps (ms), read snapshots. No DOM dependency.
 */
export class FrameStats {
  private readonly times: number[] = []

  constructor(
    private readonly windowMs = 1000,
    /** Expected frame interval; frames longer than 1.5x this count as dropped. */
    private readonly expectedFrameMs = 1000 / 60,
  ) {}

  /** Record a frame presented at `timestampMs`. Timestamps must be non-decreasing. */
  push(timestampMs: number): void {
    this.times.push(timestampMs)
    const cutoff = timestampMs - this.windowMs
    // Keep one sample at or before the cutoff so the first interval in the window is measurable.
    while (this.times.length > 2 && this.times[1]! <= cutoff) this.times.shift()
  }

  snapshot(): FrameStatsSnapshot {
    const n = this.times.length
    if (n < 2) return { fps: 0, frameTimeAvgMs: 0, frameTimeMaxMs: 0, droppedFrames: 0 }
    let max = 0
    let dropped = 0
    for (let i = 1; i < n; i++) {
      const dt = this.times[i]! - this.times[i - 1]!
      if (dt > max) max = dt
      if (dt > this.expectedFrameMs * 1.5) dropped++
    }
    const span = this.times[n - 1]! - this.times[0]!
    const avg = span / (n - 1)
    return {
      fps: avg > 0 ? 1000 / avg : 0,
      frameTimeAvgMs: avg,
      frameTimeMaxMs: max,
      droppedFrames: dropped,
    }
  }

  reset(): void {
    this.times.length = 0
  }
}
