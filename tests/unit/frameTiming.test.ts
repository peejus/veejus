import { describe, expect, it } from 'vitest'
import { FrameTimeline, normalizeFrameDurations } from '@core/frameTiming'

describe('normalizeFrameDurations', () => {
  it('replaces browser-clamped short delays with 100 ms', () => {
    expect(normalizeFrameDurations([0, 10, 11, 20, 100])).toEqual([100, 100, 11, 20, 100])
  })

  it('treats missing or invalid delays as 100 ms', () => {
    expect(normalizeFrameDurations([NaN, Infinity, -5])).toEqual([100, 100, 100])
  })
})

describe('FrameTimeline', () => {
  const tl = new FrameTimeline([100, 50, 200]) // ends at 100, 150, 350

  it('reports total duration and frame count', () => {
    expect(tl.totalMs).toBe(350)
    expect(tl.frameCount).toBe(3)
  })

  it('maps times to frames at the boundaries', () => {
    expect(tl.frameAt(0, true).index).toBe(0)
    expect(tl.frameAt(99.9, true).index).toBe(0)
    expect(tl.frameAt(100, true).index).toBe(1)
    expect(tl.frameAt(149, true).index).toBe(1)
    expect(tl.frameAt(150, true).index).toBe(2)
    expect(tl.frameAt(349, true).index).toBe(2)
  })

  it('wraps when looping', () => {
    expect(tl.frameAt(350, true)).toEqual({ index: 0, done: false })
    expect(tl.frameAt(350 * 7 + 120, true)).toEqual({ index: 1, done: false })
  })

  it('holds the last frame and reports done for one-shot playback', () => {
    expect(tl.frameAt(349, false)).toEqual({ index: 2, done: false })
    expect(tl.frameAt(350, false)).toEqual({ index: 2, done: true })
    expect(tl.frameAt(10_000, false)).toEqual({ index: 2, done: true })
  })

  it('treats negative time as the first frame', () => {
    expect(tl.frameAt(-10, false)).toEqual({ index: 0, done: false })
  })

  it('handles single-frame (still) images', () => {
    const still = new FrameTimeline([100])
    expect(still.frameAt(5000, true)).toEqual({ index: 0, done: false })
    expect(still.frameAt(50, false)).toEqual({ index: 0, done: false })
    expect(still.frameAt(100, false)).toEqual({ index: 0, done: true })
  })

  it('plays faster when elapsed time is scaled by speed', () => {
    // A 2x speed playhead accumulates 2 ms per real ms: 60 real ms -> 120 ms -> frame 1.
    expect(tl.frameAt(60 * 2, true).index).toBe(1)
  })

  it('rejects empty timelines', () => {
    expect(() => new FrameTimeline([])).toThrow()
  })
})
