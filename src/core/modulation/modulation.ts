import { BEATS_PER_BAR } from '@shared/beat'
import {
  CHAIN_PARAMS,
  EFFECT_DEFS,
  type EffectType,
  type EnvTrigger,
  type FxChain,
  type LfoShape,
  type ModSource,
  type Modulator,
} from '@shared/fx'

/**
 * Modulation: beat-synced LFOs, beat envelopes and audio bands, mapped onto parameters.
 *
 * Everything musical is a function of the beat clock's *position* (in beats), never of wall
 * time. The clock position is continuous and only moves forward, so LFOs stay phase-continuous
 * through tempo changes: a faster tempo just moves along the same waveform faster.
 */

/** The musical moment a frame is rendered at. */
export interface ModContext {
  /** Beat position on the visual timeline. */
  pos: number
  /** Beats to add to a position so that bar boundaries fall on multiples of 4. */
  barOffset: number
  /** Phrase length in beats. */
  phraseBeats: number
  /** Beat positions of the latest detected onsets, or null if none yet. */
  lastKickPos: number | null
  lastHighPos: number | null
  /** Band envelopes (bass, low-mid, mid, high), roughly 0..1. */
  bands: ArrayLike<number>
}

const fract = (x: number) => x - Math.floor(x)
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** Deterministic 0..1 value per integer step (for random-step LFOs). */
export function stepRandom(step: number): number {
  let h = Math.imul(step | 0, 0x9e3779b1) ^ 0x5bd1e995
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Waveform value 0..1 at phase `phi` (0..1). Sine and triangle start at 0 and peak at 0.5. */
export function waveform(shape: LfoShape, phi: number, step = 0): number {
  switch (shape) {
    case 'sine':
      return 0.5 - 0.5 * Math.cos(2 * Math.PI * phi)
    case 'triangle':
      return 1 - Math.abs(2 * phi - 1)
    case 'saw':
      return phi
    case 'square':
      return phi < 0.5 ? 1 : 0
    case 'random':
      return stepRandom(step)
  }
}

/** LFO value 0..1. Periods are aligned to the bar grid, so a 1-bar LFO restarts on each downbeat. */
export function lfoValue(
  shape: LfoShape,
  periodBeats: number,
  phase: number,
  pos: number,
  barOffset = 0,
): number {
  const cycles = (pos + barOffset) / periodBeats + phase
  return waveform(shape, fract(cycles), Math.floor(cycles))
}

/** Attack/decay shape: linear rise over `attack`, then a quadratic fall over `decay` (beats). */
export function envelopeShape(elapsed: number, attack: number, decay: number): number {
  if (elapsed < 0) return 0
  if (attack > 0 && elapsed < attack) return elapsed / attack
  const t = (elapsed - attack) / decay
  return t >= 1 ? 0 : (1 - t) * (1 - t)
}

/** Beat position of the most recent trigger at or before ctx.pos, or null if none yet. */
export function lastTrigger(trigger: EnvTrigger, ctx: ModContext): number | null {
  const { pos, barOffset } = ctx
  const eps = 1e-9
  switch (trigger) {
    case 'beat':
      return Math.floor(pos + eps)
    case 'backbeat': {
      const b = Math.floor(pos + eps)
      const inBar = (((b + barOffset) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR
      return inBar % 2 === 1 ? b : b - 1
    }
    case 'bar':
      return Math.floor((pos + barOffset + eps) / BEATS_PER_BAR) * BEATS_PER_BAR - barOffset
    case 'phrase':
      return Math.floor((pos + barOffset + eps) / ctx.phraseBeats) * ctx.phraseBeats - barOffset
    case 'kick':
      return ctx.lastKickPos
    case 'high':
      return ctx.lastHighPos
  }
}

/** A modulation source's raw value, 0..1. */
export function sourceValue(source: ModSource, ctx: ModContext): number {
  switch (source.kind) {
    case 'lfo':
      return lfoValue(source.shape, source.periodBeats, source.phase, ctx.pos, ctx.barOffset)
    case 'envelope': {
      const at = lastTrigger(source.trigger, ctx)
      return at === null ? 0 : envelopeShape(ctx.pos - at, source.attackBeats, source.decayBeats)
    }
    case 'audio':
      return clamp01((ctx.bands[source.band] ?? 0) * source.gain)
  }
}

/** What one modulator adds to its target. */
export function modulatorOutput(m: Modulator, ctx: ModContext): number {
  let s = sourceValue(m.source, ctx)
  if (m.invert) s = 1 - s
  return m.amount * (m.min + (m.max - m.min) * s)
}

export interface ResolvedEffect {
  id: string
  type: EffectType
  params: Record<string, number>
}

export interface ResolvedChain {
  /** Offsets: opacity is added, scale is a fraction (+0.1 = 10% bigger), rotation in degrees. */
  opacity: number
  scale: number
  rotation: number
  x: number
  y: number
  /** Enabled effects in order, with modulated, range-clamped parameters. */
  effects: ResolvedEffect[]
}

const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Apply every enabled modulator in a chain at one musical moment. */
export function resolveChain(chain: FxChain, ctx: ModContext): ResolvedChain {
  const base: Record<string, number> = { opacity: 0, scale: 0, rotation: 0, x: 0, y: 0 }
  const effects = chain.effects
    .filter((e) => e.enabled)
    .map((e) => ({ id: e.id, type: e.type, params: { ...e.params } }))
  const byId = new Map(effects.map((e) => [e.id, e]))

  for (const m of chain.mods) {
    if (!m.enabled) continue
    const delta = modulatorOutput(m, ctx)
    if (m.target in base) {
      base[m.target]! += delta
      continue
    }
    const dot = m.target.indexOf('.')
    const fx = dot > 0 ? byId.get(m.target.slice(0, dot)) : undefined
    const name = m.target.slice(dot + 1)
    if (fx && name in fx.params) fx.params[name]! += delta
  }

  for (const fx of effects) {
    for (const s of EFFECT_DEFS[fx.type].params) {
      fx.params[s.name] = clampTo(fx.params[s.name]!, s.min, s.max)
    }
  }
  const c = (name: keyof typeof base) =>
    clampTo(base[name]!, CHAIN_PARAMS[name]!.min, CHAIN_PARAMS[name]!.max)
  return {
    opacity: c('opacity'),
    scale: c('scale'),
    rotation: c('rotation'),
    x: c('x'),
    y: c('y'),
    effects,
  }
}

/** Whether a resolved effect changes the image at all (skippable passes cost nothing). */
export function effectIsActive(fx: ResolvedEffect): boolean {
  const a = fx.params.amount ?? 0
  switch (fx.type) {
    case 'pixelate':
      return a >= 1.5
    case 'mirror':
    case 'kaleidoscope':
    case 'invert':
    case 'strobe':
    case 'rgbSplit':
    case 'zoomBump':
    case 'shake':
      return a > 1e-4
    case 'hueRotate':
      return a > 0.05 && a < 359.95
    case 'feedback':
      // Trails keep history even at a moment of zero amount, so feedback is always live.
      return true
  }
}
