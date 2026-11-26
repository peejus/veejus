/**
 * A Veejus set: everything needed to rebuild a show (Phase 8). Saved as versioned JSON; media
 * paths are stored both relative to the set file (so a folder of set + clips can move) and
 * absolute (a fallback when only the set file moves).
 */

import { isAnalysisSettings, isAudioSource, type AnalysisSettings, type AudioSource } from './audio'
import { isBeatSettings, type BeatSettings } from './beat'
import { isAutoPlaySettings, type AutoPlaySettings } from './autoplay'
import { isFxConfig, type FxConfig } from './fx'
import { isLayersConfig, isMasterSettings, type LayersConfig, type MasterSettings } from './layers'
import { isMidiSettings, type MidiSettings } from './midi'
import { isOutputOptions, type OutputOptions } from './output'
import {
  BANK_COUNT,
  PADS_PER_BANK,
  PLAY_MODES,
  QUANTIZES,
  isPadSource,
  isTag,
  isTriggerSettings,
  type PadConfig,
  type PlayMode,
  type Quantize,
  type TriggerSettings,
} from './pads'
import { isPlacement, isKeySettings, isLayerId } from './layers'
import { isLayerSettings, type LayerSettings } from './protocol'

export const SET_FORMAT = 'veejus-set'
export const SET_VERSION = 1
export const SET_EXTENSION = 'veejus'

export interface SetClip {
  /** The clip's id when the set was saved (pads refer to it). */
  id: string
  name: string
  /** Absolute path when saved. */
  path: string
  /** Path relative to the set file's folder, when there was a set file. */
  relPath: string | null
  tags: string[]
  favorite: boolean
}

export interface VeejusSet {
  format: typeof SET_FORMAT
  version: typeof SET_VERSION
  savedAt: string
  clips: SetClip[]
  pads: { banks: PadConfig[][]; settings: TriggerSettings; bank: number }
  layers: LayersConfig
  master: MasterSettings
  fx: FxConfig
  beat: BeatSettings
  midi: MidiSettings
  /** Background color, #rrggbb. */
  background: string
  /** Loop / speed / fit for clips played from the library. */
  libraryPlay: LayerSettings
  audio: { source: AudioSource | null; settings: AnalysisSettings }
  output: OutputOptions
  /** Auto-play settings (added after version 1 shipped, so optional). */
  autoPlay?: AutoPlaySettings
}

/** The parts that describe the show, for comparing sets ("unsaved changes?"). */
/** Switching auto-play on or off isn't an unsaved change; its settings are. */
export const setFingerprint = (s: VeejusSet) =>
  JSON.stringify({
    ...s,
    savedAt: '',
    autoPlay: s.autoPlay ? { ...s.autoPlay, enabled: false } : undefined,
  })

// ---- Moving media -------------------------------------------------------------------

/** Rewrite clip ids in pads after media was found at new paths (old id -> new id). */
export function remapPadClips(banks: PadConfig[][], idMap: Record<string, string>): PadConfig[][] {
  return banks.map((bank) =>
    bank.map((p) =>
      p.source?.kind === 'clip' && idMap[p.source.clipId]
        ? { ...p, source: { kind: 'clip', clipId: idMap[p.source.clipId]! } }
        : p,
    ),
  )
}

/** Clip ids the pads use that aren't in `available`. */
export function missingPadClips(banks: PadConfig[][], available: Set<string>): string[] {
  const out = new Set<string>()
  for (const bank of banks)
    for (const p of bank)
      if (p.source?.kind === 'clip' && !available.has(p.source.clipId)) out.add(p.source.clipId)
  return [...out]
}

// ---- Guards ---------------------------------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const inRange = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi
const isStr = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length <= max

export function isPadConfig(v: unknown): v is PadConfig {
  return (
    isObj(v) &&
    (v.source === null || isPadSource(v.source)) &&
    PLAY_MODES.includes(v.mode as PlayMode) &&
    (v.quantize === 'global' || QUANTIZES.includes(v.quantize as Quantize)) &&
    inRange(v.lengthBeats, 0.25, 256) &&
    (v.retriggerEvery === 'beat' || v.retriggerEvery === 'bar') &&
    inRange(v.fadeInBeats, 0, 16) &&
    inRange(v.fadeOutBeats, 0, 16) &&
    (v.syncBeats === null || inRange(v.syncBeats, 0.25, 256)) &&
    (v.layer === 'auto' || isLayerId(v.layer)) &&
    isPlacement(v.placement) &&
    isKeySettings(v.key)
  )
}

function isSetClip(v: unknown): v is SetClip {
  return (
    isObj(v) &&
    isStr(v.id, 64) &&
    isStr(v.name, 1024) &&
    isStr(v.path) &&
    (v.relPath === null || isStr(v.relPath)) &&
    Array.isArray(v.tags) &&
    v.tags.every(isTag) &&
    typeof v.favorite === 'boolean'
  )
}

/** Validate a parsed set file. Returns a reason when it isn't a usable set. */
export function checkSet(v: unknown): { ok: true; set: VeejusSet } | { ok: false; reason: string } {
  if (!isObj(v) || v.format !== SET_FORMAT) return { ok: false, reason: 'Not a Veejus set file' }
  if (v.version !== SET_VERSION)
    return {
      ok: false,
      reason: `This set was saved by a ${isNum(v.version) && v.version > SET_VERSION ? 'newer' : 'different'} version of Veejus (format ${String(v.version)})`,
    }
  const fail = (what: string) => ({ ok: false as const, reason: `The set's ${what} is damaged` })
  if (!isStr(v.savedAt, 64)) return fail('date')
  if (!Array.isArray(v.clips) || v.clips.length > 20000 || !v.clips.every(isSetClip))
    return fail('clip list')
  const pads = v.pads as Obj
  if (
    !isObj(pads) ||
    !Array.isArray(pads.banks) ||
    pads.banks.length !== BANK_COUNT ||
    !pads.banks.every(
      (b: unknown) => Array.isArray(b) && b.length === PADS_PER_BANK && b.every(isPadConfig),
    ) ||
    !isTriggerSettings(pads.settings) ||
    !(Number.isInteger(pads.bank) && inRange(pads.bank, 0, BANK_COUNT - 1))
  )
    return fail('pads')
  if (!isLayersConfig(v.layers) || !isMasterSettings(v.master)) return fail('layer mix')
  if (!isFxConfig(v.fx)) return fail('effects')
  if (!isBeatSettings(v.beat)) return fail('clock settings')
  if (!isMidiSettings(v.midi)) return fail('MIDI mappings')
  if (!isStr(v.background, 16) || !/^#[0-9a-f]{6}$/i.test(v.background)) return fail('background')
  if (!isLayerSettings(v.libraryPlay)) return fail('library settings')
  const audio = v.audio as Obj
  if (
    !isObj(audio) ||
    !(audio.source === null || isAudioSource(audio.source)) ||
    !isAnalysisSettings(audio.settings)
  )
    return fail('audio settings')
  if (!isOutputOptions(v.output)) return fail('output options')
  if (v.autoPlay !== undefined && !isAutoPlaySettings(v.autoPlay)) return fail('auto-play settings')
  return { ok: true, set: v as unknown as VeejusSet }
}
