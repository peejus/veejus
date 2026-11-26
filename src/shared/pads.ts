/** Pads, triggering and drop types shared by the control (UI), output (scheduler) and tests. */

import { isAutoPlayStatus, type AutoPlayStatus } from './autoplay'
import {
  DEFAULT_KEY,
  DEFAULT_PLACEMENT,
  isKeySettings,
  isLayerId,
  isPlacement,
  type KeySettings,
  type LayerId,
  type Placement,
} from './layers'

export const BANK_COUNT = 4
export const PAD_ROWS = 4
export const PAD_COLS = 8
export const PADS_PER_BANK = PAD_ROWS * PAD_COLS
export const BANK_NAMES = ['A', 'B', 'C', 'D'] as const

/** Keyboard layout: each string is one grid row, left to right (KeyboardEvent.code values). */
export const PAD_KEY_CODES: readonly (readonly string[])[] = [
  ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'],
  ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI'],
  ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'],
  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma'],
]
export const PAD_KEY_LABELS: readonly (readonly string[])[] = [
  ['1', '2', '3', '4', '5', '6', '7', '8'],
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M', ','],
]

export const padId = (bank: number, index: number) => `${BANK_NAMES[bank]}${index + 1}`

export type PlayMode = 'oneShot' | 'beats' | 'hold' | 'toggle' | 'retrigger'
export const PLAY_MODES: readonly PlayMode[] = ['oneShot', 'beats', 'hold', 'toggle', 'retrigger']
export const PLAY_MODE_LABELS: Record<PlayMode, string> = {
  oneShot: 'One-shot',
  beats: 'For N beats',
  hold: 'While held',
  toggle: 'Toggle loop',
  retrigger: 'Retrigger',
}

export type Quantize = 'off' | 'quarter' | 'beat' | 'bar' | 'phrase'
export const QUANTIZES: readonly Quantize[] = ['off', 'quarter', 'beat', 'bar', 'phrase']
export const QUANTIZE_LABELS: Record<Quantize, string> = {
  off: 'Off',
  quarter: '1/4 beat',
  beat: 'Beat',
  bar: 'Bar',
  phrase: 'Phrase',
}

export type RetriggerUnit = 'beat' | 'bar'

/** What a pad plays: one clip, or a random clip from a folder (or the whole library). */
export type PadSource =
  | { kind: 'clip'; clipId: string }
  /** A random clip from a folder (null: the whole library). */
  | { kind: 'random'; folder: string | null }
  /** A random clip from a collection (a tag, e.g. "Air Horns"). */
  | { kind: 'collection'; tag: string }
  /** A random favorite. */
  | { kind: 'favorites' }

/** A pad as configured in the UI. */
export interface PadConfig {
  source: PadSource | null
  mode: PlayMode
  /** 'global' follows the global quantize setting. */
  quantize: Quantize | 'global'
  /** Length for 'beats' mode. */
  lengthBeats: number
  retriggerEvery: RetriggerUnit
  fadeInBeats: number
  fadeOutBeats: number
  /** Stretch the clip so one pass lasts this many beats; null plays at normal speed. */
  syncBeats: number | null
  /** 'auto' picks by play mode (and Takeover for drops); see `autoLayer`. */
  layer: LayerId | 'auto'
  placement: Placement
  key: KeySettings
}

export const DEFAULT_PAD_CONFIG: Omit<PadConfig, 'source'> = {
  mode: 'oneShot',
  quantize: 'global',
  lengthBeats: 2,
  retriggerEvery: 'beat',
  fadeInBeats: 0,
  fadeOutBeats: 0,
  syncBeats: null,
  layer: 'auto',
  placement: DEFAULT_PLACEMENT,
  key: DEFAULT_KEY,
}

/**
 * Default layer for a pad: loops sit in the background, quick hits go on the overlays, and
 * anything fired by a drop takes over the screen.
 */
export function autoLayer(mode: PlayMode, forDrop: boolean): LayerId {
  if (forDrop) return 'takeover'
  switch (mode) {
    case 'toggle':
      return 'background'
    case 'beats':
      return 'overlayB'
    default:
      return 'overlayA'
  }
}

/** Everything the output needs to play a pad (global settings already resolved). */
export interface PadSpec {
  source: PadSource
  mode: PlayMode
  quantize: Quantize
  lengthBeats: number
  retriggerEvery: RetriggerUnit
  fadeInBeats: number
  fadeOutBeats: number
  syncBeats: number | null
  layer: LayerId
  placement: Placement
  key: KeySettings
}

/** When armed pads fire. */
export type DropTarget = { kind: 'phrase' } | { kind: 'bars'; bars: number }
export const DROP_BAR_OPTIONS = [1, 2, 4, 8, 16] as const

export interface TriggerSettings {
  quantize: Quantize
  drop: DropTarget
}

export const DEFAULT_TRIGGER_SETTINGS: TriggerSettings = {
  quantize: 'beat',
  drop: { kind: 'phrase' },
}

export type PadRunState = 'idle' | 'queued' | 'armed' | 'playing' | 'stopping'

export interface PadRuntime {
  state: PadRunState
  /** Clip showing (or about to), once chosen. */
  clipId: string | null
  /** Layer the pad plays (or will play) on. */
  layer: LayerId | null
}

export interface DropStatus {
  padIds: string[]
  /** Beats until the drop fires (fractional). */
  beatsRemaining: number
  /** Whole bars left, counting the current partial bar (for "DROP in 3 bars"). */
  barsRemaining: number
}

export interface TriggerState {
  /** Only pads that are not idle. */
  pads: Record<string, PadRuntime>
  drop: DropStatus | null
  settings: TriggerSettings
  /** What auto-play is doing. */
  auto: AutoPlayStatus
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const inRange = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64

/** Collection (tag) names: short, trimmed, non-empty. */
export const MAX_TAG_LENGTH = 40
export const isTag = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= MAX_TAG_LENGTH

export function isPadSource(v: unknown): v is PadSource {
  if (!isObj(v)) return false
  if (v.kind === 'clip') return isId(v.clipId)
  if (v.kind === 'random')
    return v.folder === null || (typeof v.folder === 'string' && v.folder.length < 4096)
  if (v.kind === 'collection') return isTag(v.tag)
  return v.kind === 'favorites'
}

export function isPadSpec(v: unknown): v is PadSpec {
  return (
    isObj(v) &&
    isPadSource(v.source) &&
    PLAY_MODES.includes(v.mode as PlayMode) &&
    QUANTIZES.includes(v.quantize as Quantize) &&
    inRange(v.lengthBeats, 0.25, 256) &&
    (v.retriggerEvery === 'beat' || v.retriggerEvery === 'bar') &&
    inRange(v.fadeInBeats, 0, 16) &&
    inRange(v.fadeOutBeats, 0, 16) &&
    (v.syncBeats === null || inRange(v.syncBeats, 0.25, 256)) &&
    isLayerId(v.layer) &&
    isPlacement(v.placement) &&
    isKeySettings(v.key)
  )
}

export function isDropTarget(v: unknown): v is DropTarget {
  if (!isObj(v)) return false
  if (v.kind === 'phrase') return true
  return v.kind === 'bars' && DROP_BAR_OPTIONS.includes(v.bars as (typeof DROP_BAR_OPTIONS)[number])
}

export function isTriggerSettings(v: unknown): v is TriggerSettings {
  return isObj(v) && QUANTIZES.includes(v.quantize as Quantize) && isDropTarget(v.drop)
}

const RUN_STATES: readonly PadRunState[] = ['idle', 'queued', 'armed', 'playing', 'stopping']

export function isTriggerState(v: unknown): v is TriggerState {
  if (!isObj(v) || !isObj(v.pads) || !isTriggerSettings(v.settings)) return false
  if (!isAutoPlayStatus(v.auto)) return false
  for (const p of Object.values(v.pads)) {
    if (!isObj(p) || !RUN_STATES.includes(p.state as PadRunState)) return false
    if (!(p.clipId === null || typeof p.clipId === 'string')) return false
    if (!(p.layer === null || isLayerId(p.layer))) return false
  }
  const d = v.drop
  return (
    d === null ||
    (isObj(d) &&
      Array.isArray(d.padIds) &&
      d.padIds.every(isId) &&
      isNum(d.beatsRemaining) &&
      isNum(d.barsRemaining))
  )
}

export { isId as isPadId }
