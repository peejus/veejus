/** Trim range helpers for the trim editor (pure, unit-tested). */

import { MIN_TRIM_MS, type ClipTrim } from './protocol'

export type TrimEdge = 'in' | 'out'

/** 0:03.4 */
export function formatClipTime(ms: number): string {
  const s = Math.max(0, ms) / 1000
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`
}

/** Clamp a range to the clip, at least MIN_TRIM_MS long. */
export function clampTrim(inMs: number, outMs: number, durationMs: number, moved: TrimEdge) {
  const d = Math.max(MIN_TRIM_MS, durationMs)
  let a = Math.min(Math.max(0, inMs), d - MIN_TRIM_MS)
  let b = Math.min(Math.max(MIN_TRIM_MS, outMs), d)
  if (b - a < MIN_TRIM_MS) {
    if (moved === 'in') a = b - MIN_TRIM_MS
    else b = a + MIN_TRIM_MS
  }
  return { inMs: Math.round(a), outMs: Math.round(b) }
}

/** What to store for a range: null when it's the whole clip, outMs null when it runs to the end. */
export function trimFor(inMs: number, outMs: number, durationMs: number): ClipTrim | null {
  const toEnd = outMs >= durationMs - 1
  if (inMs <= 0 && toEnd) return null
  return { inMs, outMs: toEnd ? null : outMs }
}
