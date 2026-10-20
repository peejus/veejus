import type { Placement } from '@shared/layers'
import { fitRect } from './fit'

/** Where to draw a clip: center, size and rotation in output pixels (y down). */
export interface Transform {
  cx: number
  cy: number
  w: number
  h: number
  /** Radians, clockwise on screen. */
  rotation: number
}

/** Gap kept between corner-anchored clips and the screen edge, as a fraction of height. */
export const EDGE_MARGIN = 0.04

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Overshoots to ~110% then settles: the "pop". */
export function easeOutBack(t: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  const x = clamp01(t) - 1
  return 1 + c3 * x * x * x + c1 * x * x
}

export function easeOutCubic(t: number): number {
  const x = 1 - clamp01(t)
  return 1 - x * x * x
}

export interface PlaceOptions {
  /** 0 = entrance just started, 1 = finished (or no entrance). */
  entranceProgress?: number
  /** Random spot for the 'random' anchor, each component 0..1. */
  random?: [number, number]
}

/** Lay out a `clipW` x `clipH` clip in a `outW` x `outH` output. */
export function placeClip(
  clipW: number,
  clipH: number,
  outW: number,
  outH: number,
  p: Placement,
  opts: PlaceOptions = {},
): Transform {
  let cx: number
  let cy: number
  let w: number
  let h: number
  if (clipW <= 0 || clipH <= 0 || outW <= 0 || outH <= 0)
    return { cx: 0, cy: 0, w: 0, h: 0, rotation: 0 }

  if (p.anchor === 'full') {
    const r = fitRect(clipW, clipH, outW, outH, p.fit)
    w = r.w
    h = r.h
    cx = r.x + r.w / 2
    cy = r.y + r.h / 2
  } else {
    h = p.size * outH
    w = (h * clipW) / clipH
    const m = EDGE_MARGIN * outH
    const left = m + w / 2
    const right = outW - m - w / 2
    const top = m + h / 2
    const bottom = outH - m - h / 2
    switch (p.anchor) {
      case 'center':
        cx = outW / 2
        cy = outH / 2
        break
      case 'topLeft':
        cx = left
        cy = top
        break
      case 'topRight':
        cx = right
        cy = top
        break
      case 'bottomLeft':
        cx = left
        cy = bottom
        break
      case 'bottomRight':
        cx = right
        cy = bottom
        break
      case 'random': {
        const [rx, ry] = opts.random ?? [0.5, 0.5]
        // If the clip is wider/taller than the free space, keep it centered on that axis.
        cx = right > left ? lerp(left, right, rx) : outW / 2
        cy = bottom > top ? lerp(top, bottom, ry) : outH / 2
        break
      }
    }
  }

  cx += p.offsetX * outW
  cy += p.offsetY * outH

  const t = p.entrance === 'none' ? 1 : clamp01(opts.entranceProgress ?? 1)
  if (t < 1) {
    const e = easeOutCubic(t)
    switch (p.entrance) {
      case 'pop': {
        const s = Math.max(0, easeOutBack(t))
        w *= s
        h *= s
        break
      }
      case 'slideLeft':
        cx = lerp(-w / 2, cx, e)
        break
      case 'slideRight':
        cx = lerp(outW + w / 2, cx, e)
        break
      case 'slideUp':
        cy = lerp(outH + h / 2, cy, e)
        break
      case 'slideDown':
        cy = lerp(-h / 2, cy, e)
        break
    }
  }
  return { cx, cy, w, h, rotation: (p.rotationDeg * Math.PI) / 180 }
}
