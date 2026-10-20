/** Audio input and analysis types shared by the output (engine), control (UI) and tests. */

/** Where the analyzed audio comes from. */
export type AudioSource =
  | { kind: 'device'; deviceId: string }
  /** Everything the computer is playing (Windows system-audio loopback). */
  | { kind: 'loopback' }
  /** Built-in synthesized beat for testing without a mixer. Silent; only feeds the analyzer. */
  | { kind: 'test'; bpm: number }

export const BAND_NAMES = ['Bass', 'Low-mid', 'Mid', 'High'] as const
export const BAND_COUNT = BAND_NAMES.length

/** Which onset detector fired: `low` ≈ kicks, `high` ≈ snares, claps and hats. */
export type OnsetBand = 'low' | 'high'

export interface AnalysisSettings {
  /** Input gain applied before all analysis, in dB. */
  inputGainDb: number
  /** Band edges in Hz: bass | low-mid | mid | high. Must be increasing. */
  crossoversHz: [number, number, number]
  /** Extra gain per band, in dB. */
  bandGainsDb: [number, number, number, number]
  /** Band envelope follower times. */
  attackMs: number
  releaseMs: number
  /** Onset detector sensitivity, 0 (only big hits) .. 1 (everything). */
  kickSensitivity: number
  highSensitivity: number
}

export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = {
  inputGainDb: 0,
  crossoversHz: [150, 800, 4000],
  bandGainsDb: [0, 0, 0, 0],
  attackMs: 5,
  releaseMs: 150,
  kickSensitivity: 0.5,
  highSensitivity: 0.5,
}

export const INPUT_GAIN_RANGE_DB = [-24, 24] as const

export type AudioEngineState = 'off' | 'starting' | 'running' | 'error'

export interface AudioStatus {
  state: AudioEngineState
  source: AudioSource | null
  /** Human-readable source name (device label, "System audio", ...). */
  label?: string
  error?: string
  sampleRate?: number
}

export interface AudioDevice {
  deviceId: string
  label: string
}

/** Meter snapshot sent to the control UI ~30 times a second. */
export interface AudioMeters {
  /** Envelope-followed band levels, 0..1. */
  bands: number[]
  /** Input level after gain over the last interval, linear 0..1. */
  rms: number
  peak: number
  /** True if any sample hit full scale since the last snapshot. */
  clipped: boolean
  /** Log-spaced spectrum, 0..1 per bin. */
  spectrum: number[]
  /** Typical delay from audio entering the analyzer to the output main thread knowing, ms. */
  latencyMs: number
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNumTuple = (v: unknown, n: number): boolean =>
  Array.isArray(v) && v.length === n && v.every(isNum)

export function isAudioSource(v: unknown): v is AudioSource {
  if (!isObj(v)) return false
  switch (v.kind) {
    case 'device':
      return typeof v.deviceId === 'string'
    case 'loopback':
      return true
    case 'test':
      return isNum(v.bpm) && v.bpm >= 40 && v.bpm <= 300
    default:
      return false
  }
}

export function isAnalysisSettings(v: unknown): v is AnalysisSettings {
  if (!isObj(v)) return false
  const c = v.crossoversHz as number[]
  return (
    isNum(v.inputGainDb) &&
    v.inputGainDb >= INPUT_GAIN_RANGE_DB[0] &&
    v.inputGainDb <= INPUT_GAIN_RANGE_DB[1] &&
    isNumTuple(c, 3) &&
    c[0]! > 20 &&
    c[0]! < c[1]! &&
    c[1]! < c[2]! &&
    c[2]! < 20000 &&
    isNumTuple(v.bandGainsDb, 4) &&
    (v.bandGainsDb as number[]).every((g) => Math.abs(g) <= 24) &&
    isNum(v.attackMs) &&
    v.attackMs >= 0 &&
    v.attackMs <= 1000 &&
    isNum(v.releaseMs) &&
    v.releaseMs >= 0 &&
    v.releaseMs <= 5000 &&
    isNum(v.kickSensitivity) &&
    v.kickSensitivity >= 0 &&
    v.kickSensitivity <= 1 &&
    isNum(v.highSensitivity) &&
    v.highSensitivity >= 0 &&
    v.highSensitivity <= 1
  )
}

export function isAudioMeters(v: unknown): v is AudioMeters {
  return (
    isObj(v) &&
    Array.isArray(v.bands) &&
    v.bands.length === BAND_COUNT &&
    v.bands.every(isNum) &&
    isNum(v.rms) &&
    isNum(v.peak) &&
    typeof v.clipped === 'boolean' &&
    Array.isArray(v.spectrum) &&
    v.spectrum.length <= 256 &&
    v.spectrum.every(isNum) &&
    isNum(v.latencyMs)
  )
}

export function isAudioStatus(v: unknown): v is AudioStatus {
  return (
    isObj(v) &&
    ['off', 'starting', 'running', 'error'].includes(v.state as string) &&
    (v.source === null || isAudioSource(v.source)) &&
    (v.label === undefined || typeof v.label === 'string') &&
    (v.error === undefined || typeof v.error === 'string') &&
    (v.sampleRate === undefined || isNum(v.sampleRate))
  )
}

export function isAudioDeviceList(v: unknown): v is AudioDevice[] {
  return (
    Array.isArray(v) &&
    v.length <= 256 &&
    v.every((d) => isObj(d) && typeof d.deviceId === 'string' && typeof d.label === 'string')
  )
}
