/** Layers, compositing, placement and keying types shared by control, output and tests. */

import type { FitMode, Rgb } from './protocol'

export const LAYER_IDS = ['background', 'overlayA', 'overlayB', 'takeover'] as const
export type LayerId = (typeof LAYER_IDS)[number]
export const LAYER_NAMES: Record<LayerId, string> = {
  background: 'Background',
  overlayA: 'Overlay A',
  overlayB: 'Overlay B',
  takeover: 'Takeover',
}

export const BLEND_MODES = ['normal', 'add', 'screen', 'multiply', 'difference'] as const
export type BlendMode = (typeof BLEND_MODES)[number]

/** What lower layers do while the takeover layer is showing something. */
export const TAKEOVER_MODES = ['none', 'dim', 'pause', 'hide'] as const
export type TakeoverMode = (typeof TAKEOVER_MODES)[number]

export interface LayerConfig {
  opacity: number
  blend: BlendMode
  muted: boolean
  solo: boolean
}

export interface LayersConfig {
  layers: Record<LayerId, LayerConfig>
  takeoverMode: TakeoverMode
  /** How much lower layers dim under a takeover (0..1), for 'dim'. */
  takeoverDim: number
}

export const DEFAULT_LAYERS_CONFIG: LayersConfig = {
  layers: {
    background: { opacity: 1, blend: 'normal', muted: false, solo: false },
    overlayA: { opacity: 1, blend: 'normal', muted: false, solo: false },
    overlayB: { opacity: 1, blend: 'normal', muted: false, solo: false },
    takeover: { opacity: 1, blend: 'normal', muted: false, solo: false },
  },
  takeoverMode: 'dim',
  takeoverDim: 0.7,
}

export interface MasterSettings {
  /** 0..1 dimmer on the final image. */
  brightness: number
  blackout: boolean
}

export const DEFAULT_MASTER: MasterSettings = { brightness: 1, blackout: false }

// ---- Placement --------------------------------------------------------------

export const ANCHORS = [
  'full',
  'center',
  'topLeft',
  'topRight',
  'bottomLeft',
  'bottomRight',
  'lowerThird',
  'leftHalf',
  'rightHalf',
  'random',
] as const
export type Anchor = (typeof ANCHORS)[number]
export const ANCHOR_LABELS: Record<Anchor, string> = {
  full: 'Full screen',
  center: 'Centered',
  topLeft: 'Top left',
  topRight: 'Top right',
  bottomLeft: 'Bottom left',
  bottomRight: 'Bottom right',
  lowerThird: 'Lower third (bottom center)',
  leftHalf: 'Left half',
  rightHalf: 'Right half',
  random: 'Random spot',
}

export const ENTRANCES = ['none', 'pop', 'slideLeft', 'slideRight', 'slideUp', 'slideDown'] as const
export type Entrance = (typeof ENTRANCES)[number]
export const ENTRANCE_LABELS: Record<Entrance, string> = {
  none: 'None',
  pop: 'Pop (bounce in)',
  slideLeft: 'Slide in from left',
  slideRight: 'Slide in from right',
  slideUp: 'Slide up from bottom',
  slideDown: 'Slide down from top',
}

export interface Placement {
  anchor: Anchor
  /** How a 'full' clip fills the screen. */
  fit: FitMode
  /** Clip height as a fraction of the output height (non-full anchors). */
  size: number
  /** Extra offset as a fraction of the output width / height. */
  offsetX: number
  offsetY: number
  rotationDeg: number
  entrance: Entrance
  entranceBeats: number
}

export const DEFAULT_PLACEMENT: Placement = {
  anchor: 'full',
  fit: 'contain',
  size: 0.4,
  offsetX: 0,
  offsetY: 0,
  rotationDeg: 0,
  entrance: 'none',
  entranceBeats: 0.5,
}

// ---- Keying -----------------------------------------------------------------

export type KeyMode = 'none' | 'chroma' | 'luma'

export interface KeySettings {
  mode: KeyMode
  /** Chroma key color (0..1 RGB). */
  color: Rgb
  /** Chroma distance below which pixels are fully removed (0..1). */
  similarity: number
  /** Width of the soft edge above `similarity` (0..1). */
  smoothness: number
  /** Remove color spill from the key color on remaining pixels (0..1). */
  spill: number
  /** Luma key: pixels darker than this are removed (or brighter, when inverted). */
  threshold: number
  softness: number
  invert: boolean
}

export const KEY_GREEN: Rgb = [0, 1, 0]
export const KEY_BLUE: Rgb = [0, 0, 1]

export const DEFAULT_KEY: KeySettings = {
  mode: 'none',
  color: KEY_GREEN,
  similarity: 0.3,
  smoothness: 0.1,
  spill: 0.5,
  threshold: 0.15,
  softness: 0.1,
  invert: false,
}

// ---- Guards -----------------------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const inRange = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isRgb01 = (v: unknown): v is Rgb =>
  Array.isArray(v) && v.length === 3 && v.every((c) => inRange(c, 0, 1))

export const isLayerId = (v: unknown): v is LayerId => LAYER_IDS.includes(v as LayerId)

export function isLayerConfig(v: unknown): v is LayerConfig {
  return (
    isObj(v) &&
    inRange(v.opacity, 0, 1) &&
    BLEND_MODES.includes(v.blend as BlendMode) &&
    isBool(v.muted) &&
    isBool(v.solo)
  )
}

export function isLayersConfig(v: unknown): v is LayersConfig {
  return (
    isObj(v) &&
    isObj(v.layers) &&
    LAYER_IDS.every((id) => isLayerConfig((v.layers as Obj)[id])) &&
    TAKEOVER_MODES.includes(v.takeoverMode as TakeoverMode) &&
    inRange(v.takeoverDim, 0, 1)
  )
}

export function isMasterSettings(v: unknown): v is MasterSettings {
  return isObj(v) && inRange(v.brightness, 0, 1) && isBool(v.blackout)
}

const FITS: readonly FitMode[] = ['contain', 'cover', 'stretch', 'original']

export function isPlacement(v: unknown): v is Placement {
  return (
    isObj(v) &&
    ANCHORS.includes(v.anchor as Anchor) &&
    FITS.includes(v.fit as FitMode) &&
    inRange(v.size, 0.02, 2) &&
    inRange(v.offsetX, -1, 1) &&
    inRange(v.offsetY, -1, 1) &&
    inRange(v.rotationDeg, -360, 360) &&
    ENTRANCES.includes(v.entrance as Entrance) &&
    inRange(v.entranceBeats, 0, 16)
  )
}

export function isKeySettings(v: unknown): v is KeySettings {
  return (
    isObj(v) &&
    (v.mode === 'none' || v.mode === 'chroma' || v.mode === 'luma') &&
    isRgb01(v.color) &&
    inRange(v.similarity, 0, 1) &&
    inRange(v.smoothness, 0, 1) &&
    inRange(v.spill, 0, 1) &&
    inRange(v.threshold, 0, 1) &&
    inRange(v.softness, 0, 1) &&
    isBool(v.invert)
  )
}
