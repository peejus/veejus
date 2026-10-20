import { FrameStats } from '@core/frameStats'
import { isControlToOutput, type OutputBridge, type Rgb } from '@shared/protocol'
import { rgbToHex } from '@shared/color'
import { BAND_NAMES } from '@shared/audio'
import { AudioEngine } from './audio/audioEngine'
import { ClipLayer } from './clipLayer'
import { MediaManager } from './media/mediaManager'
import { Stage } from './stage'

const bridge = (window as unknown as { veejus: OutputBridge }).veejus

const OVERLAY_INTERVAL_MS = 250
const STATS_INTERVAL_MS = 500
const MB = 1024 * 1024

const stage = new Stage(document.getElementById('stage') as HTMLCanvasElement)
const overlay = document.getElementById('debug-overlay') as HTMLDivElement
const frameStats = new FrameStats()

const media = new MediaManager((id, state, error) =>
  bridge.sendToControl({ type: 'clipState', id, state, ...(error ? { error } : {}) }),
)

const layer = new ClipLayer(
  stage,
  media,
  {
    onStarted: (id, waitFrames) => bridge.sendToControl({ type: 'clipStarted', id, waitFrames }),
    onEnded: (id) => bridge.sendToControl({ type: 'clipEnded', id }),
    onError: (id, error) => bridge.sendToControl({ type: 'clipState', id, state: 'error', error }),
  },
  { loop: true, speed: 1, fit: 'contain' },
)

const audio = new AudioEngine({
  onStatus: (status) => bridge.sendToControl({ type: 'audioStatus', status }),
  onMeters: (meters) => bridge.sendToControl({ type: 'audioMeters', meters }),
  onOnset: (band, strength) => bridge.sendToControl({ type: 'audioOnset', band, strength }),
  onDevices: (devices) => bridge.sendToControl({ type: 'audioDevices', devices }),
})

let background: Rgb = [0, 0, 0]
let pendingBackgroundAck = false
let frameCount = 0
let lastFrameAt: number | null = null
let lastOverlayAt = 0
let lastStatsAt = 0

/** Pixel reads requested by tests; served right after the next frame is drawn. */
const pixelRequests: { fx: number; fy: number; resolve: (px: number[] | null) => void }[] = []

bridge.onControlMessage((msg) => {
  if (!isControlToOutput(msg)) return
  switch (msg.type) {
    case 'setBackground':
      background = msg.color
      pendingBackgroundAck = true
      break
    case 'ping':
      bridge.sendToControl({ type: 'pong', id: msg.id })
      break
    case 'setDebugOverlay':
      overlay.hidden = !msg.visible
      break
    case 'playClip':
      layer.play(msg.id, msg.settings, frameCount)
      break
    case 'stopClip':
      layer.stop()
      break
    case 'setLayerSettings':
      layer.setSettings(msg.settings)
      break
    case 'requestStatus': {
      for (const [id, state] of Object.entries(media.states())) {
        bridge.sendToControl({ type: 'clipState', id, state })
      }
      const cur = layer.current
      if (cur?.started) bridge.sendToControl({ type: 'clipStarted', id: cur.id, waitFrames: 0 })
      bridge.sendToControl({ type: 'audioStatus', status: audio.currentStatus })
      break
    }
    case 'setAudioSource':
      void audio.setSource(msg.source)
      break
    case 'setAnalysisSettings':
      audio.setSettings(msg.settings)
      break
    case 'requestAudioDevices':
      void audio.listDevices()
      break
  }
})

bridge.onLibrary((clips) => media.sync(clips))
bridge
  .getLibrary()
  .then((clips) => media.sync(clips))
  .catch(console.error)

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') bridge.command({ type: 'exitFullscreen' })
  else if (e.key === 'F11') {
    e.preventDefault()
    bridge.command({ type: 'toggleFullscreen' })
  }
})

function updateOverlay(): void {
  if (overlay.hidden) return
  const s = frameStats.snapshot()
  const m = media.stats()
  const { width, height } = stage.size
  const cur = layer.current
  const clipLine = cur ? `${cur.clip.info.name} (${cur.clip.width}x${cur.clip.height})` : '(none)'
  overlay.textContent =
    `VEEJUS OUTPUT\n` +
    `fps    ${s.fps.toFixed(1)}\n` +
    `frame  ${s.frameTimeAvgMs.toFixed(2)} ms avg / ${s.frameTimeMaxMs.toFixed(2)} ms max\n` +
    `drops  ${s.droppedFrames} (last 1s)\n` +
    `size   ${width}x${height}\n` +
    `bg     ${rgbToHex(background)}\n` +
    `clip   ${clipLine}\n` +
    `media  ${m.readyClips} ready, ${m.loadingClips} loading\n` +
    `       images ${(m.imageBytes / MB).toFixed(0)}/${(m.imageBudgetBytes / MB).toFixed(0)} MB, ` +
    `videos ${m.warmVideos}/${m.warmVideoLimit} warm
` +
    audioOverlayText()
}

function audioOverlayText(): string {
  const st = audio.currentStatus
  if (st.state !== 'running') return `audio  ${st.state}${st.error ? `: ${st.error}` : ''}`
  const bands = BAND_NAMES.map((n, i) => `${n[0]}${audio.snapshot.bands[i]!.toFixed(2)}`).join(' ')
  return (
    `audio  ${st.label} @ ${st.sampleRate} Hz, ~${audio.latencyMs.toFixed(0)} ms
` +
    `       ${bands}
` +
    `       kicks ${audio.onsetCounts.low}, highs ${audio.onsetCounts.high}`
  )
}

function frame(now: number): void {
  frameStats.push(now)
  frameCount++
  const dt = lastFrameAt === null ? 0 : now - lastFrameAt
  lastFrameAt = now

  stage.beginFrame(background)
  layer.render(dt, frameCount)

  while (pixelRequests.length > 0) {
    const r = pixelRequests.shift()!
    const { width, height } = stage.size
    r.resolve(stage.readPixel(r.fx * (width - 1), r.fy * (height - 1)))
  }
  if (pendingBackgroundAck) {
    pendingBackgroundAck = false
    bridge.sendToControl({ type: 'backgroundApplied', color: background })
  }
  if (now - lastOverlayAt >= OVERLAY_INTERVAL_MS) {
    lastOverlayAt = now
    updateOverlay()
  }
  if (now - lastStatsAt >= STATS_INTERVAL_MS) {
    lastStatsAt = now
    bridge.sendToControl({ type: 'frameStats', stats: frameStats.snapshot() })
    bridge.sendToControl({ type: 'mediaStats', stats: media.stats() })
  }
  requestAnimationFrame(frame)
}

// Read-only hooks for end-to-end tests.
;(window as unknown as { __veejusOutput: unknown }).__veejusOutput = {
  getState: () => {
    const cur = layer.current
    return {
      background,
      frameCount,
      overlayVisible: !overlay.hidden,
      canvas: stage.size,
      frameStats: frameStats.snapshot(),
      settings: layer.settings,
      clipStates: media.states(),
      media: media.stats(),
      audio: {
        status: audio.currentStatus,
        onsetCounts: { ...audio.onsetCounts },
        bands: Array.from(audio.snapshot.bands),
        rms: audio.snapshot.rms,
        latencyMs: audio.latencyMs,
      },
      current: cur
        ? {
            id: cur.id,
            kind: cur.clip.kind,
            started: cur.started,
            width: cur.clip.width,
            height: cur.clip.height,
            imageFrame: cur.clip.kind === 'image' ? cur.uploadedFrame : null,
            videoTime: cur.clip.kind === 'video' ? cur.clip.el.currentTime : null,
          }
        : null,
    }
  },
  /** RGBA of the pixel at fractional canvas position (fx, fy), read after the next frame. */
  samplePixel: (fx: number, fy: number) =>
    new Promise<number[] | null>((resolve) => pixelRequests.push({ fx, fy, resolve })),
}

requestAnimationFrame(frame)
bridge.sendToControl({ type: 'outputReady' })
