import { FrameStats } from '@core/frameStats'
import { isControlToOutput, type OutputBridge, type Rgb } from '@shared/protocol'
import { rgbToHex } from '@shared/color'
import { BAND_NAMES } from '@shared/audio'
import { HOP_SIZE } from '@core/audio/analyzer'
import { BeatEngine } from '@core/beat/beatEngine'
import { TriggerScheduler, type TriggerAction } from '@core/trigger/scheduler'
import type { ClipInfo } from '@shared/protocol'
import type { PadSource } from '@shared/pads'
import { AudioEngine } from './audio/audioEngine'
import { Metronome } from './metronome'
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
    onEnded: (id, owner, reason) => {
      if (owner && reason === 'finished') scheduler.onClipEnded(owner)
      bridge.sendToControl({ type: 'clipEnded', id })
    },
    onError: (id, error) => bridge.sendToControl({ type: 'clipState', id, state: 'error', error }),
  },
  { loop: true, speed: 1, fit: 'contain' },
)

const BEAT_STATE_INTERVAL_MS = 100

const beat = new BeatEngine(HOP_SIZE / 48000, performance.now())
const metronome = new Metronome(document.getElementById('metronome') as HTMLDivElement)

const audio = new AudioEngine({
  onStatus: (status) => bridge.sendToControl({ type: 'audioStatus', status }),
  onMeters: (meters) => bridge.sendToControl({ type: 'audioMeters', meters }),
  onOnset: (band, strength, timeS, flux) => {
    beat.pushOnset(band, timeS, strength, flux)
    bridge.sendToControl({ type: 'audioOnset', band, strength })
  },
  onFlux: (low, high, endTime, receivedAtMs) => {
    beat.observeSync(endTime, receivedAtMs)
    for (let i = 0; i < low.length; i++) beat.pushFlux(low[i]!, high[i]!)
  },
  onSourceChange: (sampleRate) => {
    beat.resetAudio()
    if (sampleRate) beat.setHopSeconds(HOP_SIZE / sampleRate)
  },
  onDevices: (devices) => bridge.sendToControl({ type: 'audioDevices', devices }),
})

function sendBeatState(now = performance.now()): void {
  bridge.sendToControl({ type: 'beatState', state: beat.state(now) })
}

// ---- pads ------------------------------------------------------------------

let libraryClips: ClipInfo[] = []

/** Parent folder of a clip path, with forward slashes. */
const slashes = (path: string) => path.replaceAll('\\', '/')
const folderOf = (path: string) => slashes(path).replace(/\/[^/]*$/, '')

const scheduler = new TriggerScheduler({
  candidates: (source: PadSource) => {
    const playable = (c: ClipInfo) => media.state(c.id) !== 'error'
    if (source.kind === 'clip') {
      const clip = libraryClips.find((c) => c.id === source.clipId)
      return clip && playable(clip) ? [clip.id] : []
    }
    const folder = source.folder !== null ? slashes(source.folder) : null
    return libraryClips
      .filter((c) => playable(c) && (folder === null || folderOf(c.path) === folder))
      .map((c) => c.id)
  },
  prepare: (clipId) => {
    if (media.state(clipId) !== 'ready') media.load(clipId).catch(() => {})
  },
})

/** Pad actions as they fired, newest last, for tests and diagnostics. */
const recentActions: {
  type: TriggerAction['type']
  padId: string
  clipId?: string
  atMs: number
  /** Scheduled beat position (starts), and the clock position on the frame it fired. */
  startPos?: number
  posAtFire: number
}[] = []
let triggerVersionSent = -1
let lastTriggerStateAt = 0

function sendTriggerState(now = performance.now()): void {
  triggerVersionSent = scheduler.version
  bridge.sendToControl({ type: 'triggerState', state: scheduler.state(now, beat.clock) })
}

function applyTriggerActions(actions: TriggerAction[], now: number): void {
  for (const a of actions) {
    recentActions.push({
      type: a.type,
      padId: a.padId,
      atMs: now,
      posAtFire: beat.clock.position(now),
      ...(a.type === 'start' ? { clipId: a.clipId, startPos: a.startPos } : {}),
    })
    if (recentActions.length > 64) recentActions.shift()
    switch (a.type) {
      case 'start':
        layer.play(a.clipId, layer.settings, frameCount, a.padId, a.spec.mode !== 'oneShot')
        break
      case 'restart':
        if (layer.current?.owner === a.padId) layer.restart()
        break
      case 'stop':
        if (layer.current?.owner === a.padId) layer.stop()
        break
    }
  }
}

/** Per-frame pad effects: tempo-synced speed and fades for the pad that owns the layer. */
function padFrameEffects(now: number): number {
  const spec = scheduler.currentSpec
  const owned = !!spec && layer.current?.owner === scheduler.currentPadId
  if (owned && spec.syncBeats !== null && layer.durationMs > 0) {
    layer.speedOverride = layer.durationMs / (spec.syncBeats * (60000 / beat.bpm))
  } else if (layer.speedOverride !== null) {
    layer.speedOverride = null
  }
  return owned ? scheduler.opacity(now, beat.clock) : 1
}

let background: Rgb = [0, 0, 0]
let pendingBackgroundAck = false
let frameCount = 0
let lastFrameAt: number | null = null
let lastOverlayAt = 0
let lastStatsAt = 0
let lastBeatStateAt = 0

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
      metronome.setVisible(msg.visible)
      break
    case 'playClip':
      // A library preview takes the layer over from any pad.
      scheduler.onLayerTakenOver()
      layer.play(msg.id, msg.settings, frameCount)
      break
    case 'stopClip':
      applyTriggerActions(scheduler.stopAll(), performance.now())
      layer.stop()
      sendTriggerState()
      break
    case 'padPress':
      scheduler.press(msg.padId, msg.spec, performance.now(), beat.clock)
      sendTriggerState()
      break
    case 'padRelease':
      scheduler.release(msg.padId, performance.now(), beat.clock)
      sendTriggerState()
      break
    case 'padArm':
      scheduler.arm(msg.padId, msg.spec, performance.now(), beat.clock)
      sendTriggerState()
      break
    case 'stopAll':
      applyTriggerActions(scheduler.stopAll(), performance.now())
      sendTriggerState()
      break
    case 'setTriggerSettings':
      scheduler.settings = { ...msg.settings }
      sendTriggerState()
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
      sendBeatState()
      sendTriggerState()
      break
    }
    case 'beatCommand':
      beat.command(msg.command, performance.now())
      sendBeatState()
      break
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

function onLibrary(clips: ClipInfo[]): void {
  libraryClips = clips
  media.sync(clips)
}
bridge.onLibrary(onLibrary)
bridge.getLibrary().then(onLibrary).catch(console.error)

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
    `videos ${m.warmVideos}/${m.warmVideoLimit} warm\n` +
    audioOverlayText() +
    '\n' +
    beatOverlayText()
}

function beatOverlayText(): string {
  const b = beat.state(performance.now())
  const mode = b.settings.tempoMode === 'auto' ? 'auto' : 'locked'
  const detected = b.detectedBpm !== null ? `, detected ${b.detectedBpm.toFixed(1)}` : ''
  return (
    `beat   ${b.bpm.toFixed(1)} BPM ${mode} (conf ${(b.confidence * 100).toFixed(0)}%${detected})\n` +
    `       bar ${b.barIndex + 1} beat ${b.beatInBar}, phrase ${b.phraseIndex + 1} ` +
    `(bar ${b.barInPhrase}/${b.settings.phraseBars}), ${b.inPhase ? 'in phase' : 'searching'}`
  )
}

function audioOverlayText(): string {
  const st = audio.currentStatus
  if (st.state !== 'running') return `audio  ${st.state}${st.error ? `: ${st.error}` : ''}`
  const bands = BAND_NAMES.map((n, i) => `${n[0]}${audio.snapshot.bands[i]!.toFixed(2)}`).join(' ')
  return (
    `audio  ${st.label} @ ${st.sampleRate} Hz, ~${audio.latencyMs.toFixed(0)} ms\n` +
    `       ${bands}\n` +
    `       kicks ${audio.onsetCounts.low}, highs ${audio.onsetCounts.high}`
  )
}

function frame(now: number): void {
  frameStats.push(now)
  frameCount++
  const dt = lastFrameAt === null ? 0 : now - lastFrameAt
  lastFrameAt = now

  // Advance musical time first, so anything due on this frame is drawn on this frame.
  for (const event of beat.update(now)) {
    metronome.beat(event.beatInBar)
    bridge.sendToControl({ type: 'beat', event })
  }
  applyTriggerActions(scheduler.update(now, dt > 0 ? dt : 1000 / 60, beat.clock), now)
  const opacity = padFrameEffects(now)

  stage.beginFrame(background)
  layer.render(dt, frameCount, opacity)

  if (now - lastBeatStateAt >= BEAT_STATE_INTERVAL_MS) {
    lastBeatStateAt = now
    sendBeatState(now)
  }
  const dropActive = scheduler.state(now, beat.clock).drop !== null
  if (
    scheduler.version !== triggerVersionSent ||
    (dropActive && now - lastTriggerStateAt >= BEAT_STATE_INTERVAL_MS)
  ) {
    lastTriggerStateAt = now
    sendTriggerState(now)
  }

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
      beat: beat.state(performance.now()),
      trigger: {
        state: scheduler.state(performance.now(), beat.clock),
        recentActions: [...recentActions],
        beatsPerMs: beat.clock.beatsPerMs,
        owner: cur?.owner ?? null,
        opacity: padFrameEffects(performance.now()),
        speedOverride: layer.speedOverride,
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
