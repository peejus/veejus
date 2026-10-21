/** Beat clock types shared by the output (engine), control (UI) and tests. */

export const BEATS_PER_BAR = 4
export const PHRASE_BAR_OPTIONS = [4, 8, 16, 32] as const
export type PhraseBars = (typeof PHRASE_BAR_OPTIONS)[number]

/** Tempo limits for manual entry and tapping. */
export const MANUAL_BPM_RANGE = [40, 300] as const
export const LATENCY_OFFSET_RANGE_MS = [-250, 250] as const
/** How far one nudge moves the beat grid. */
export const NUDGE_MS = 10

/**
 * Where tempo and phase come from. `internal` is Veejus itself: audio detection (`auto`) or
 * tap / typed / frozen tempo (`locked`). The others follow external gear.
 */
export const CLOCK_SOURCES = ['internal', 'midi', 'link'] as const
export type ClockSource = (typeof CLOCK_SOURCES)[number]

export interface BeatSettings {
  clockSource: ClockSource
  /** `auto` follows the detected tempo; `locked` holds a fixed tempo (tapped, typed or frozen). */
  tempoMode: 'auto' | 'locked'
  /** Tempo used while locked. */
  lockedBpm: number
  /** Let detected beats pull the grid into phase (in both modes). */
  phaseCorrection: boolean
  /** Visuals run this much ahead of the analyzed audio, to cancel input and display latency. */
  latencyOffsetMs: number
  phraseBars: PhraseBars
  /** Range the tempo detector searches; results are folded into it by octaves. */
  minBpm: number
  maxBpm: number
}

export const DEFAULT_BEAT_SETTINGS: BeatSettings = {
  clockSource: 'internal',
  tempoMode: 'auto',
  lockedBpm: 120,
  phaseCorrection: true,
  latencyOffsetMs: 0,
  phraseBars: 8,
  minBpm: 70,
  maxBpm: 180,
}

export type BeatCommand =
  | { type: 'tap' }
  | { type: 'setBpm'; bpm: number }
  /** Back to automatic tempo detection. */
  | { type: 'auto' }
  /** Freeze the current tempo. */
  | { type: 'lock' }
  | { type: 'multiply'; factor: 2 | 0.5 }
  /** Shift the beat grid; positive = later. */
  | { type: 'nudge'; ms: number }
  /** "Now" is beat 1 of a bar. */
  | { type: 'resyncDownbeat' }
  | { type: 'setPhaseCorrection'; enabled: boolean }
  | { type: 'setLatencyOffset'; ms: number }
  | { type: 'setPhraseBars'; bars: PhraseBars }
  | { type: 'setTempoRange'; minBpm: number; maxBpm: number }
  | { type: 'setClockSource'; source: ClockSource }

export interface BeatState {
  bpm: number
  /** Raw detector estimate (null until there is one). */
  detectedBpm: number | null
  /** 0..1, how sure the detector is about the tempo. */
  confidence: number
  /** True when beats are being found where the grid expects them. */
  inPhase: boolean
  settings: BeatSettings
  /** Position of the visual timeline, in beats. */
  beatIndex: number
  beatPhase: number
  /** 1-based for display. */
  beatInBar: number
  barIndex: number
  barInPhrase: number
  phraseIndex: number
  /** Taps registered in the current tap sequence. */
  taps: number
  /** Status of the external clock source (MIDI clock / Link), null for the internal clock. */
  external: ExternalStatus | null
}

export interface ExternalStatus {
  /** True while the source is delivering tempo (and phase, where it has one). */
  ok: boolean
  /** Short human-readable status, e.g. "Link: 2 peers" or "MIDI clock: waiting for ticks". */
  text: string
}

/** Emitted on every beat of the (latency-shifted) visual timeline. */
export interface BeatEvent {
  beatIndex: number
  beatInBar: number
  barIndex: number
  barInPhrase: number
  phraseIndex: number
  /** performance.now() time of the beat on the visual timeline. */
  atMs: number
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const inRange = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi

export function isPhraseBars(v: unknown): v is PhraseBars {
  return PHRASE_BAR_OPTIONS.includes(v as PhraseBars)
}

export function isValidTempoRange(minBpm: unknown, maxBpm: unknown): boolean {
  // The range must span at least an octave so every tempo has a representative in it.
  return (
    inRange(minBpm, 40, 200) &&
    inRange(maxBpm, 60, 300) &&
    (maxBpm as number) >= 2 * (minBpm as number) - 1e-9
  )
}

export function isBeatCommand(v: unknown): v is BeatCommand {
  if (!isObj(v)) return false
  switch (v.type) {
    case 'tap':
    case 'auto':
    case 'lock':
    case 'resyncDownbeat':
      return true
    case 'setBpm':
      return inRange(v.bpm, ...MANUAL_BPM_RANGE)
    case 'multiply':
      return v.factor === 2 || v.factor === 0.5
    case 'nudge':
      return inRange(v.ms, -1000, 1000)
    case 'setPhaseCorrection':
      return typeof v.enabled === 'boolean'
    case 'setLatencyOffset':
      return inRange(v.ms, ...LATENCY_OFFSET_RANGE_MS)
    case 'setPhraseBars':
      return isPhraseBars(v.bars)
    case 'setTempoRange':
      return isValidTempoRange(v.minBpm, v.maxBpm)
    case 'setClockSource':
      return CLOCK_SOURCES.includes(v.source as ClockSource)
    default:
      return false
  }
}

export function isBeatSettings(v: unknown): v is BeatSettings {
  return (
    isObj(v) &&
    CLOCK_SOURCES.includes(v.clockSource as ClockSource) &&
    (v.tempoMode === 'auto' || v.tempoMode === 'locked') &&
    inRange(v.lockedBpm, ...MANUAL_BPM_RANGE) &&
    typeof v.phaseCorrection === 'boolean' &&
    inRange(v.latencyOffsetMs, ...LATENCY_OFFSET_RANGE_MS) &&
    isPhraseBars(v.phraseBars) &&
    isValidTempoRange(v.minBpm, v.maxBpm)
  )
}

export function isBeatState(v: unknown): v is BeatState {
  return (
    isObj(v) &&
    isNum(v.bpm) &&
    (v.detectedBpm === null || isNum(v.detectedBpm)) &&
    inRange(v.confidence, 0, 1) &&
    typeof v.inPhase === 'boolean' &&
    isBeatSettings(v.settings) &&
    isNum(v.beatIndex) &&
    inRange(v.beatPhase, 0, 1) &&
    isNum(v.beatInBar) &&
    isNum(v.barIndex) &&
    isNum(v.barInPhrase) &&
    isNum(v.phraseIndex) &&
    isNum(v.taps) &&
    (v.external === null || isExternalStatus(v.external))
  )
}

export function isBeatEvent(v: unknown): v is BeatEvent {
  return (
    isObj(v) &&
    isNum(v.beatIndex) &&
    isNum(v.beatInBar) &&
    isNum(v.barIndex) &&
    isNum(v.barInPhrase) &&
    isNum(v.phraseIndex) &&
    isNum(v.atMs)
  )
}

function isExternalStatus(v: unknown): v is ExternalStatus {
  return isObj(v) && typeof v.ok === 'boolean' && typeof v.text === 'string' && v.text.length <= 200
}
