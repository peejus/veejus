/**
 * Typed IPC protocol shared by the main process, the control window and the output window.
 *
 * Renderer <-> renderer messages travel through the main process, which forwards them
 * unchanged. Every message is validated with the guards below before it is acted on.
 */

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
} as const

/** Linear RGB in 0..1. */
export type Rgb = readonly [number, number, number]

export type ControlToOutput =
  | { type: 'setBackground'; color: Rgb }
  | { type: 'ping'; id: number }
  | { type: 'setDebugOverlay'; visible: boolean }

export interface FrameStatsSnapshot {
  fps: number
  frameTimeAvgMs: number
  frameTimeMaxMs: number
  /** Frames longer than ~1.5x the expected frame interval within the window. */
  droppedFrames: number
}

export type OutputToControl =
  | { type: 'outputReady' }
  | { type: 'pong'; id: number }
  | { type: 'frameStats'; stats: FrameStatsSnapshot }
  /** Sent the first frame after a setBackground is drawn, for latency checks. */
  | { type: 'backgroundApplied'; color: Rgb }

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

export type MainResponse =
  | { type: 'displays'; displays: DisplayInfo[] }
  | { type: 'outputState'; state: OutputWindowState }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------------------
// Validation guards. IPC payloads are untyped at runtime, so check before use.
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function isRgb(v: unknown): v is Rgb {
  return Array.isArray(v) && v.length === 3 && v.every((c) => isFiniteNum(c) && c >= 0 && c <= 1)
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
      return true
    case 'moveOutputToDisplay':
      return isFiniteNum(v.displayId)
    case 'setOutputFullscreen':
      return typeof v.fullscreen === 'boolean'
    default:
      return false
  }
}

/** The API each preload script exposes on `window.veejus`. */
export interface ControlBridge {
  sendToOutput(msg: ControlToOutput): void
  onOutputMessage(handler: (msg: OutputToControl) => void): () => void
  onOutputState(handler: (state: OutputWindowState) => void): () => void
  request(req: MainRequest): Promise<MainResponse>
}

export interface OutputBridge {
  sendToControl(msg: OutputToControl): void
  command(cmd: OutputCommand): void
  onControlMessage(handler: (msg: ControlToOutput) => void): () => void
}
