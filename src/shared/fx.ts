/** Effects, modulators and presets shared by control, output and tests (Phase 6). */

import { LAYER_IDS, type LayerId } from './layers'

// ---- Effects ------------------------------------------------------------------

export const EFFECT_TYPES = [
  'strobe',
  'rgbSplit',
  'kaleidoscope',
  'mirror',
  'pixelate',
  'zoomBump',
  'shake',
  'invert',
  'hueRotate',
  'feedback',
  'pulse',
  'fold',
  'bounce',
  'pixelSpin',
  'wave',
  'slice',
  'twirl',
  'mystify',
] as const
export type EffectType = (typeof EFFECT_TYPES)[number]

export interface ParamSpec {
  name: string
  label: string
  min: number
  max: number
  step: number
  default: number
}

const p = (name: string, label: string, min: number, max: number, step: number, def: number) => ({
  name,
  label,
  min,
  max,
  step,
  default: def,
})

/** Every effect, its parameters and their ranges. The first parameter is the main "amount". */
export const EFFECT_DEFS: Record<EffectType, { label: string; params: ParamSpec[] }> = {
  strobe: {
    label: 'Strobe / flash',
    params: [
      p('amount', 'Amount', 0, 1, 0.01, 1),
      // Flashes per beat; 0 = a steady flash at `amount` (drive it with an envelope).
      p('rate', 'Flashes per beat', 0, 8, 0.25, 2),
      p('duty', 'On fraction', 0.05, 0.95, 0.05, 0.5),
      // 0 = flash to white, 1 = flash to black.
      p('black', 'To black', 0, 1, 1, 0),
    ],
  },
  rgbSplit: {
    label: 'RGB split',
    params: [p('amount', 'Offset', 0, 0.05, 0.001, 0.01), p('angle', 'Angle', 0, 360, 1, 0)],
  },
  kaleidoscope: {
    label: 'Kaleidoscope',
    params: [
      p('amount', 'Mix', 0, 1, 0.01, 1),
      p('segments', 'Segments', 2, 16, 1, 6),
      p('angle', 'Rotation', 0, 360, 1, 0),
    ],
  },
  mirror: {
    label: 'Mirror',
    params: [
      p('amount', 'Mix', 0, 1, 0.01, 1),
      // 0 left→right, 1 top→bottom, 2 both (quad).
      p('mode', 'Mode (H / V / both)', 0, 2, 1, 0),
    ],
  },
  pixelate: {
    label: 'Pixelate',
    params: [p('amount', 'Block size (px)', 1, 128, 1, 16)],
  },
  zoomBump: {
    label: 'Zoom bump',
    params: [p('amount', 'Zoom', 0, 1, 0.01, 0.1)],
  },
  shake: {
    label: 'Shake',
    params: [
      p('amount', 'Distance', 0, 0.1, 0.001, 0.02),
      p('speed', 'Jumps per beat', 1, 16, 1, 4),
    ],
  },
  invert: {
    label: 'Invert',
    params: [p('amount', 'Mix', 0, 1, 0.01, 1)],
  },
  hueRotate: {
    label: 'Hue rotate',
    params: [p('amount', 'Degrees', 0, 360, 1, 90)],
  },
  feedback: {
    label: 'Feedback / trails',
    params: [
      p('amount', 'Trail', 0, 0.98, 0.01, 0.8),
      p('zoom', 'Tunnel zoom', -0.05, 0.05, 0.001, 0.01),
    ],
  },
  // Beat-locked motion (made for still photos): each runs on its own beat count, so it moves
  // with whatever clock is running without a modulator.
  pulse: {
    label: 'Pulse',
    params: [
      p('amount', 'Size', 0, 0.5, 0.01, 0.12),
      p('beats', 'Beats per pulse', 0.25, 16, 0.25, 1),
      p('glow', 'Brightness', 0, 1, 0.01, 0.25),
      p('snap', 'Snap', 1, 8, 0.5, 3),
    ],
  },
  fold: {
    label: 'Fold',
    params: [
      p('amount', 'Fold', 0, 1, 0.01, 0.85),
      p('beats', 'Beats per fold', 0.25, 16, 0.25, 2),
      // 0 = the right side folds over the left, 1 = the bottom folds up over the top.
      p('direction', 'Direction (side / up)', 0, 1, 1, 0),
      p('panels', 'Panels', 1, 8, 1, 1),
    ],
  },
  bounce: {
    label: 'Bounce',
    params: [
      p('amount', 'Height', 0, 0.5, 0.01, 0.1),
      p('beats', 'Beats per bounce', 0.25, 16, 0.25, 1),
      p('squash', 'Squash', 0, 0.5, 0.01, 0.15),
    ],
  },
  pixelSpin: {
    label: 'Pixel spin',
    params: [
      p('amount', 'Turns', 0, 4, 0.25, 1),
      p('size', 'Tile size (px)', 4, 128, 1, 32),
      // One pass across the picture; it bounces back on the next.
      p('beats', 'Beats per sweep', 0.25, 16, 0.25, 2),
      p('width', 'Wave width', 0.05, 1, 0.01, 0.3),
    ],
  },
  wave: {
    label: 'Wave',
    params: [
      p('amount', 'Ripple', 0, 0.1, 0.001, 0.03),
      p('beats', 'Beats per wave', 0.25, 16, 0.25, 1),
      p('rings', 'Rings', 1, 20, 1, 6),
      p('snap', 'Snap', 1, 8, 0.5, 2),
    ],
  },
  slice: {
    label: 'Slice',
    params: [
      p('amount', 'Distance', 0, 0.5, 0.01, 0.12),
      p('beats', 'Beats per slice', 0.25, 16, 0.25, 1),
      p('slices', 'Strips', 2, 32, 1, 8),
      p('snap', 'Snap', 1, 8, 0.5, 4),
    ],
  },
  twirl: {
    label: 'Twirl',
    params: [
      p('amount', 'Twist (turns)', 0, 2, 0.05, 0.5),
      p('beats', 'Beats per twirl', 0.25, 16, 0.25, 2),
      p('radius', 'Radius', 0.1, 1.5, 0.05, 0.7),
      p('snap', 'Snap', 1, 8, 0.5, 2),
    ],
  },
  // Vector lines in the style of the classic "Mystify" screensaver, drawn over the picture.
  mystify: {
    label: 'Mystify lines',
    params: [
      p('amount', 'Brightness', 0, 1, 0.01, 1),
      p('trails', 'Trails', 1, 8, 1, 5),
      p('speed', 'Speed (screens per beat)', 0.02, 0.5, 0.01, 0.12),
      // 0 glides evenly; 1 jumps forward on each beat and settles.
      p('punch', 'Beat punch', 0, 1, 0.01, 0.6),
    ],
  },
}

export interface EffectInstance {
  id: string
  type: EffectType
  enabled: boolean
  /** Base values; modulators add to them. */
  params: Record<string, number>
  /** Set when a built-in preset added this effect. */
  preset?: PresetId
}

export function defaultParams(type: EffectType): Record<string, number> {
  return Object.fromEntries(EFFECT_DEFS[type].params.map((s) => [s.name, s.default]))
}

// ---- Modulators ---------------------------------------------------------------

export const LFO_SHAPES = ['sine', 'triangle', 'saw', 'square', 'random'] as const
export type LfoShape = (typeof LFO_SHAPES)[number]

/** LFO periods offered in the UI, in beats (1/16 note .. 8 bars). */
export const LFO_PERIODS: { beats: number; label: string }[] = [
  { beats: 0.25, label: '1/16' },
  { beats: 0.5, label: '1/8' },
  { beats: 1, label: '1/4 (beat)' },
  { beats: 2, label: '1/2 bar' },
  { beats: 4, label: '1 bar' },
  { beats: 8, label: '2 bars' },
  { beats: 16, label: '4 bars' },
  { beats: 32, label: '8 bars' },
]
export const LFO_PERIOD_RANGE = [1 / 16, 32] as const

export const ENV_TRIGGERS = ['beat', 'backbeat', 'bar', 'phrase', 'kick', 'high'] as const
export type EnvTrigger = (typeof ENV_TRIGGERS)[number]
export const ENV_TRIGGER_LABELS: Record<EnvTrigger, string> = {
  beat: 'Every beat',
  backbeat: 'Beats 2 & 4 (snare)',
  bar: 'Every bar',
  phrase: 'Every phrase',
  kick: 'Kick (detected)',
  high: 'Snare / hat (detected)',
}

export type ModSource =
  | { kind: 'lfo'; shape: LfoShape; periodBeats: number; /** 0..1 of a period. */ phase: number }
  | { kind: 'envelope'; trigger: EnvTrigger; attackBeats: number; decayBeats: number }
  /** Band envelope 0..3 (bass, low-mid, mid, high), scaled by gain and clamped to 0..1. */
  | { kind: 'audio'; band: number; gain: number }

export interface Modulator {
  id: string
  enabled: boolean
  /** 'opacity' | 'scale' | 'rotation' | 'x' | 'y', or '<effectId>.<param>'. */
  target: string
  source: ModSource
  /** 0..1 depth. The added value is amount * lerp(min, max, source). */
  amount: number
  min: number
  max: number
  invert: boolean
  preset?: PresetId
}

/** Built-in parameters every chain has. Layer transforms are offsets on the pad's placement. */
export const CHAIN_PARAMS: Record<string, ParamSpec> = {
  opacity: p('opacity', 'Opacity', -1, 1, 0.01, 0),
  scale: p('scale', 'Scale', -1, 2, 0.01, 0),
  rotation: p('rotation', 'Rotation (°)', -360, 360, 1, 0),
  x: p('x', 'Move X', -1, 1, 0.01, 0),
  y: p('y', 'Move Y', -1, 1, 0.01, 0),
}

export interface FxChain {
  effects: EffectInstance[]
  mods: Modulator[]
}

export const FX_SCOPES = [...LAYER_IDS, 'master'] as const
export type FxScope = LayerId | 'master'

export type FxConfig = Record<FxScope, FxChain>

export const MAX_EFFECTS = 12
export const MAX_MODS = 24

export function emptyFxConfig(): FxConfig {
  return Object.fromEntries(
    FX_SCOPES.map((s): [FxScope, FxChain] => [s, { effects: [], mods: [] }]),
  ) as FxConfig
}

/** Range of a modulation target in a chain, or null if the target doesn't exist. */
export function targetSpec(chain: FxChain, target: string): ParamSpec | null {
  if (CHAIN_PARAMS[target]) return CHAIN_PARAMS[target]
  const dot = target.indexOf('.')
  if (dot < 0) return null
  const fx = chain.effects.find((e) => e.id === target.slice(0, dot))
  const name = target.slice(dot + 1)
  return fx ? (EFFECT_DEFS[fx.type].params.find((s) => s.name === name) ?? null) : null
}

// ---- Presets ------------------------------------------------------------------

export const PRESET_IDS = [
  'kickBump',
  'snareStrobe',
  'barShake',
  'dropFlash',
  'photoPulse',
  'photoFold',
  'photoBounce',
  'spinSweep',
  'photoWave',
  'photoSlice',
  'photoTwirl',
  'mystify',
] as const
export type PresetId = (typeof PRESET_IDS)[number]

export const PRESET_LABELS: Record<PresetId, { label: string; hint: string }> = {
  kickBump: { label: 'Kick Bump', hint: 'Scale +10% on every kick' },
  snareStrobe: { label: 'Snare Strobe', hint: 'White flash on beats 2 and 4' },
  barShake: { label: 'Bar Shake', hint: 'A shake that settles over each bar' },
  dropFlash: { label: 'Drop Flash', hint: 'White flash plus zoom on each phrase start' },
  photoPulse: { label: 'Photo Pulse', hint: 'The picture swells and glows on every beat' },
  photoFold: { label: 'Photo Fold', hint: 'Folds over onto itself every 2 beats' },
  photoBounce: { label: 'Photo Bounce', hint: 'Bounces up and lands on every beat' },
  spinSweep: { label: 'Pixel Spin', hint: 'A wave of spinning tiles bounces across' },
  photoWave: { label: 'Photo Wave', hint: 'A ripple rolls out from the middle on the beat' },
  photoSlice: { label: 'Photo Slice', hint: 'Strips slide apart on the beat' },
  photoTwirl: { label: 'Photo Twirl', hint: 'Twists on the beat and unwinds' },
  mystify: { label: 'Mystify', hint: 'Bouncing color lines that jump on the beat' },
}

/** The effects and modulators a preset adds, with ids derived from `prefix`. */
export function presetItems(id: PresetId, prefix: string): FxChain {
  const env = (trigger: EnvTrigger, decayBeats: number): ModSource => ({
    kind: 'envelope',
    trigger,
    attackBeats: 0,
    decayBeats,
  })
  const mod = (n: number, target: string, source: ModSource, max: number): Modulator => ({
    id: `${prefix}m${n}`,
    enabled: true,
    target,
    source,
    amount: 1,
    min: 0,
    max,
    invert: false,
    preset: id,
  })
  const fx = (n: number, type: EffectType, params: Record<string, number>): EffectInstance => ({
    id: `${prefix}e${n}`,
    type,
    enabled: true,
    params: { ...defaultParams(type), ...params },
    preset: id,
  })
  switch (id) {
    case 'kickBump':
      return { effects: [], mods: [mod(1, 'scale', env('kick', 0.5), 0.1)] }
    case 'snareStrobe': {
      const s = fx(1, 'strobe', { amount: 0, rate: 0 })
      return { effects: [s], mods: [mod(1, `${s.id}.amount`, env('backbeat', 0.25), 0.8)] }
    }
    case 'barShake': {
      const s = fx(1, 'shake', { amount: 0, speed: 8 })
      return { effects: [s], mods: [mod(1, `${s.id}.amount`, env('bar', 2), 0.04)] }
    }
    case 'dropFlash': {
      const s = fx(1, 'strobe', { amount: 0, rate: 0 })
      const z = fx(2, 'zoomBump', { amount: 0 })
      return {
        effects: [z, s],
        mods: [
          mod(1, `${s.id}.amount`, env('phrase', 1), 1),
          mod(2, `${z.id}.amount`, env('phrase', 2), 0.25),
        ],
      }
    }
    case 'photoPulse':
      return { effects: [fx(1, 'pulse', {})], mods: [] }
    case 'photoFold':
      return { effects: [fx(1, 'fold', {})], mods: [] }
    case 'photoBounce':
      return { effects: [fx(1, 'bounce', {})], mods: [] }
    case 'spinSweep':
      return { effects: [fx(1, 'pixelSpin', {})], mods: [] }
    case 'photoWave':
      return { effects: [fx(1, 'wave', {})], mods: [] }
    case 'photoSlice':
      return { effects: [fx(1, 'slice', {})], mods: [] }
    case 'photoTwirl':
      return { effects: [fx(1, 'twirl', {})], mods: [] }
    case 'mystify':
      return { effects: [fx(1, 'mystify', {})], mods: [] }
  }
}

// ---- Guards -------------------------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const inRange = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 40 && /^[\w-]+$/.test(v)
const isPresetTag = (v: unknown) => v === undefined || PRESET_IDS.includes(v as PresetId)

export function isEffectInstance(v: unknown): v is EffectInstance {
  if (!isObj(v) || !isId(v.id) || !EFFECT_TYPES.includes(v.type as EffectType)) return false
  if (!isBool(v.enabled) || !isObj(v.params) || !isPresetTag(v.preset)) return false
  const specs = EFFECT_DEFS[v.type as EffectType].params
  const params = v.params
  return (
    Object.keys(params).length === specs.length &&
    specs.every((s) => inRange(params[s.name], s.min, s.max))
  )
}

export function isModSource(v: unknown): v is ModSource {
  if (!isObj(v)) return false
  switch (v.kind) {
    case 'lfo':
      return (
        LFO_SHAPES.includes(v.shape as LfoShape) &&
        inRange(v.periodBeats, LFO_PERIOD_RANGE[0], LFO_PERIOD_RANGE[1]) &&
        inRange(v.phase, 0, 1)
      )
    case 'envelope':
      return (
        ENV_TRIGGERS.includes(v.trigger as EnvTrigger) &&
        inRange(v.attackBeats, 0, 32) &&
        inRange(v.decayBeats, 0.01, 32)
      )
    case 'audio':
      return Number.isInteger(v.band) && inRange(v.band, 0, 3) && inRange(v.gain, 0, 20)
    default:
      return false
  }
}

export function isModulator(v: unknown): v is Modulator {
  return (
    isObj(v) &&
    isId(v.id) &&
    isBool(v.enabled) &&
    typeof v.target === 'string' &&
    v.target.length <= 64 &&
    isModSource(v.source) &&
    inRange(v.amount, 0, 1) &&
    inRange(v.min, -1000, 1000) &&
    inRange(v.max, -1000, 1000) &&
    isBool(v.invert) &&
    isPresetTag(v.preset)
  )
}

export function isFxChain(v: unknown): v is FxChain {
  return (
    isObj(v) &&
    Array.isArray(v.effects) &&
    v.effects.length <= MAX_EFFECTS &&
    v.effects.every(isEffectInstance) &&
    Array.isArray(v.mods) &&
    v.mods.length <= MAX_MODS &&
    v.mods.every(isModulator)
  )
}

export function isFxConfig(v: unknown): v is FxConfig {
  return isObj(v) && FX_SCOPES.every((s) => isFxChain(v[s]))
}

/** A sensible starting min..max when a modulator is pointed at `target`. */
export function defaultModRange(chain: FxChain, target: string): [number, number] {
  switch (target) {
    case 'opacity':
      return [-1, 0]
    case 'scale':
      return [0, 0.1]
    case 'rotation':
      return [0, 15]
    case 'x':
    case 'y':
      return [0, 0.05]
  }
  const s = targetSpec(chain, target)
  if (!s) return [0, 0]
  const half = (s.max - s.min) / 2
  return [0, Math.round(half / s.step) * s.step]
}
