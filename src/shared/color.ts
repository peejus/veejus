import type { Rgb } from './protocol'

/** Parse `#rrggbb` into 0..1 RGB. Returns null for anything else. */
export function hexToRgb(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return null
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255]
}

export function rgbToHex(rgb: Rgb): string {
  return (
    '#' +
    rgb
      .map((c) =>
        Math.round(Math.min(1, Math.max(0, c)) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  )
}
