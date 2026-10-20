import { describe, expect, it } from 'vitest'
import { DEFAULT_PLACEMENT, isPlacement, type Placement } from '@shared/layers'
import { EDGE_MARGIN, easeOutBack, placeClip } from '@core/placement'

const OUT_W = 1920
const OUT_H = 1080
const place = (over: Partial<Placement>, opts = {}) =>
  placeClip(640, 360, OUT_W, OUT_H, { ...DEFAULT_PLACEMENT, ...over }, opts)

describe('placeClip', () => {
  it('full screen uses the fit mode', () => {
    expect(place({ anchor: 'full', fit: 'contain' })).toEqual({
      cx: 960,
      cy: 540,
      w: 1920,
      h: 1080,
      rotation: 0,
    })
    const contain43 = placeClip(400, 300, OUT_W, OUT_H, { ...DEFAULT_PLACEMENT, fit: 'contain' })
    expect(contain43.w).toBeCloseTo(1440)
    expect(contain43.h).toBeCloseTo(1080)
  })

  it('sizes non-full clips by output height and keeps the aspect ratio', () => {
    const t = place({ anchor: 'center', size: 0.5 })
    expect(t).toMatchObject({ cx: 960, cy: 540, h: 540, w: 960 })
  })

  it('anchors corners inside a margin', () => {
    const m = EDGE_MARGIN * OUT_H
    const tl = place({ anchor: 'topLeft', size: 0.25 })
    expect(tl.cx - tl.w / 2).toBeCloseTo(m)
    expect(tl.cy - tl.h / 2).toBeCloseTo(m)
    const br = place({ anchor: 'bottomRight', size: 0.25 })
    expect(br.cx + br.w / 2).toBeCloseTo(OUT_W - m)
    expect(br.cy + br.h / 2).toBeCloseTo(OUT_H - m)
    const tr = place({ anchor: 'topRight', size: 0.25 })
    const bl = place({ anchor: 'bottomLeft', size: 0.25 })
    expect(tr.cx).toBeCloseTo(br.cx)
    expect(bl.cy).toBeCloseTo(br.cy)
  })

  it('random spots stay fully on screen', () => {
    for (const r of [
      [0, 0],
      [1, 1],
      [0.3, 0.8],
    ] as [number, number][]) {
      const t = place({ anchor: 'random', size: 0.3 }, { random: r })
      expect(t.cx - t.w / 2).toBeGreaterThanOrEqual(0)
      expect(t.cx + t.w / 2).toBeLessThanOrEqual(OUT_W)
      expect(t.cy - t.h / 2).toBeGreaterThanOrEqual(0)
      expect(t.cy + t.h / 2).toBeLessThanOrEqual(OUT_H)
    }
  })

  it('applies offsets and rotation', () => {
    const t = place({ anchor: 'center', size: 0.2, offsetX: 0.1, offsetY: -0.25, rotationDeg: 90 })
    expect(t.cx).toBeCloseTo(960 + 192)
    expect(t.cy).toBeCloseTo(540 - 270)
    expect(t.rotation).toBeCloseTo(Math.PI / 2)
  })

  it('pop scales in from nothing with an overshoot, then settles', () => {
    const at = (p: number) =>
      place({ anchor: 'center', size: 0.5, entrance: 'pop' }, { entranceProgress: p })
    expect(at(0).w).toBeCloseTo(0)
    expect(Math.max(...[0.5, 0.6, 0.7, 0.8].map((p) => at(p).w))).toBeGreaterThan(960)
    expect(at(1).w).toBeCloseTo(960)
    expect(easeOutBack(1)).toBeCloseTo(1)
  })

  it('slides start fully off the named edge and end at the target', () => {
    const target = place({ anchor: 'center', size: 0.5 })
    const left = place(
      { anchor: 'center', size: 0.5, entrance: 'slideLeft' },
      { entranceProgress: 0 },
    )
    expect(left.cx + left.w / 2).toBeCloseTo(0)
    const right = place(
      { anchor: 'center', size: 0.5, entrance: 'slideRight' },
      { entranceProgress: 0 },
    )
    expect(right.cx - right.w / 2).toBeCloseTo(OUT_W)
    const up = place({ anchor: 'center', size: 0.5, entrance: 'slideUp' }, { entranceProgress: 0 })
    expect(up.cy - up.h / 2).toBeCloseTo(OUT_H)
    const down = place(
      { anchor: 'center', size: 0.5, entrance: 'slideDown' },
      { entranceProgress: 0 },
    )
    expect(down.cy + down.h / 2).toBeCloseTo(0)
    const done = place(
      { anchor: 'center', size: 0.5, entrance: 'slideLeft' },
      { entranceProgress: 1 },
    )
    expect(done).toEqual(target)
  })

  it('validates placements', () => {
    expect(isPlacement(DEFAULT_PLACEMENT)).toBe(true)
    expect(isPlacement({ ...DEFAULT_PLACEMENT, anchor: 'middle' })).toBe(false)
    expect(isPlacement({ ...DEFAULT_PLACEMENT, size: 0 })).toBe(false)
  })
})
