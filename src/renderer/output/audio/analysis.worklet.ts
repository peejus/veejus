/**
 * AudioWorklet that runs the shared AudioAnalyzer on the audio thread.
 *
 * Messages to the main thread:
 *  - onset:  sent immediately, with how long after the onset it was detected
 *  - bands:  band envelopes every other hop (~94/s at 48 kHz), for visuals
 *  - meters: levels + spectrum ~30/s, for the control UI
 */

import { AudioAnalyzer, HOP_SIZE } from '@core/audio/analyzer'
import type { AnalysisSettings } from '@shared/audio'
import type { WorkletMessage } from './workletMessages'

// AudioWorkletGlobalScope declarations (not in the DOM lib).
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(
  name: string,
  ctor: new (options: {
    processorOptions: { settings: AnalysisSettings }
  }) => AudioWorkletProcessor,
): void

const METER_INTERVAL_S = 1 / 30
const BANDS_EVERY_HOPS = 2
const SPECTRUM_BINS = 64
const CLIP_LEVEL = 0.999
const FLUX_BATCH_HOPS = 8

class AnalysisProcessor extends AudioWorkletProcessor {
  private readonly analyzer: AudioAnalyzer
  private mono = new Float32Array(128)
  private readonly spectrum = new Float32Array(SPECTRUM_BINS)
  private hops = 0
  private meterSumSq = 0
  private meterHops = 0
  private meterPeak = 0
  private clipped = false
  private lastMeterTime = 0
  /** Running mean of onset detection delay, seconds. */
  private detectionDelay = 0
  private fluxLow: number[] = []
  private fluxHigh: number[] = []

  constructor(options: { processorOptions: { settings: AnalysisSettings } }) {
    super(options)
    this.analyzer = new AudioAnalyzer(sampleRate, options.processorOptions.settings)
    this.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; settings?: AnalysisSettings }
      if (msg.type === 'settings' && msg.settings) this.analyzer.setSettings(msg.settings)
      else if (msg.type === 'reset') this.analyzer.reset()
    }
  }

  private post(msg: WorkletMessage): void {
    this.port.postMessage(msg)
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]
    const channels = input?.length ?? 0
    const n = input?.[0]?.length ?? 128
    if (this.mono.length !== n) this.mono = new Float32Array(n)
    if (channels === 0) this.mono.fill(0)
    else {
      for (let i = 0; i < n; i++) {
        let sum = 0
        for (let c = 0; c < channels; c++) sum += input![c]![i]!
        this.mono[i] = sum / channels
      }
    }

    const blockEnd = this.analyzer.time + n / sampleRate
    this.analyzer.process(this.mono, (frame) => {
      for (const o of frame.onsets) {
        const delay = blockEnd - o.time
        this.detectionDelay =
          this.detectionDelay === 0 ? delay : this.detectionDelay * 0.9 + delay * 0.1
        this.post({
          type: 'onset',
          band: o.band,
          strength: o.strength,
          flux: o.flux,
          time: o.time,
          delayS: delay,
        })
      }
      this.fluxLow.push(frame.flux.low)
      this.fluxHigh.push(frame.flux.high)
      if (this.fluxLow.length >= FLUX_BATCH_HOPS) {
        this.post({ type: 'flux', low: this.fluxLow, high: this.fluxHigh, endTime: frame.time })
        this.fluxLow = []
        this.fluxHigh = []
      }
      this.meterSumSq += frame.rms * frame.rms
      this.meterHops++
      if (frame.peak > this.meterPeak) this.meterPeak = frame.peak
      if (frame.peak >= CLIP_LEVEL) this.clipped = true

      if (++this.hops % BANDS_EVERY_HOPS === 0) {
        this.post({ type: 'bands', bands: Array.from(frame.bands), rms: frame.rms })
      }
      if (frame.time - this.lastMeterTime >= METER_INTERVAL_S) {
        this.lastMeterTime = frame.time
        this.analyzer.spectrum(this.spectrum)
        this.post({
          type: 'meters',
          bands: Array.from(frame.bands),
          rms: Math.sqrt(this.meterSumSq / Math.max(1, this.meterHops)),
          peak: this.meterPeak,
          clipped: this.clipped,
          spectrum: Array.from(this.spectrum),
          // Typical delay from a sound entering to its analysis reaching the main thread.
          latencyMs: (this.detectionDelay || (HOP_SIZE * 2) / sampleRate) * 1000,
        })
        this.meterSumSq = 0
        this.meterHops = 0
        this.meterPeak = 0
        this.clipped = false
      }
    })
    return true
  }
}

registerProcessor('veejus-analysis', AnalysisProcessor)
