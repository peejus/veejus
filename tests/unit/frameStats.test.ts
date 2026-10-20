import { describe, expect, it } from 'vitest'
import { FrameStats } from '@core/frameStats'

function feed(stats: FrameStats, intervalsMs: number[], start = 0): number {
  let t = start
  stats.push(t)
  for (const dt of intervalsMs) {
    t += dt
    stats.push(t)
  }
  return t
}

describe('FrameStats', () => {
  it('reports zeros before two frames have been seen', () => {
    const s = new FrameStats()
    expect(s.snapshot().fps).toBe(0)
    s.push(10)
    expect(s.snapshot()).toEqual({ fps: 0, frameTimeAvgMs: 0, frameTimeMaxMs: 0, droppedFrames: 0 })
  })

  it('measures a steady 60 fps stream', () => {
    const s = new FrameStats()
    feed(s, Array(120).fill(1000 / 60))
    const snap = s.snapshot()
    expect(snap.fps).toBeCloseTo(60, 5)
    expect(snap.frameTimeAvgMs).toBeCloseTo(16.667, 2)
    expect(snap.droppedFrames).toBe(0)
  })

  it('counts long frames as dropped and tracks the max', () => {
    const s = new FrameStats()
    feed(s, [16.7, 16.7, 50, 16.7, 33.4, 16.7])
    const snap = s.snapshot()
    expect(snap.droppedFrames).toBe(2)
    expect(snap.frameTimeMaxMs).toBeCloseTo(50, 5)
  })

  it('only considers frames inside the rolling window', () => {
    const s = new FrameStats(1000)
    // One second at 30 fps, then two seconds at 60 fps: the window should see only 60 fps.
    const t = feed(s, Array(30).fill(1000 / 30))
    feed(s, Array(120).fill(1000 / 60), t)
    const snap = s.snapshot()
    expect(snap.fps).toBeCloseTo(60, 1)
    expect(snap.droppedFrames).toBe(0)
  })

  it('reset clears all samples', () => {
    const s = new FrameStats()
    feed(s, [16, 16, 16])
    s.reset()
    expect(s.snapshot().fps).toBe(0)
  })
})
