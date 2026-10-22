import { FrameStats } from '@core/frameStats'
import {
  isControlToOutput,
  isLinkSample,
  type ClipInfo,
  type FxLiveValues,
  type OutputHealth,
  type LayerSettings,
  type LayerShowing,
  type OutputBridge,
  type Rgb,
} from '@shared/protocol'
import { rgbToHex } from '@shared/color'
import { BAND_NAMES } from '@shared/audio'
import {
  DEFAULT_LAYERS_CONFIG,
  DEFAULT_MASTER,
  LAYER_IDS,
  LAYER_NAMES,
  type LayerId,
  type LayersConfig,
  type MasterSettings,
} from '@shared/layers'
import type { PadSource } from '@shared/pads'
import { FX_SCOPES, emptyFxConfig, type FxConfig, type FxScope } from '@shared/fx'
import { resolveChain, type ModContext, type ResolvedChain } from '@core/modulation/modulation'
import { HOP_SIZE } from '@core/audio/analyzer'
import { BeatEngine } from '@core/beat/beatEngine'
import { TriggerScheduler, type TriggerAction } from '@core/trigger/scheduler'
import { AudioEngine } from './audio/audioEngine'
import { Metronome } from './metronome'
import { ClipLayer } from './clipLayer'
import { MediaManager } from './media/mediaManager'
import { Stage } from './stage'
import { ExternalClock } from './externalClock'
import { Watchdog } from '@core/watchdog'

const bridge = (window as unknown as { veejus: OutputBridge }).veejus

const OVERLAY_INTERVAL_MS = 250
const STATS_INTERVAL_MS = 500
const BEAT_STATE_INTERVAL_MS = 100
const FX_LIVE_INTERVAL_MS = 50
const PREVIEW_INTERVAL_MS = 1000 / 15
const PREVIEW_WIDTH = 320
/** Preview monitor at watchdog level 1. */
const PREVIEW_INTERVAL_REDUCED_MS = 1000 / 6
const PREVIEW_WIDTH_REDUCED = 200
/** Render scale at watchdog level 3. */
const DEGRADED_RENDER_SCALE = 0.75
const MB = 1024 * 1024

const stage = new Stage(document.getElementById('stage') as HTMLCanvasElement)
const overlay = document.getElementById('debug-overlay') as HTMLDivElement
const frameStats = new FrameStats()

const media = new MediaManager((id, state, error) =>
  bridge.sendToControl({ type: 'clipState', id, state, ...(error ? { error } : {}) }),
)

// ---- layers -----------------------------------------------------------------

const PREVIEW_LAYER: LayerId = 'background'
const DEFAULT_LAYER_SETTINGS: LayerSettings = { loop: true, speed: 1, fit: 'contain' }

const layers = Object.fromEntries(
  LAYER_IDS.map((id) => [
    id,
    new ClipLayer(
      stage,
      media,
      {
        // The control's "now playing" and start latency follow the library-preview layer.
        onStarted: (clipId, waitFrames) => {
          if (id === PREVIEW_LAYER)
            bridge.sendToControl({ type: 'clipStarted', id: clipId, waitFrames })
        },
        onEnded: (clipId, owner, reason) => {
          if (owner && reason === 'finished') scheduler.onClipEnded(owner)
          if (id === PREVIEW_LAYER) bridge.sendToControl({ type: 'clipEnded', id: clipId })
        },
        onError: (clipId, error) =>
          bridge.sendToControl({ type: 'clipState', id: clipId, state: 'error', error }),
      },
      { ...DEFAULT_LAYER_SETTINGS },
    ),
  ]),
) as Record<LayerId, ClipLayer>

let layersConfig: LayersConfig = structuredClone(DEFAULT_LAYERS_CONFIG)
let master: MasterSettings = { ...DEFAULT_MASTER }
let previewEnabled = false
let lastPreviewAt = 0
let layerStateSent = ''
let fxConfig: FxConfig = emptyFxConfig()
/** Beat positions of the latest detected kick / high onsets (envelope triggers). */
let lastKickPos: number | null = null
let lastHighPos: number | null = null

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function modContext(now: number): ModContext {
  return {
    pos: beat.clock.position(now),
    barOffset: beat.clock.barOffsetBeats,
    phraseBeats: 4 * beat.clock.phraseBars,
    lastKickPos,
    lastHighPos,
    bands: audio.snapshot.bands,
  }
}

function resolveAll(now: number): Record<FxScope, ResolvedChain> {
  const ctx = modContext(now)
  return Object.fromEntries(FX_SCOPES.map((s) => [s, resolveChain(fxConfig[s], ctx)])) as Record<
    FxScope,
    ResolvedChain
  >
}

/** Modulated chains for the frame being drawn (resolved at the top of each frame). */
let resolved: Record<FxScope, ResolvedChain> | null = null
/** Beat position the current frame was resolved at. */
let frameBeatPos = 0

/** Is anything visible on the takeover layer right now? */
function takeoverActive(): boolean {
  return !!layers.takeover.current?.started && !layersConfig.layers.takeover.muted
}

/** Final opacity for a layer this frame, or 0 if it shouldn't draw. */
function layerOpacity(id: LayerId, now: number, takeover: boolean): number {
  const cfg = layersConfig.layers[id]
  const anySolo = LAYER_IDS.some((l) => layersConfig.layers[l].solo)
  if (cfg.muted || (anySolo && !cfg.solo)) return 0
  const mod = resolved?.[id].opacity ?? 0
  let a = clamp01(cfg.opacity + mod) * scheduler.opacity(id, now, beat.clock)
  if (takeover && id !== 'takeover') {
    if (layersConfig.takeoverMode === 'hide') return 0
    if (layersConfig.takeoverMode === 'dim') a *= 1 - layersConfig.takeoverDim
  }
  return a
}

/** Entrance animation progress for the pad on a layer (1 = finished or none). */
function entranceProgress(id: LayerId, now: number): number {
  const v = scheduler.voiceOn(id)
  if (!v || layers[id].current?.owner !== v.padId) return 1
  const { entrance, entranceBeats } = v.spec.placement
  if (entrance === 'none' || entranceBeats <= 0) return 1
  return Math.min(1, Math.max(0, (beat.clock.position(now) - v.startPos) / entranceBeats))
}

/** Tempo sync: stretch the pad's clip to its beat count at the current tempo. */
function applyTempoSync(id: LayerId): void {
  const layer = layers[id]
  const v = scheduler.voiceOn(id)
  const owned = !!v && layer.current?.owner === v.padId
  if (owned && v.spec.syncBeats !== null && layer.durationMs > 0) {
    layer.speedOverride = layer.durationMs / (v.spec.syncBeats * (60000 / beat.bpm))
  } else if (layer.speedOverride !== null) {
    layer.speedOverride = null
  }
}

function showing(): Record<LayerId, LayerShowing> {
  return Object.fromEntries(
    LAYER_IDS.map((id) => {
      const cur = layers[id].current
      return [id, { clipId: cur?.id ?? null, padId: cur?.owner ?? null }]
    }),
  ) as Record<LayerId, LayerShowing>
}

function sendLayerState(force = false): void {
  const s = showing()
  const sig = JSON.stringify(s)
  if (!force && sig === layerStateSent) return
  layerStateSent = sig
  bridge.sendToControl({ type: 'layerState', layers: s })
}

// ---- beat + audio -----------------------------------------------------------

const beat = new BeatEngine(HOP_SIZE / 48000, performance.now())
const externalClock = new ExternalClock(beat, (cmd) => bridge.command(cmd))
bridge.onLink((sample) => {
  if (isLinkSample(sample)) externalClock.onLink(sample)
})
const metronome = new Metronome(document.getElementById('metronome') as HTMLDivElement)

const audio = new AudioEngine({
  onStatus: (status) => bridge.sendToControl({ type: 'audioStatus', status }),
  onMeters: (meters) => bridge.sendToControl({ type: 'audioMeters', meters }),
  onOnset: (band, strength, timeS, flux) => {
    beat.pushOnset(band, timeS, strength, flux)
    const pos = beat.clock.position(performance.now())
    if (band === 'low') lastKickPos = pos
    else lastHighPos = pos
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

// ---- pads -------------------------------------------------------------------

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
    const inSource = (c: ClipInfo) => {
      switch (source.kind) {
        case 'collection':
          return c.tags.includes(source.tag)
        case 'favorites':
          return c.favorite
        case 'random':
          return source.folder === null || folderOf(c.path) === slashes(source.folder)
      }
    }
    return libraryClips.filter((c) => playable(c) && inSource(c)).map((c) => c.id)
  },
  prepare: (clipId) => {
    if (media.state(clipId) !== 'ready') media.load(clipId).catch(() => {})
  },
})

/** Pad actions as they fired, newest last, for tests and diagnostics. */
const recentActions: {
  type: TriggerAction['type']
  layer: LayerId
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
      layer: a.layer,
      padId: a.padId,
      atMs: now,
      posAtFire: beat.clock.position(now),
      ...(a.type === 'start' ? { clipId: a.clipId, startPos: a.startPos } : {}),
    })
    if (recentActions.length > 64) recentActions.shift()
    const layer = layers[a.layer]
    switch (a.type) {
      case 'start':
        layer.play(a.clipId, layer.settings, frameCount, {
          owner: a.padId,
          loop: a.spec.mode !== 'oneShot',
          placement: a.spec.placement,
          key: a.spec.key,
        })
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

// ---- frame loop ---------------------------------------------------------------

let background: Rgb = [0, 0, 0]
let pendingBackgroundAck = false
let frameCount = 0
let lastFrameAt: number | null = null
let lastOverlayAt = 0
let lastStatsAt = 0
let lastBeatStateAt = 0
let lastFxLiveAt = 0
let fxLiveWasEmpty = true

/**
 * The modulated value of every modulated target, for the control's "ghost" thumbs: final
 * opacity (layer) or brightness (master), transform offsets, and resolved effect parameters.
 */
function fxLiveValues(fx: Record<FxScope, ResolvedChain>): FxLiveValues {
  const out: FxLiveValues = {}
  for (const scope of FX_SCOPES) {
    const mods = fxConfig[scope].mods.filter((m) => m.enabled)
    if (mods.length === 0) continue
    const r = fx[scope]
    const values: Record<string, number> = {}
    for (const { target } of mods) {
      if (target === 'opacity') {
        const base = scope === 'master' ? master.brightness : layersConfig.layers[scope].opacity
        values[target] = clamp01(base + r.opacity)
      } else if (target === 'scale' || target === 'rotation' || target === 'x' || target === 'y') {
        values[target] = r[target]
      } else {
        const dot = target.indexOf('.')
        const v = r.effects.find((e) => e.id === target.slice(0, dot))?.params[
          target.slice(dot + 1)
        ]
        if (v !== undefined) values[target] = v
      }
    }
    out[scope] = values
  }
  return out
}

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
      // A library preview takes its layer over from any pad.
      scheduler.onLayerTakenOver(PREVIEW_LAYER)
      layers[PREVIEW_LAYER].play(msg.id, msg.settings, frameCount)
      break
    case 'stopClip':
      applyTriggerActions(scheduler.stopLayer(PREVIEW_LAYER), performance.now())
      layers[PREVIEW_LAYER].stop()
      sendTriggerState()
      break
    case 'stopLayer':
      applyTriggerActions(scheduler.stopLayer(msg.layer), performance.now())
      layers[msg.layer].stop()
      sendTriggerState()
      break
    case 'padPress':
      scheduler.press(msg.padId, msg.spec, performance.now(), beat.clock, msg.velocity ?? 1)
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
    case 'dropNow':
      scheduler.dropNow(performance.now(), beat.clock)
      sendTriggerState()
      break
    case 'stopAll':
      applyTriggerActions(scheduler.stopAll(), performance.now())
      for (const id of LAYER_IDS) layers[id].stop()
      sendTriggerState()
      break
    case 'setTriggerSettings':
      scheduler.setSettings(msg.settings, performance.now(), beat.clock)
      sendTriggerState()
      break
    case 'setLayerSettings':
      // Loop / speed / fit from the library-preview panel.
      layers[PREVIEW_LAYER].setSettings(msg.settings)
      break
    case 'setLayers':
      layersConfig = structuredClone(msg.config)
      break
    case 'setMaster':
      master = { ...msg.master }
      break
    case 'setFx':
      fxConfig = structuredClone(msg.config)
      break
    case 'setOutputOptions':
      stage.setOptions(msg.options)
      break
    case 'setPreview':
      previewEnabled = msg.enabled
      break
    case 'requestStatus': {
      for (const [id, state] of Object.entries(media.states())) {
        bridge.sendToControl({ type: 'clipState', id, state })
      }
      const cur = layers[PREVIEW_LAYER].current
      if (cur?.started) bridge.sendToControl({ type: 'clipStarted', id: cur.id, waitFrames: 0 })
      bridge.sendToControl({ type: 'audioStatus', status: audio.currentStatus })
      sendBeatState()
      sendTriggerState()
      sendLayerState(true)
      break
    }
    case 'beatCommand': {
      const cmd = msg.command
      const now = performance.now()
      // Following Link, tempo changes are proposed to the whole session instead.
      if (beat.currentSettings.clockSource === 'link') {
        if (cmd.type === 'setBpm') externalClock.proposeTempo(cmd.bpm)
        else if (cmd.type === 'multiply') externalClock.proposeTempo(beat.bpm * cmd.factor)
      }
      beat.command(cmd, now)
      externalClock.setSource(beat.currentSettings.clockSource, now)
      sendBeatState()
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
  const layerLines = LAYER_IDS.map((id) => {
    const cur = layers[id].current
    const cfg = layersConfig.layers[id]
    const flags = `${cfg.muted ? ' muted' : ''}${cfg.solo ? ' solo' : ''}${layers[id].isPaused ? ' paused' : ''}`
    const what = cur ? `${cur.clip.info.name}${cur.owner ? ` [${cur.owner}]` : ''}` : '-'
    return `       ${LAYER_NAMES[id].padEnd(10)} ${what} (${cfg.blend} ${Math.round(cfg.opacity * 100)}%${flags})`
  }).join('\n')
  overlay.textContent =
    `VEEJUS OUTPUT\n` +
    `fps    ${s.fps.toFixed(1)}\n` +
    `frame  ${s.frameTimeAvgMs.toFixed(2)} ms avg / ${s.frameTimeMaxMs.toFixed(2)} ms max\n` +
    `drops  ${s.droppedFrames} (last 1s)\n` +
    `size   ${width}x${height}\n` +
    `bg     ${rgbToHex(background)}  master ${Math.round(master.brightness * 100)}%${master.blackout ? ' BLACKOUT' : ''}\n` +
    `layers\n${layerLines}\n` +
    `fx     ${stage.passesLastFrame} effect passes, ${stage.historyCount} trail buffers\n` +
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

function masterBrightness(): number {
  return master.blackout ? 0 : clamp01(master.brightness + (resolved?.master.opacity ?? 0))
}

// ---- graceful degradation ------------------------------------------------------

const watchdog = new Watchdog()
/** Set by the test hook, so a forced level isn't undone by real frame rates. */
let watchdogPinned = false

function applyDegradeLevel(level: number): void {
  watchdog.level = level
  stage.setRenderScale(level >= 3 ? DEGRADED_RENDER_SCALE : 1)
  bridge.sendToControl({ type: 'health', health: health() })
}

function health(): OutputHealth {
  // Render targets dominate GPU memory; clip textures add one frame per layer.
  const clipBytes = LAYER_IDS.reduce((n, id) => {
    const c = layers[id].current?.clip
    return n + (c ? c.width * c.height * 4 : 0)
  }, 0)
  return {
    level: watchdog.level,
    gpuMB: Math.round((stage.targetBytes + clipBytes) / (1024 * 1024)),
  }
}

/** JS time spent in each recent frame callback, ms. */
const cpuMs: number[] = []

function frame(now: number): void {
  const frameStart = performance.now()
  frameStats.push(now)
  frameCount++
  const dt = lastFrameAt === null ? 0 : now - lastFrameAt
  lastFrameAt = now

  // Advance musical time first, so anything due on this frame is drawn on this frame.
  externalClock.update(now)
  for (const event of beat.update(now)) {
    metronome.beat(event.beatInBar)
    bridge.sendToControl({ type: 'beat', event })
  }
  applyTriggerActions(scheduler.update(now, dt > 0 ? dt : 1000 / 60, beat.clock), now)

  const fx = resolveAll(now)
  resolved = fx
  const beatPos = beat.clock.position(now)
  frameBeatPos = beatPos
  const takeover = takeoverActive()
  const pauseBelow = takeover && layersConfig.takeoverMode === 'pause'
  stage.beginFrame(background)
  for (const id of LAYER_IDS) {
    const layer = layers[id]
    layer.setPaused(pauseBelow && id !== 'takeover')
    applyTempoSync(id)
    layer.render(dt, frameCount, {
      opacity: layerOpacity(id, now, takeover),
      blend: layersConfig.layers[id].blend,
      entranceProgress: entranceProgress(id, now),
      offset: fx[id],
      fx: { scope: id, effects: fx[id].effects, beat: beatPos },
    })
  }
  const m = fx.master
  stage.endFrame(
    masterBrightness(),
    { scope: 'master', effects: m.effects, beat: beatPos },
    { scale: m.scale, rotationDeg: m.rotation, x: m.x, y: m.y },
  )

  while (pixelRequests.length > 0) {
    const r = pixelRequests.shift()!
    r.resolve(stage.readPicturePixel(r.fx, r.fy))
  }
  // Preview readback is asynchronous: collect a finished one, maybe start the next.
  const preview = stage.takePreview()
  if (preview && previewEnabled) bridge.sendToControl({ type: 'previewFrame', ...preview })
  // Graceful degradation trims the preview first (level 1), then pauses it (level 2).
  const level = watchdog.level
  const previewEvery = level >= 1 ? PREVIEW_INTERVAL_REDUCED_MS : PREVIEW_INTERVAL_MS
  const previewWidth = level >= 1 ? PREVIEW_WIDTH_REDUCED : PREVIEW_WIDTH
  if (previewEnabled && level < 2 && now - lastPreviewAt >= previewEvery) {
    const { width, height } = stage.size
    const ph = Math.max(1, Math.round((previewWidth * height) / width))
    if (stage.requestPreview(previewWidth, ph, masterBrightness())) lastPreviewAt = now
  }
  cpuMs.push(performance.now() - frameStart)
  if (cpuMs.length > 120) cpuMs.shift()

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
  sendLayerState()
  if (now - lastFxLiveAt >= FX_LIVE_INTERVAL_MS) {
    lastFxLiveAt = now
    const values = fxLiveValues(fx)
    const empty = Object.keys(values).length === 0
    // Send while anything is modulated, plus one empty update when that stops.
    if (!empty || !fxLiveWasEmpty) bridge.sendToControl({ type: 'fxLive', values })
    fxLiveWasEmpty = empty
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
    const snap = frameStats.snapshot()
    bridge.sendToControl({ type: 'frameStats', stats: snap })
    // The watchdog only judges once there's a full window of frames.
    if (frameCount > 120 && !watchdogPinned) {
      const changed = watchdog.update(snap.fps, now)
      if (changed !== null) applyDegradeLevel(changed)
    }
    bridge.sendToControl({ type: 'health', health: health() })
    bridge.sendToControl({ type: 'mediaStats', stats: media.stats() })
  }
  requestAnimationFrame(frame)
}

// Read-only hooks for end-to-end tests.
;(window as unknown as { __veejusOutput: unknown }).__veejusOutput = {
  getState: () => {
    const now = performance.now()
    const preview = layers[PREVIEW_LAYER]
    const cur = preview.current
    const takeover = takeoverActive()
    return {
      background,
      frameCount,
      overlayVisible: !overlay.hidden,
      canvas: stage.size,
      windowSize: stage.windowSize,
      viewport: stage.viewport,
      degradeLevel: watchdog.level,
      gpuMB: health().gpuMB,
      frameStats: frameStats.snapshot(),
      cpu: {
        avgMs: cpuMs.reduce((a, b) => a + b, 0) / Math.max(1, cpuMs.length),
        maxMs: Math.max(0, ...cpuMs),
      },
      settings: preview.settings,
      clipStates: media.states(),
      media: media.stats(),
      audio: {
        status: audio.currentStatus,
        onsetCounts: { ...audio.onsetCounts },
        bands: Array.from(audio.snapshot.bands),
        rms: audio.snapshot.rms,
        latencyMs: audio.latencyMs,
      },
      beat: beat.state(now),
      trigger: {
        state: scheduler.state(now, beat.clock),
        recentActions: [...recentActions],
        beatsPerMs: beat.clock.beatsPerMs,
        owner: cur?.owner ?? null,
        opacity: scheduler.opacity(PREVIEW_LAYER, now, beat.clock),
        speedOverride:
          LAYER_IDS.map((id) => layers[id].speedOverride).find((s) => s !== null) ?? null,
      },
      layers: Object.fromEntries(
        LAYER_IDS.map((id) => {
          const l = layers[id]
          return [
            id,
            {
              clipId: l.current?.id ?? null,
              owner: l.current?.owner ?? null,
              paused: l.isPaused,
              transform: l.lastTransform,
              opacity: layerOpacity(id, now, takeover),
            },
          ]
        }),
      ),
      layersConfig,
      master,
      fx: {
        config: fxConfig,
        passes: stage.passesLastFrame,
        history: stage.historyCount,
        resolved,
        lastKickPos,
        framePos: frameBeatPos,
        barOffset: beat.clock.barOffsetBeats,
      },
      takeoverActive: takeover,
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
  /** Force a degradation level (tests); null hands control back to the watchdog. */
  setDegradeLevel: (level: number | null) => {
    watchdogPinned = level !== null
    if (level === null) watchdog.reset()
    applyDegradeLevel(level ?? 0)
  },
  /** Feed a MIDI message to the MIDI clock input, as if it came from a device. */
  injectMidi: (bytes: number[], atMs?: number) =>
    externalClock.midi.onMessage(bytes, atMs ?? performance.now()),
  /** The visual beat position now, with the matching epoch time (for Link alignment tests). */
  clockNow: () => {
    const now = performance.now()
    return {
      pos: beat.clock.position(now),
      epochMs: performance.timeOrigin + now,
      latencyOffsetMs: beat.clock.latencyOffsetMs,
      barOffset: beat.clock.barOffsetBeats,
    }
  },
}

requestAnimationFrame(frame)
bridge.sendToControl({ type: 'outputReady' })
