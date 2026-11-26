/**
 * Auto-play: the output steps through the library on the beat, one clip after another, with
 * no pads needed. Shared by the control (settings UI), the output (scheduler) and sets.
 */

import { isLayerId, type LayerId } from './layers'
import { isTag } from './pads'
import type { FitMode } from './protocol'

/** What auto-play cycles through. */
export type AutoSource =
  /** Stills and animated images (GIF, WebP, APNG): the default. */
  | { kind: 'images' }
  /** Everything in the library, videos too. */
  | { kind: 'all' }
  | { kind: 'collection'; tag: string }
  | { kind: 'favorites' }

/**
 * Beats per clip. 'auto': stills hold one bar, and animated clips play through once,
 * stretched a little so the change lands on the beat (1, 2, 4, 8 or 16 beats).
 */
export type AutoStep = 'auto' | 1 | 2 | 4 | 8 | 16
export const AUTO_STEPS: readonly AutoStep[] = ['auto', 1, 2, 4, 8, 16]
export const AUTO_STEP_LABELS: Record<string, string> = {
  auto: 'Auto (each GIF plays once)',
  1: 'Every beat',
  2: 'Every 2 beats',
  4: 'Every bar',
  8: 'Every 2 bars',
  16: 'Every 4 bars',
}

export type AutoOrder = 'inOrder' | 'shuffle'

/** Beat-locked effects auto-play can put on still photos. */
export const PHOTO_FX_TYPES = [
  'pulse',
  'fold',
  'bounce',
  'pixelSpin',
  'wave',
  'slice',
  'twirl',
  'mystify',
] as const
export type PhotoFxType = (typeof PHOTO_FX_TYPES)[number]
/** 'mix' gives each photo the next effect in turn. */
export type PhotoFx = 'none' | PhotoFxType | 'mix'
export const PHOTO_FX: readonly PhotoFx[] = ['none', ...PHOTO_FX_TYPES, 'mix']
export const PHOTO_FX_LABELS: Record<PhotoFx, string> = {
  none: 'None',
  pulse: 'Pulse',
  fold: 'Fold',
  bounce: 'Bounce',
  pixelSpin: 'Pixel spin',
  wave: 'Wave',
  slice: 'Slice',
  twirl: 'Twirl',
  mystify: 'Mystify lines',
  mix: 'Mix (a different one each photo)',
}

export interface AutoPlaySettings {
  enabled: boolean
  source: AutoSource
  step: AutoStep
  order: AutoOrder
  layer: LayerId
  fit: FitMode
  /** Effect on still photos while auto-play shows them (missing in older settings: none). */
  photoFx?: PhotoFx
}

export const DEFAULT_AUTO_PLAY: AutoPlaySettings = {
  enabled: false,
  source: { kind: 'images' },
  step: 'auto',
  order: 'inOrder',
  layer: 'background',
  fit: 'cover',
  photoFx: 'none',
}

/** Pad id the auto-play voice uses in the scheduler (and in "what's on each layer"). */
export const AUTO_PAD_ID = 'auto'

/** Clip lengths auto steps snap to, in beats. */
export const AUTO_SNAP_BEATS = [1, 2, 4, 8, 16] as const
/** A still image holds this long with the 'auto' step. */
export const AUTO_STILL_BEATS = 4

/**
 * How many beats a clip gets with the 'auto' step: one bar for a still, otherwise its natural
 * length at the current tempo snapped to the nearest of 1/2/4/8/16 beats (on a log scale, so
 * 3 beats rounds to 4 and 1.4 to 1).
 */
export function autoStepBeats(durationMs: number | null, bpm: number): number {
  if (durationMs === null || !(durationMs > 0) || !(bpm > 0)) return AUTO_STILL_BEATS
  const beats = durationMs / (60000 / bpm)
  let best: number = AUTO_SNAP_BEATS[0]
  for (const b of AUTO_SNAP_BEATS)
    if (Math.abs(Math.log2(beats / b)) < Math.abs(Math.log2(beats / best))) best = b
  return best
}

/** What auto-play is doing, for the control's display. */
export interface AutoPlayStatus {
  enabled: boolean
  /** Clip showing now (null until the first step). */
  clipId: string | null
  /** Clip coming up next (already loading). */
  nextClipId: string | null
  /** Beats until the next change. */
  beatsToNext: number | null
  /** Held because a pad is playing on the auto-play layer. */
  yielding: boolean
}

// ---- Guards -----------------------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const FITS: readonly FitMode[] = ['contain', 'cover', 'stretch', 'original']

export function isAutoSource(v: unknown): v is AutoSource {
  if (!isObj(v)) return false
  if (v.kind === 'collection') return isTag(v.tag)
  return v.kind === 'images' || v.kind === 'all' || v.kind === 'favorites'
}

export function isAutoPlaySettings(v: unknown): v is AutoPlaySettings {
  return (
    isObj(v) &&
    typeof v.enabled === 'boolean' &&
    isAutoSource(v.source) &&
    AUTO_STEPS.includes(v.step as AutoStep) &&
    (v.order === 'inOrder' || v.order === 'shuffle') &&
    isLayerId(v.layer) &&
    FITS.includes(v.fit as FitMode) &&
    (v.photoFx === undefined || PHOTO_FX.includes(v.photoFx as PhotoFx))
  )
}

const isNumOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v))
const isStrOrNull = (v: unknown) => v === null || (typeof v === 'string' && v.length <= 64)

export function isAutoPlayStatus(v: unknown): v is AutoPlayStatus {
  return (
    isObj(v) &&
    typeof v.enabled === 'boolean' &&
    isStrOrNull(v.clipId) &&
    isStrOrNull(v.nextClipId) &&
    isNumOrNull(v.beatsToNext) &&
    typeof v.yielding === 'boolean'
  )
}
