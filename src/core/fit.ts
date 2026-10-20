import type { FitMode } from '@shared/protocol'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Where to draw a `srcW`x`srcH` clip inside a `dstW`x`dstH` target, in target pixels.
 * The result is centered; `cover` and `original` may extend past the target edges.
 */
export function fitRect(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  mode: FitMode,
): Rect {
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return { x: 0, y: 0, w: 0, h: 0 }
  let w: number
  let h: number
  switch (mode) {
    case 'stretch':
      return { x: 0, y: 0, w: dstW, h: dstH }
    case 'original':
      w = srcW
      h = srcH
      break
    case 'contain':
    case 'cover': {
      const scaleX = dstW / srcW
      const scaleY = dstH / srcH
      const s = mode === 'contain' ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY)
      w = srcW * s
      h = srcH * s
      break
    }
  }
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h }
}
