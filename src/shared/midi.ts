/** MIDI controller mapping: messages, targets, bindings, templates and LED feedback (Phase 7). */

import { BANK_NAMES, PAD_COLS, PAD_ROWS, QUANTIZES, type PadRunState, type Quantize } from './pads'
import { LAYER_IDS, LAYER_NAMES, type LayerId } from './layers'
import { FX_SCOPES, type FxScope } from './fx'

// ---- Messages -------------------------------------------------------------------

export type MidiMessage =
  | { kind: 'note'; channel: number; number: number; velocity: number; on: boolean }
  | { kind: 'cc'; channel: number; number: number; value: number }

/** Note on/off and CC; everything else (clock, SysEx, aftertouch...) is null. */
export function parseMidi(bytes: ArrayLike<number>): MidiMessage | null {
  const status = bytes[0] ?? 0
  const type = status & 0xf0
  const channel = status & 0x0f
  const d1 = (bytes[1] ?? 0) & 0x7f
  const d2 = (bytes[2] ?? 0) & 0x7f
  if (type === 0x90) return { kind: 'note', channel, number: d1, velocity: d2, on: d2 > 0 }
  if (type === 0x80) return { kind: 'note', channel, number: d1, velocity: 0, on: false }
  if (type === 0xb0) return { kind: 'cc', channel, number: d1, value: d2 }
  return null
}

export function describeMessage(m: MidiMessage): string {
  return m.kind === 'note'
    ? `Note ${m.number} ${m.on ? `on (${m.velocity})` : 'off'} · ch ${m.channel + 1}`
    : `CC ${m.number} = ${m.value} · ch ${m.channel + 1}`
}

// ---- Targets ----------------------------------------------------------------------

export type MidiTarget =
  /** A pad slot on the current bank (0..31). */
  | { kind: 'pad'; index: number }
  | { kind: 'bank'; bank: number }
  | { kind: 'bankNext' }
  | { kind: 'bankPrev' }
  | { kind: 'quantize'; value: Quantize }
  | { kind: 'quantizeCycle' }
  | { kind: 'tap' }
  | { kind: 'resync' }
  | { kind: 'nudge'; dir: -1 | 1 }
  /** Held: pad presses arm for the drop instead of firing (like Shift). */
  | { kind: 'armModifier' }
  /** Fire the armed drop on the next beat. */
  | { kind: 'dropNow' }
  | { kind: 'stopAll' }
  | { kind: 'blackout' }
  | { kind: 'layerOpacity'; layer: LayerId }
  | { kind: 'masterBrightness' }
  | { kind: 'effectParam'; scope: FxScope; effectId: string; param: string }

/** Targets that take a continuous value (faders, knobs) rather than a press. */
export const isContinuous = (t: MidiTarget) =>
  t.kind === 'layerOpacity' || t.kind === 'masterBrightness' || t.kind === 'effectParam'

/** Stable string form, for comparing targets and for data-learn attributes. */
export const targetKey = (t: MidiTarget) => JSON.stringify(t)

export function targetLabel(
  t: MidiTarget,
  effectName?: (id: string) => string | undefined,
): string {
  switch (t.kind) {
    case 'pad':
      return `Pad ${t.index + 1}`
    case 'bank':
      return `Bank ${BANK_NAMES[t.bank] ?? t.bank + 1}`
    case 'bankNext':
      return 'Next bank'
    case 'bankPrev':
      return 'Previous bank'
    case 'quantize':
      return `Quantize: ${t.value}`
    case 'quantizeCycle':
      return 'Quantize (cycle)'
    case 'tap':
      return 'Tap tempo'
    case 'resync':
      return 'Beat 1'
    case 'nudge':
      return t.dir < 0 ? 'Nudge earlier' : 'Nudge later'
    case 'armModifier':
      return 'Arm (hold, like Shift)'
    case 'dropNow':
      return 'Fire drop now'
    case 'stopAll':
      return 'Stop all'
    case 'blackout':
      return 'Blackout'
    case 'layerOpacity':
      return `${LAYER_NAMES[t.layer]} opacity`
    case 'masterBrightness':
      return 'Master brightness'
    case 'effectParam': {
      const scope = t.scope === 'master' ? 'Master' : LAYER_NAMES[t.scope]
      return `${scope}: ${effectName?.(t.effectId) ?? 'effect'} ${t.param}`
    }
  }
}

// ---- Bindings ---------------------------------------------------------------------

/**
 * How a CC drives a continuous target. Absolute: 0..127 is the range. Relative (endless
 * encoders): `relative` is two's complement (1..63 up, 127..65 down), `relativeOffset` is
 * centered on 64 (65 = +1, 63 = -1).
 */
export const CC_MODES = ['absolute', 'relative', 'relativeOffset'] as const
export type CcMode = (typeof CC_MODES)[number]
export const CC_MODE_LABELS: Record<CcMode, string> = {
  absolute: 'Absolute (fader/knob)',
  relative: 'Relative (endless, 1 / 127)',
  relativeOffset: 'Relative (endless, 64 ± n)',
}

export interface MidiBinding {
  id: string
  /** Input device name; null matches any device. */
  device: string | null
  type: 'note' | 'cc'
  channel: number
  number: number
  target: MidiTarget
  ccMode: CcMode
  /** Note velocity sets the clip's opacity (pads only). */
  velocity: boolean
}

export const sameSource = (
  b: Pick<MidiBinding, 'device' | 'type' | 'channel' | 'number'>,
  device: string | null,
  m: MidiMessage,
) =>
  (b.device === null || b.device === device) &&
  b.type === m.kind &&
  b.channel === m.channel &&
  b.number === m.number

/** The bindings a message from `device` triggers. */
export function matchBindings(bindings: MidiBinding[], device: string | null, m: MidiMessage) {
  return bindings.filter((b) => sameSource(b, device, m))
}

/** Steps a relative CC value moves (positive = up). */
export function ccDelta(mode: CcMode, value: number): number {
  if (mode === 'relativeOffset') return value - 64
  return value < 64 ? value : value - 128
}

/**
 * New 0..1 value for a continuous target. Absolute CCs map 0..127 directly; relative ones step
 * by 1/127 per click, so a full turn of a typical encoder covers the range.
 */
export function continuousValue(mode: CcMode, value: number, current: number): number {
  if (mode === 'absolute') return value / 127
  return Math.min(1, Math.max(0, current + ccDelta(mode, value) / 127))
}

/** Note on, or a CC above the middle, counts as pressing a button. */
export const isPress = (m: MidiMessage) => (m.kind === 'note' ? m.on : m.value >= 64)

// ---- Templates --------------------------------------------------------------------

export const TEMPLATES = ['apcMini'] as const
export type TemplateId = (typeof TEMPLATES)[number]
export const TEMPLATE_LABELS: Record<TemplateId, string> = {
  apcMini: 'Akai APC mini (mk1)',
}

/**
 * Akai APC mini (mk1). The 8x8 grid sends notes 0..63 (bottom row 0..7); the top four rows
 * play the 32 pads, matching the screen. Faders 1-4 (CC 48-51) are the layer opacities and
 * the master fader (CC 56) is brightness. Scene buttons (notes 82-89): banks A-D, tap, beat 1,
 * stop all, blackout. Track buttons (notes 64-67): quantize off / beat / bar / phrase.
 * Shift (note 98) arms instead of firing, and track button 8 (note 71) fires the drop now.
 */
export function templateBindings(id: TemplateId, device: string | null): MidiBinding[] {
  const out: MidiBinding[] = []
  const add = (type: 'note' | 'cc', number: number, target: MidiTarget, velocity = false) =>
    out.push({
      id: `t-${id}-${type}-${number}`,
      device,
      type,
      channel: 0,
      number,
      target,
      ccMode: 'absolute',
      velocity,
    })
  switch (id) {
    case 'apcMini': {
      for (let i = 0; i < PAD_ROWS * PAD_COLS; i++)
        add('note', apcMiniPadNote(i), { kind: 'pad', index: i }, true)
      LAYER_IDS.forEach((layer, i) => add('cc', 48 + i, { kind: 'layerOpacity', layer }))
      add('cc', 56, { kind: 'masterBrightness' })
      BANK_NAMES.forEach((_, bank) => add('note', 82 + bank, { kind: 'bank', bank }))
      add('note', 86, { kind: 'tap' })
      add('note', 87, { kind: 'resync' })
      add('note', 88, { kind: 'stopAll' })
      add('note', 89, { kind: 'blackout' })
      const q: Quantize[] = ['off', 'beat', 'bar', 'phrase']
      q.forEach((value, i) => add('note', 64 + i, { kind: 'quantize', value }))
      add('note', 71, { kind: 'dropNow' })
      add('note', 98, { kind: 'armModifier' })
      break
    }
  }
  return out
}

/** APC mini grid note for a pad: our row 0 is the grid's top row (notes 56..63). */
export const apcMiniPadNote = (index: number) =>
  (7 - Math.floor(index / PAD_COLS)) * 8 + (index % PAD_COLS)

// ---- LED feedback -----------------------------------------------------------------

/**
 * Note velocities for pad LEDs. These are the APC mini (mk1) colors; many grid controllers
 * use the same low velocities for basic colors, so they double as the generic palette.
 */
export const LED = {
  off: 0,
  green: 1,
  greenBlink: 2,
  red: 3,
  redBlink: 4,
  yellow: 5,
  yellowBlink: 6,
} as const

/** LED velocity for a pad: empty off, ready yellow, queued green blinking, playing green, armed red blinking. */
export function padLed(empty: boolean, state: PadRunState): number {
  if (empty) return LED.off
  switch (state) {
    case 'idle':
      return LED.yellow
    case 'queued':
      return LED.greenBlink
    case 'playing':
      return LED.green
    case 'armed':
      return LED.redBlink
    case 'stopping':
      return LED.yellowBlink
  }
}

// ---- Persistence + guards -----------------------------------------------------------

export interface MidiSettings {
  version: 1
  bindings: MidiBinding[]
  /** Output port for LED feedback (by name), or null for none. */
  feedbackOutput: string | null
}

export const DEFAULT_MIDI_SETTINGS: MidiSettings = {
  version: 1,
  bindings: [],
  feedbackOutput: null,
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi

export function isMidiTarget(v: unknown): v is MidiTarget {
  if (!isObj(v)) return false
  switch (v.kind) {
    case 'pad':
      return isInt(v.index, 0, PAD_ROWS * PAD_COLS - 1)
    case 'bank':
      return isInt(v.bank, 0, BANK_NAMES.length - 1)
    case 'quantize':
      return QUANTIZES.includes(v.value as Quantize)
    case 'nudge':
      return v.dir === -1 || v.dir === 1
    case 'layerOpacity':
      return LAYER_IDS.includes(v.layer as LayerId)
    case 'effectParam':
      return (
        FX_SCOPES.includes(v.scope as FxScope) &&
        typeof v.effectId === 'string' &&
        v.effectId.length <= 40 &&
        typeof v.param === 'string' &&
        v.param.length <= 40
      )
    case 'bankNext':
    case 'bankPrev':
    case 'quantizeCycle':
    case 'tap':
    case 'resync':
    case 'armModifier':
    case 'dropNow':
    case 'stopAll':
    case 'blackout':
    case 'masterBrightness':
      return true
    default:
      return false
  }
}

export function isMidiBinding(v: unknown): v is MidiBinding {
  return (
    isObj(v) &&
    typeof v.id === 'string' &&
    v.id.length <= 80 &&
    (v.device === null || (typeof v.device === 'string' && v.device.length <= 200)) &&
    (v.type === 'note' || v.type === 'cc') &&
    isInt(v.channel, 0, 15) &&
    isInt(v.number, 0, 127) &&
    isMidiTarget(v.target) &&
    CC_MODES.includes(v.ccMode as CcMode) &&
    typeof v.velocity === 'boolean'
  )
}

export function isMidiSettings(v: unknown): v is MidiSettings {
  return (
    isObj(v) &&
    v.version === 1 &&
    Array.isArray(v.bindings) &&
    v.bindings.length <= 512 &&
    v.bindings.every(isMidiBinding) &&
    (v.feedbackOutput === null || typeof v.feedbackOutput === 'string')
  )
}
