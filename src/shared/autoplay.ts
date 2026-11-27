/**
 * Auto-play: the output steps through the library on the beat, one clip after another, with
 * no pads needed. Shared by the control (settings UI), the output (scheduler) and sets.
 */

import { isLayerId, type LayerId } from './layers'
import { isTag } from './pads'
import type { FitMode } from './protocol'

/** What auto-play cycles through. */
export type AutoSource =
  /** Stills and animated images (GIF, WebP, APNG). */
  | { kind: 'images' }
  /** Videos only (MP4, WebM, MOV). */
  | { kind: 'videos' }
  /** Everything in the library, videos too: the default. */
  | { kind: 'all' }
  | { kind: 'collection'; tag: string }
  | { kind: 'favorites' }

/**
 * Beats per clip. 'auto': stills hold one bar, animated clips and short videos play through
 * once, stretched a little so the change lands on the beat (1, 2, 4, 8 or 16 beats), and
 * longer videos play at normal speed for `longBeats`.
 */
export type AutoStep = 'auto' | 1 | 2 | 4 | 8 | 16
export const AUTO_STEPS: readonly AutoStep[] = ['auto', 1, 2, 4, 8, 16]
export const AUTO_STEP_LABELS: Record<string, string> = {
  auto: 'Auto (each GIF or short video plays once)',
  1: 'Every beat',
  2: 'Every 2 beats',
  4: 'Every bar',
  8: 'Every 2 bars',
  16: 'Every 4 bars',
}

export type AutoOrder = 'inOrder' | 'shuffle'

/** Where a clip too long for its step (a video, mostly) starts each time it comes up. */
export type VideoStart = 'start' | 'continue' | 'random'
export const VIDEO_STARTS: readonly VideoStart[] = ['random', 'continue', 'start']
export const VIDEO_START_LABELS: Record<VideoStart, string> = {
  random: 'A random spot',
  continue: 'Where it left off',
  start: 'The beginning',
}

/** With the 'auto' step, how many beats a clip too long to play through stays up. */
export type LongBeats = 4 | 8 | 16 | 32
export const LONG_BEATS: readonly LongBeats[] = [4, 8, 16, 32]
export const LONG_BEATS_LABELS: Record<LongBeats, string> = {
  4: '1 bar',
  8: '2 bars',
  16: '4 bars',
  32: '8 bars',
}

/** Which clips the beat effect goes on. */
export type PhotoFxOn = 'stills' | 'stillsAndVideos' | 'all'
export const PHOTO_FX_ON: readonly PhotoFxOn[] = ['stills', 'stillsAndVideos', 'all']
export const PHOTO_FX_ON_LABELS: Record<PhotoFxOn, string> = {
  stills: 'Still photos',
  stillsAndVideos: 'Photos and videos',
  all: 'Everything (GIFs too)',
}

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
  mix: 'Mix (a different one each clip)',
}

export interface AutoPlaySettings {
  enabled: boolean
  source: AutoSource
  step: AutoStep
  order: AutoOrder
  layer: LayerId
  fit: FitMode
  /** Beat effect while auto-play shows a clip (missing in older settings: none). */
  photoFx?: PhotoFx
  /** Which clips get the beat effect (missing in older settings: stills). */
  photoFxOn?: PhotoFxOn
  /** Where long clips start (missing in older settings: the beginning). */
  videoStart?: VideoStart
  /** Beats a clip too long to play through stays up with the auto step (older: 16). */
  longBeats?: LongBeats
}

export const DEFAULT_AUTO_PLAY: AutoPlaySettings = {
  enabled: false,
  source: { kind: 'all' },
  step: 'auto',
  order: 'inOrder',
  layer: 'background',
  fit: 'cover',
  photoFx: 'none',
  photoFxOn: 'stills',
  videoStart: 'random',
  longBeats: 8,
}

/** Pad id the auto-play voice uses in the scheduler (and in "what's on each layer"). */
export const AUTO_PAD_ID = 'auto'

/** Clip lengths auto steps snap to, in beats. */
export const AUTO_SNAP_BEATS = [1, 2, 4, 8, 16] as const
/** Loop lengths a clip shorter than a beat snaps to (it loops within the beat). */
const SUB_BEAT_SNAPS = [0.25, 0.5] as const
/** A still image holds this long with the 'auto' step. */
export const AUTO_STILL_BEATS = 4
/** Stretching further than this (either way) is too visible: play at normal speed instead. */
export const MAX_AUTO_STRETCH = Math.SQRT2

export interface AutoStepPlan {
  /** Beats the clip stays up. */
  beats: number
  /** Stretch the clip to exactly this many beats per loop (tempo sync); null: normal speed. */
  syncBeats: number | null
}

/**
 * How a clip plays with the 'auto' step:
 * - a still holds one bar;
 * - an animated clip or video about 1-16 beats long plays through once, stretched (by at most
 *   √2 either way) to the nearest of 1/2/4/8/16 beats on a log scale, so 3 beats rounds to 4;
 * - one shorter than a beat loops within the beat, stretched so 1, 2 or 4 loops fit;
 * - one too long to stretch (a long video) plays at normal speed for `longBeats`.
 */
export function autoStepPlan(
  durationMs: number | null,
  bpm: number,
  longBeats: number = 16,
): AutoStepPlan {
  if (durationMs === null || !(durationMs > 0) || !(bpm > 0))
    return { beats: AUTO_STILL_BEATS, syncBeats: null }
  const natural = durationMs / (60000 / bpm)
  if (natural > AUTO_SNAP_BEATS[AUTO_SNAP_BEATS.length - 1]! * MAX_AUTO_STRETCH)
    return { beats: longBeats, syncBeats: null }
  let best = 1
  for (const b of [...SUB_BEAT_SNAPS, ...AUTO_SNAP_BEATS])
    if (Math.abs(Math.log2(natural / b)) < Math.abs(Math.log2(natural / best))) best = b
  return { beats: Math.max(1, best), syncBeats: best }
}

/** Beats a clip stays up with the 'auto' step (see `autoStepPlan`). */
export function autoStepBeats(durationMs: number | null, bpm: number, longBeats = 16): number {
  return autoStepPlan(durationMs, bpm, longBeats).beats
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
  return v.kind === 'images' || v.kind === 'videos' || v.kind === 'all' || v.kind === 'favorites'
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
    (v.photoFx === undefined || PHOTO_FX.includes(v.photoFx as PhotoFx)) &&
    (v.photoFxOn === undefined || PHOTO_FX_ON.includes(v.photoFxOn as PhotoFxOn)) &&
    (v.videoStart === undefined || VIDEO_STARTS.includes(v.videoStart as VideoStart)) &&
    (v.longBeats === undefined || LONG_BEATS.includes(v.longBeats as LongBeats))
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
