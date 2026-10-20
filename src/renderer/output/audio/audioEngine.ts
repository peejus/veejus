import {
  BAND_COUNT,
  DEFAULT_ANALYSIS_SETTINGS,
  type AnalysisSettings,
  type AudioDevice,
  type AudioMeters,
  type AudioSource,
  type AudioStatus,
  type OnsetBand,
} from '@shared/audio'
import { renderPattern } from '@core/audio/synth'
import workletUrl from './analysis.worklet.ts?worker&url'
import type { WorkletMessage } from './workletMessages'

export interface AudioEngineEvents {
  onStatus(status: AudioStatus): void
  onMeters(meters: AudioMeters): void
  /**
   * `timeS` is the onset in analysis seconds, `atMs` its estimated performance.now() time.
   * `flux` is the raw onset flux.
   */
  onOnset(band: OnsetBand, strength: number, timeS: number, flux: number, atMs: number): void
  /** A batch of onset-strength values (one per hop) ending at analysis time `endTime`. */
  onFlux(low: number[], high: number[], endTime: number, receivedAtMs: number): void
  /** The input changed; analysis history no longer applies. */
  onSourceChange(sampleRate: number | null): void
  onDevices(devices: AudioDevice[]): void
}

/** Latest analysis values, for the render loop and later the beat clock. */
export interface AudioSnapshot {
  bands: Float32Array
  rms: number
  /** performance.now() when these values arrived. */
  updatedAt: number
}

const TEST_BEAT_BARS = 2

/**
 * Owns the AudioContext, the analysis worklet and the current input. Inputs can be switched
 * at any time; the worklet (and its analysis state) stays, only the source node changes.
 * Nothing is ever connected to the speakers: the worklet's output goes through a muted gain.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private setupPromise: Promise<void> | null = null
  private sourceNode: AudioNode | null = null
  private stream: MediaStream | null = null
  private status: AudioStatus = { state: 'off', source: null }
  private settings: AnalysisSettings = DEFAULT_ANALYSIS_SETTINGS
  /** Bumped on every setSource; stale async work checks it and backs off. */
  private sourceToken = 0
  readonly snapshot: AudioSnapshot = {
    bands: new Float32Array(BAND_COUNT),
    rms: 0,
    updatedAt: 0,
  }
  readonly onsetCounts: Record<OnsetBand, number> = { low: 0, high: 0 }
  latencyMs = 0

  constructor(private readonly events: AudioEngineEvents) {
    navigator.mediaDevices?.addEventListener('devicechange', () => void this.listDevices())
  }

  get currentStatus(): AudioStatus {
    return this.status
  }

  private setStatus(status: AudioStatus): void {
    this.status = status
    this.events.onStatus(status)
  }

  private async ensureGraph(): Promise<void> {
    if (this.node) return
    if (!this.setupPromise) {
      this.setupPromise = (async () => {
        const ctx = new AudioContext({ latencyHint: 'interactive' })
        await ctx.audioWorklet.addModule(workletUrl)
        const node = new AudioWorkletNode(ctx, 'veejus-analysis', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
          processorOptions: { settings: this.settings },
        })
        node.port.onmessage = (e: MessageEvent<WorkletMessage>) => this.onWorkletMessage(e.data)
        // Keep the node pulled by the graph without making any sound.
        const mute = ctx.createGain()
        mute.gain.value = 0
        node.connect(mute).connect(ctx.destination)
        this.ctx = ctx
        this.node = node
      })()
      this.setupPromise.catch(() => (this.setupPromise = null))
    }
    await this.setupPromise
  }

  private onWorkletMessage(msg: WorkletMessage): void {
    const now = performance.now()
    switch (msg.type) {
      case 'onset':
        this.onsetCounts[msg.band]++
        this.events.onOnset(msg.band, msg.strength, msg.time, msg.flux, now - msg.delayS * 1000)
        break
      case 'flux':
        this.events.onFlux(msg.low, msg.high, msg.endTime, now)
        break
      case 'bands':
        this.snapshot.bands.set(msg.bands)
        this.snapshot.rms = msg.rms
        this.snapshot.updatedAt = now
        break
      case 'meters':
        this.latencyMs = msg.latencyMs
        this.events.onMeters({
          bands: msg.bands,
          rms: msg.rms,
          peak: msg.peak,
          clipped: msg.clipped,
          spectrum: msg.spectrum,
          latencyMs: msg.latencyMs,
        })
        break
    }
  }

  setSettings(settings: AnalysisSettings): void {
    this.settings = settings
    this.node?.port.postMessage({ type: 'settings', settings })
  }

  /** Switch input. Resolves once the new source runs (or failed); never throws. */
  async setSource(source: AudioSource | null): Promise<void> {
    const token = ++this.sourceToken
    this.detachSource()
    this.events.onSourceChange(null)
    if (!source) {
      this.setStatus({ state: 'off', source: null })
      if (this.ctx?.state === 'running') await this.ctx.suspend()
      return
    }
    this.setStatus({ state: 'starting', source })
    try {
      await this.ensureGraph()
      const ctx = this.ctx!
      if (ctx.state !== 'running') await ctx.resume()
      const { node: sourceNode, stream, label } = await this.createSource(ctx, source)
      if (token !== this.sourceToken) {
        // Superseded while starting.
        stream?.getTracks().forEach((t) => t.stop())
        return
      }
      this.sourceNode = sourceNode
      this.stream = stream
      this.node!.port.postMessage({ type: 'reset' })
      sourceNode.connect(this.node!)
      for (const track of stream?.getAudioTracks() ?? []) {
        track.addEventListener('ended', () => {
          if (token !== this.sourceToken) return
          this.detachSource()
          this.setStatus({ state: 'error', source, label, error: 'Input disconnected' })
        })
      }
      this.events.onSourceChange(ctx.sampleRate)
      this.setStatus({ state: 'running', source, label, sampleRate: ctx.sampleRate })
      if (source.kind === 'device') void this.listDevices()
    } catch (err) {
      if (token !== this.sourceToken) return
      this.detachSource()
      this.setStatus({ state: 'error', source, error: describeError(err) })
    }
  }

  private async createSource(
    ctx: AudioContext,
    source: AudioSource,
  ): Promise<{ node: AudioNode; stream: MediaStream | null; label: string }> {
    switch (source.kind) {
      case 'test': {
        const buffer = testBeatBuffer(ctx, source.bpm)
        const node = ctx.createBufferSource()
        node.buffer = buffer
        node.loop = true
        node.start()
        return { node, stream: null, label: `Test beat ${source.bpm} BPM` }
      }
      case 'device': {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: source.deviceId ? { exact: source.deviceId } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: { ideal: 2 },
          },
        })
        const track = stream.getAudioTracks()[0]
        return {
          node: ctx.createMediaStreamSource(stream),
          stream,
          label: track?.label || 'Audio input',
        }
      }
      case 'loopback': {
        // Main answers this with the whole screen plus system-audio loopback; only audio is used.
        const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
        stream.getVideoTracks().forEach((t) => {
          t.stop()
          stream.removeTrack(t)
        })
        if (stream.getAudioTracks().length === 0) throw new Error('System audio is not available')
        return { node: ctx.createMediaStreamSource(stream), stream, label: 'System audio' }
      }
    }
  }

  private detachSource(): void {
    if (this.sourceNode) {
      if (this.sourceNode instanceof AudioBufferSourceNode) this.sourceNode.stop()
      this.sourceNode.disconnect()
      this.sourceNode = null
    }
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.snapshot.bands.fill(0)
    this.snapshot.rms = 0
  }

  async listDevices(): Promise<AudioDevice[]> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      const devices = all
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Audio input ${i + 1}` }))
      this.events.onDevices(devices)
      return devices
    } catch {
      this.events.onDevices([])
      return []
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
        return 'Permission denied'
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'Device not found'
      case 'NotReadableError':
        return 'Device is busy or unavailable'
    }
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * A seamless loop of the synthesized house pattern. Hits that ring past the loop end are
 * folded back to the start so the loop point is inaudible.
 */
function testBeatBuffer(ctx: AudioContext, bpm: number): AudioBuffer {
  const rendered = renderPattern(
    {
      bpm,
      bars: TEST_BEAT_BARS,
      kick: [0, 4, 8, 12],
      snare: [4, 12],
      hat: [2, 6, 10, 14],
      bass: true,
      leadIn: 0,
      gainDb: -6,
    },
    ctx.sampleRate,
  )
  const loopLength = Math.round(((TEST_BEAT_BARS * 4 * 60) / bpm) * ctx.sampleRate)
  const data = new Float32Array(loopLength)
  for (let i = 0; i < rendered.samples.length; i++) data[i % loopLength]! += rendered.samples[i]!
  const buffer = ctx.createBuffer(1, loopLength, ctx.sampleRate)
  buffer.copyToChannel(data, 0)
  return buffer
}
