/**
 * Typed IPC protocol shared by the main process, the control window and the output window.
 *
 * Renderer <-> renderer messages travel through the main process, which forwards them
 * unchanged. Every message is validated with the guards below before it is acted on.
 */

import type { ClipKind } from './mediaTypes'
import { FX_SCOPES, isFxConfig, type FxConfig, type FxScope } from './fx'
import { isTag } from './pads'
import { isOutputOptions, type OutputOptions } from './output'
import { checkSet, type SetClip, type VeejusSet } from './set'
import {
  isAnalysisSettings,
  isAudioDeviceList,
  isAudioMeters,
  isAudioSource,
  isAudioStatus,
  type AnalysisSettings,
  type AudioDevice,
  type AudioMeters,
  type AudioSource,
  type AudioStatus,
  type OnsetBand,
} from './audio'
import {
  isBeatCommand,
  isBeatEvent,
  isBeatState,
  type BeatCommand,
  type BeatEvent,
  type BeatState,
} from './beat'
import {
  isLayerId,
  isLayersConfig,
  isMasterSettings,
  LAYER_IDS,
  type LayerId,
  type LayersConfig,
  type MasterSettings,
} from './layers'
import {
  isPadId,
  isPadSpec,
  isTriggerSettings,
  isTriggerState,
  type PadSpec,
  type TriggerSettings,
  type TriggerState,
} from './pads'

/** IPC channel names. */
export const Channel = {
  /** Control -> main -> output. Payload: ControlToOutput. */
  toOutput: 'veejus:to-output',
  /** Output -> main -> control. Payload: OutputToControl. */
  toControl: 'veejus:to-control',
  /** Control -> main (invoke). Payload: MainRequest, returns MainResponse. */
  mainRequest: 'veejus:main-request',
  /** Main -> control. Payload: OutputWindowState. */
  outputState: 'veejus:output-state',
  /** Output -> main. Payload: OutputCommand. */
  outputCommand: 'veejus:output-command',
  /** Main -> control and output. Payload: ClipInfo[] (the whole library). */
  library: 'veejus:library',
  /** Output -> main (invoke). Returns the current ClipInfo[]. */
  getLibrary: 'veejus:get-library',
  /** Main -> output. Payload: LinkSample. */
  link: 'veejus:link',
} as const

/** Linear RGB in 0..1. */
export type Rgb = readonly [number, number, number]

/** A media file registered in the library. Owned by the main process. */
export interface ClipInfo {
  /** Stable id derived from the file path. */
  id: string
  name: string
  path: string
  kind: ClipKind
  mime: string
  sizeBytes: number
  /** URL the renderers load the file from. */
  url: string
  /** Collections the clip belongs to (e.g. "Air Horns"); random pads can pick from them. */
  tags: string[]
  favorite: boolean
}

export type FitMode = 'contain' | 'cover' | 'stretch' | 'original'
export const FIT_MODES: readonly FitMode[] = ['contain', 'cover', 'stretch', 'original']

export interface LayerSettings {
  /** Loop the clip, or play it once and clear the layer. */
  loop: boolean
  /** Playback rate multiplier. */
  speed: number
  fit: FitMode
}

export const SPEED_MIN = 0.25
export const SPEED_MAX = 4

export type ControlToOutput =
  | { type: 'setBackground'; color: Rgb }
  | { type: 'ping'; id: number }
  | { type: 'setDebugOverlay'; visible: boolean }
  | { type: 'playClip'; id: string; settings: LayerSettings }
  | { type: 'stopClip' }
  | { type: 'setLayerSettings'; settings: LayerSettings }
  /** Ask the output to re-send every clip state and the current clip (e.g. after a UI reload). */
  | { type: 'requestStatus' }
  /** Switch the analyzed audio input; null turns audio off. */
  | { type: 'setAudioSource'; source: AudioSource | null }
  | { type: 'setAnalysisSettings'; settings: AnalysisSettings }
  | { type: 'requestAudioDevices' }
  | { type: 'beatCommand'; command: BeatCommand }
  /** A pad was pressed (key down / click). Fires per its quantize and mode. */
  /** `velocity` (0..1, e.g. from a MIDI pad) scales the clip's opacity; default 1. */
  | { type: 'padPress'; padId: string; spec: PadSpec; velocity?: number }
  /** Fire the armed drop on the next beat. */
  | { type: 'dropNow' }
  /** Letterbox and render resolution. */
  | { type: 'setOutputOptions'; options: OutputOptions }
  /** A pad was released (matters for 'hold' mode). */
  | { type: 'padRelease'; padId: string }
  /** Arm a pad for the drop, or disarm it if already armed. */
  | { type: 'padArm'; padId: string; spec: PadSpec }
  /** Stop every pad and cancel the drop. */
  | { type: 'stopAll' }
  | { type: 'setTriggerSettings'; settings: TriggerSettings }
  | { type: 'setLayers'; config: LayersConfig }
  | { type: 'setMaster'; master: MasterSettings }
  /** Turn the preview-monitor frame stream on or off. */
  | { type: 'setPreview'; enabled: boolean }
  /** Clear one layer (and stop the pad on it). */
  | { type: 'stopLayer'; layer: LayerId }
  /** Effects and modulators for every layer and the master. */
  | { type: 'setFx'; config: FxConfig }

export interface FrameStatsSnapshot {
  fps: number
  frameTimeAvgMs: number
  frameTimeMaxMs: number
  /** Frames longer than ~1.5x the expected frame interval within the window. */
  droppedFrames: number
}

/** Output-side readiness of a clip. `cold` = known but not loaded (never loaded or evicted). */
export type ClipLoadState = 'cold' | 'loading' | 'ready' | 'error'

export interface MediaStats {
  readyClips: number
  loadingClips: number
  /** Estimated bytes held by decoded image frames. */
  imageBytes: number
  imageBudgetBytes: number
  warmVideos: number
  warmVideoLimit: number
}

export type OutputToControl =
  | { type: 'outputReady' }
  | { type: 'pong'; id: number }
  | { type: 'frameStats'; stats: FrameStatsSnapshot }
  /** Sent the first frame after a setBackground is drawn, for latency checks. */
  | { type: 'backgroundApplied'; color: Rgb }
  | { type: 'clipState'; id: string; state: ClipLoadState; error?: string }
  /**
   * The first frame showing a clip was drawn. `waitFrames` counts render frames between
   * the play request arriving and that draw (0 or 1 for a ready clip).
   */
  | { type: 'clipStarted'; id: string; waitFrames: number }
  /** The layer was cleared: a one-shot clip finished, or it was stopped. */
  | { type: 'clipEnded'; id: string }
  | { type: 'mediaStats'; stats: MediaStats }
  | { type: 'audioStatus'; status: AudioStatus }
  | { type: 'audioDevices'; devices: AudioDevice[] }
  /** ~30 per second while audio runs. */
  | { type: 'audioMeters'; meters: AudioMeters }
  /** Sent the moment an onset is detected. */
  | { type: 'audioOnset'; band: OnsetBand; strength: number }
  /** Beat clock status, ~10 per second and after every command. */
  | { type: 'beatState'; state: BeatState }
  /** Sent on every beat of the visual timeline. */
  | { type: 'beat'; event: BeatEvent }
  /** Pad states and drop countdown: on every change and ~10 per second while armed. */
  | { type: 'triggerState'; state: TriggerState }
  /** Downscaled final frame for the preview monitor (RGBA, bottom-up rows). */
  | { type: 'previewFrame'; width: number; height: number; pixels: Uint8Array }
  /** What each layer shows, on every change. */
  | { type: 'layerState'; layers: Record<LayerId, LayerShowing> }
  /**
   * Current modulated values (about 20 per second), per scope, keyed by modulation target
   * ('opacity', 'scale', '<effectId>.<param>' ...). Only modulated targets are included.
   */
  | { type: 'fxLive'; values: FxLiveValues }
  /** Output health, sent when it changes (and with each stats update). */
  | { type: 'health'; health: OutputHealth }

export interface OutputHealth {
  /** Graceful-degradation level, 0 (normal) .. 3 (see core/watchdog). */
  level: number
  /** GPU memory held by render targets and clip textures, MB (estimate). */
  gpuMB: number
}

export type FxLiveValues = Partial<Record<FxScope, Record<string, number>>>

export interface LayerShowing {
  clipId: string | null
  /** Pad that started it, or null for a library preview. */
  padId: string | null
}

/** Largest preview frame accepted, per side. */
export const PREVIEW_MAX_SIDE = 640

/** Window commands the output page can ask main for (e.g. from its own key handling). */
export type OutputCommand =
  | { type: 'exitFullscreen' }
  | { type: 'toggleFullscreen' }
  /** Join or leave the Ableton Link session (the output's clock source switched). */
  | { type: 'link'; enabled: boolean; bpm: number }
  /** Propose a tempo to the Link session. */
  | { type: 'linkTempo'; bpm: number }

/** Ableton Link timing, main -> output, about 50 times a second while Link is on. */
export type LinkSample =
  | {
      available: true
      tempo: number
      /** Position within the 4-beat bar (0..4), shared by every peer. */
      phase: number
      /** When the phase was read, in epoch ms (performance.timeOrigin + performance.now()). */
      epochMs: number
      peers: number
    }
  | { available: false; error: string }

export interface DisplayInfo {
  id: number
  label: string
  width: number
  height: number
  scaleFactor: number
  primary: boolean
}

export interface OutputWindowState {
  displayId: number | null
  fullscreen: boolean
  visible: boolean
}

export type MainRequest =
  | { type: 'listDisplays' }
  | { type: 'getOutputState' }
  | { type: 'moveOutputToDisplay'; displayId: number }
  | { type: 'setOutputFullscreen'; fullscreen: boolean }
  | { type: 'showOutput' }
  | { type: 'getLibrary' }
  /** Import files and/or folders (folders are scanned recursively). */
  | { type: 'importPaths'; paths: string[] }
  /** Show a native picker, then import the chosen files or folder. */
  | { type: 'pickAndImport'; mode: 'files' | 'folder' }
  | { type: 'removeClips'; ids: string[] }
  /** Change a clip's collections and/or favorite flag. */
  | { type: 'setClipMeta'; id: string; tags?: string[]; favorite?: boolean }
  /** Save the set: to `path`, or ask where (no path yet, or Save As). */
  | { type: 'saveSet'; set: VeejusSet; path: string | null; saveAs: boolean }
  /** Open a set file (ask which when `path` is null). Replaces the library. */
  | { type: 'openSet'; path: string | null }
  /** Start an empty set (clears the library). */
  | { type: 'newSet' }
  /** Keep the current state for restoring after a restart or crash. */
  | { type: 'autosave'; set: VeejusSet; path: string | null; dirty: boolean }
  /** The state autosaved last time, if any (loaded into the library like openSet). */
  | { type: 'restoreSession' }
  | { type: 'listRecentSets' }
  /** Look for missing clips by file name in a folder (ask which when null). */
  | { type: 'relink'; folder: string | null; clips: { id: string; name: string }[] }

export interface ImportResult {
  added: number
  skipped: number
}

export type MainResponse =
  | { type: 'displays'; displays: DisplayInfo[] }
  | { type: 'outputState'; state: OutputWindowState }
  | { type: 'library'; clips: ClipInfo[] }
  | { type: 'imported'; result: ImportResult }
  | { type: 'setSaved'; path: string }
  | {
      type: 'setLoaded'
      set: VeejusSet
      path: string | null
      dirty: boolean
      /** Old clip id -> id of the file found now (paths moved). */
      idMap: Record<string, string>
      /** Clips that couldn't be found. */
      missing: SetClip[]
    }
  | { type: 'noSession' }
  | { type: 'recentSets'; sets: RecentSet[] }
  | { type: 'relinked'; idMap: Record<string, string>; missing: string[] }
  | { type: 'canceled' }
  | { type: 'ok' }
  | { type: 'error'; message: string }

export interface RecentSet {
  path: string
  name: string
  exists: boolean
}

// ---------------------------------------------------------------------------
// Validation guards. IPC payloads are untyped at runtime, so check before use.
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string')

export function isRgb(v: unknown): v is Rgb {
  return Array.isArray(v) && v.length === 3 && v.every((c) => isFiniteNum(c) && c >= 0 && c <= 1)
}

export function isLayerSettings(v: unknown): v is LayerSettings {
  return (
    isObj(v) &&
    typeof v.loop === 'boolean' &&
    isFiniteNum(v.speed) &&
    v.speed >= SPEED_MIN &&
    v.speed <= SPEED_MAX &&
    FIT_MODES.includes(v.fit as FitMode)
  )
}

const CLIP_LOAD_STATES: readonly ClipLoadState[] = ['cold', 'loading', 'ready', 'error']

function isMediaStats(s: unknown): s is MediaStats {
  return (
    isObj(s) &&
    isFiniteNum(s.readyClips) &&
    isFiniteNum(s.loadingClips) &&
    isFiniteNum(s.imageBytes) &&
    isFiniteNum(s.imageBudgetBytes) &&
    isFiniteNum(s.warmVideos) &&
    isFiniteNum(s.warmVideoLimit)
  )
}

export function isControlToOutput(v: unknown): v is ControlToOutput {
  if (!isObj(v)) return false
  switch (v.type) {
    case 'setBackground':
      return isRgb(v.color)
    case 'ping':
      return isFiniteNum(v.id)
    case 'setDebugOverlay':
      return typeof v.visible === 'boolean'
    case 'playClip':
      return isNonEmptyString(v.id) && isLayerSettings(v.settings)
    case 'stopClip':
    case 'requestStatus':
    case 'requestAudioDevices':
      return true
    case 'setAudioSource':
      return v.source === null || isAudioSource(v.source)
    case 'setAnalysisSettings':
      return isAnalysisSettings(v.settings)
    case 'beatCommand':
      return isBeatCommand(v.command)
    case 'padPress':
      return (
        isPadId(v.padId) &&
        isPadSpec(v.spec) &&
        (v.velocity === undefined ||
          (isFiniteNum(v.velocity) && v.velocity >= 0 && v.velocity <= 1))
      )
    case 'padArm':
      return isPadId(v.padId) && isPadSpec(v.spec)
    case 'padRelease':
      return isPadId(v.padId)
    case 'stopAll':
    case 'dropNow':
      return true
    case 'setOutputOptions':
      return isOutputOptions(v.options)
    case 'setTriggerSettings':
      return isTriggerSettings(v.settings)
    case 'setLayers':
      return isLayersConfig(v.config)
    case 'setMaster':
      return isMasterSettings(v.master)
    case 'setPreview':
      return typeof v.enabled === 'boolean'
    case 'stopLayer':
      return isLayerId(v.layer)
    case 'setFx':
      return isFxConfig(v.config)
    case 'setLayerSettings':
      return isLayerSettings(v.settings)
    default:
      return false
  }
}

export function isOutputToControl(v: unknown): v is OutputToControl {
  if (!isObj(v)) return false
  switch (v.type) {
    case 'outputReady':
      return true
    case 'pong':
      return isFiniteNum(v.id)
    case 'frameStats': {
      const s = v.stats
      return (
        isObj(s) &&
        isFiniteNum(s.fps) &&
        isFiniteNum(s.frameTimeAvgMs) &&
        isFiniteNum(s.frameTimeMaxMs) &&
        isFiniteNum(s.droppedFrames)
      )
    }
    case 'backgroundApplied':
      return isRgb(v.color)
    case 'clipState':
      return (
        isNonEmptyString(v.id) &&
        CLIP_LOAD_STATES.includes(v.state as ClipLoadState) &&
        (v.error === undefined || typeof v.error === 'string')
      )
    case 'clipStarted':
      return isNonEmptyString(v.id) && isFiniteNum(v.waitFrames)
    case 'clipEnded':
      return isNonEmptyString(v.id)
    case 'mediaStats':
      return isMediaStats(v.stats)
    case 'audioStatus':
      return isAudioStatus(v.status)
    case 'audioDevices':
      return isAudioDeviceList(v.devices)
    case 'audioMeters':
      return isAudioMeters(v.meters)
    case 'audioOnset':
      return (v.band === 'low' || v.band === 'high') && isFiniteNum(v.strength)
    case 'beatState':
      return isBeatState(v.state)
    case 'beat':
      return isBeatEvent(v.event)
    case 'triggerState':
      return isTriggerState(v.state)
    case 'previewFrame':
      return (
        isFiniteNum(v.width) &&
        isFiniteNum(v.height) &&
        v.width > 0 &&
        v.height > 0 &&
        v.width <= PREVIEW_MAX_SIDE &&
        v.height <= PREVIEW_MAX_SIDE &&
        v.pixels instanceof Uint8Array &&
        v.pixels.length === v.width * v.height * 4
      )
    case 'fxLive':
      return isFxLiveValues(v.values)
    case 'health':
      return (
        isObj(v.health) &&
        isFiniteNum(v.health.level) &&
        v.health.level >= 0 &&
        v.health.level <= 3 &&
        isFiniteNum(v.health.gpuMB)
      )
    case 'layerState':
      return (
        isObj(v.layers) &&
        LAYER_IDS.every((id) => {
          const l = (v.layers as Obj)[id]
          return (
            isObj(l) &&
            (l.clipId === null || typeof l.clipId === 'string') &&
            (l.padId === null || typeof l.padId === 'string')
          )
        })
      )
    default:
      return false
  }
}

export function isOutputCommand(v: unknown): v is OutputCommand {
  if (!isObj(v)) return false
  switch (v.type) {
    case 'exitFullscreen':
    case 'toggleFullscreen':
      return true
    case 'link':
      return typeof v.enabled === 'boolean' && isFiniteNum(v.bpm) && v.bpm >= 20 && v.bpm <= 999
    case 'linkTempo':
      return isFiniteNum(v.bpm) && v.bpm >= 20 && v.bpm <= 999
    default:
      return false
  }
}

export function isLinkSample(v: unknown): v is LinkSample {
  if (!isObj(v)) return false
  if (v.available === false) return typeof v.error === 'string'
  return (
    v.available === true &&
    isFiniteNum(v.tempo) &&
    isFiniteNum(v.phase) &&
    isFiniteNum(v.epochMs) &&
    isFiniteNum(v.peers)
  )
}

export function isMainRequest(v: unknown): v is MainRequest {
  if (!isObj(v)) return false
  switch (v.type) {
    case 'listDisplays':
    case 'getOutputState':
    case 'showOutput':
    case 'getLibrary':
      return true
    case 'moveOutputToDisplay':
      return isFiniteNum(v.displayId)
    case 'setOutputFullscreen':
      return typeof v.fullscreen === 'boolean'
    case 'importPaths':
      return isStringArray(v.paths)
    case 'pickAndImport':
      return v.mode === 'files' || v.mode === 'folder'
    case 'removeClips':
      return isStringArray(v.ids)
    case 'saveSet':
      return (
        checkSet(v.set).ok &&
        (v.path === null || typeof v.path === 'string') &&
        typeof v.saveAs === 'boolean'
      )
    case 'openSet':
      return v.path === null || typeof v.path === 'string'
    case 'newSet':
    case 'restoreSession':
    case 'listRecentSets':
      return true
    case 'autosave':
      return (
        checkSet(v.set).ok &&
        (v.path === null || typeof v.path === 'string') &&
        typeof v.dirty === 'boolean'
      )
    case 'relink':
      return (
        (v.folder === null || typeof v.folder === 'string') &&
        Array.isArray(v.clips) &&
        v.clips.length <= 20000 &&
        v.clips.every(
          (c: unknown) => isObj(c) && typeof c.id === 'string' && typeof c.name === 'string',
        )
      )
    case 'setClipMeta':
      return (
        typeof v.id === 'string' &&
        (v.tags === undefined ||
          (Array.isArray(v.tags) && v.tags.length <= 32 && v.tags.every(isTag))) &&
        (v.favorite === undefined || typeof v.favorite === 'boolean')
      )
    default:
      return false
  }
}

/** The API each preload script exposes on `window.veejus`. */
export interface ControlBridge {
  sendToOutput(msg: ControlToOutput): void
  onOutputMessage(handler: (msg: OutputToControl) => void): () => void
  onOutputState(handler: (state: OutputWindowState) => void): () => void
  onLibrary(handler: (clips: ClipInfo[]) => void): () => void
  request(req: MainRequest): Promise<MainResponse>
  /** Absolute path of a dropped File (Electron's webUtils.getPathForFile). */
  getPathForFile(file: File): string
}

export interface OutputBridge {
  sendToControl(msg: OutputToControl): void
  command(cmd: OutputCommand): void
  onControlMessage(handler: (msg: ControlToOutput) => void): () => void
  onLibrary(handler: (clips: ClipInfo[]) => void): () => void
  getLibrary(): Promise<ClipInfo[]>
  onLink(handler: (sample: LinkSample) => void): () => void
}

function isFxLiveValues(v: unknown): v is FxLiveValues {
  if (!isObj(v)) return false
  return Object.entries(v).every(
    ([scope, values]) =>
      FX_SCOPES.includes(scope as FxScope) &&
      isObj(values) &&
      Object.keys(values).length <= 64 &&
      Object.values(values).every((n) => typeof n === 'number' && Number.isFinite(n)),
  )
}
