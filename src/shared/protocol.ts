/**
 * Typed IPC protocol shared by the main process, the control window and the output window.
 *
 * Renderer <-> renderer messages travel through the main process, which forwards them
 * unchanged. Every message is validated with the guards below before it is acted on.
 */

import type { ClipKind } from './mediaTypes'
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

/** Window commands the output page can ask main for (e.g. from its own key handling). */
export type OutputCommand = { type: 'exitFullscreen' } | { type: 'toggleFullscreen' }

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

export interface ImportResult {
  added: number
  skipped: number
}

export type MainResponse =
  | { type: 'displays'; displays: DisplayInfo[] }
  | { type: 'outputState'; state: OutputWindowState }
  | { type: 'library'; clips: ClipInfo[] }
  | { type: 'imported'; result: ImportResult }
  | { type: 'error'; message: string }

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
    default:
      return false
  }
}

export function isOutputCommand(v: unknown): v is OutputCommand {
  return isObj(v) && (v.type === 'exitFullscreen' || v.type === 'toggleFullscreen')
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
}
