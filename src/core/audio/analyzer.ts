import type { AnalysisSettings, OnsetBand } from '@shared/audio'
import { BAND_COUNT } from '@shared/audio'
import { EnvelopeFollower } from './envelope'
import { hannWindow, RealFft } from './fft'
import { OnsetDetector } from './onsetDetector'

/**
 * The audio analysis pipeline, shared by the live AudioWorklet and offline tests/tools.
 * Feed mono samples in blocks of any size; every HOP_SIZE samples it emits a frame with band
 * envelopes, levels and any onsets. Results do not depend on how input is split into blocks.
 */

export const FFT_SIZE = 1024
export const HOP_SIZE = 256

/** Band levels map this dB range (relative to a full-scale sine) onto 0..1. */
const LEVEL_FLOOR_DB = -60

/** Fixed analysis ranges for the onset detectors. */
const ONSET_RANGES_HZ: Record<OnsetBand, [number, number]> = {
  low: [30, 180],
  high: [2500, 16000],
}
const ONSET_MIN_INTERVAL_S: Record<OnsetBand, number> = { low: 0.09, high: 0.05 }
const ONSET_BASE_DELTA: Record<OnsetBand, number> = { low: 0.5, high: 0.1 }
/** Fraction of the second-strongest recent onset's flux an onset needs (at sensitivity 0.5). */
const ONSET_PEAK_FRACTION: Record<OnsetBand, number> = { low: 0.5, high: 0.1 }
const ONSET_PEAK_WINDOW_S = 1.5
/** SuperFlux: compare against the frame this many hops back, max-filtered across +-1 bin. */
const FLUX_LAG_HOPS = 2
/** Log compression for spectral flux: log(1 + C * magnitude). */
const FLUX_COMPRESSION = 1000

/**
 * Flux peaks a little after the true onset, once the attack is well inside the window.
 * Reported onset times are moved earlier by this fraction of the FFT window.
 * Measured on synthetic drums (see tests/unit/audioOnsets.test.ts).
 */
export const ONSET_COMPENSATION_WINDOWS = 0.4

/** Log-spaced spectrum display range. */
const SPECTRUM_MIN_HZ = 30
const SPECTRUM_MAX_HZ = 16000
const SPECTRUM_FLOOR_DB = -70

export interface Onset {
  band: OnsetBand
  /** Estimated onset time in analyzer seconds (samples processed / sample rate). */
  time: number
  strength: number
}

export interface AnalyzerFrame {
  /** Time of the end of this frame's window, in analyzer seconds. */
  time: number
  /** Envelope-followed band levels, 0..1. Reused between frames; copy to keep. */
  bands: Float32Array
  /** RMS and peak of this hop's samples after input gain, linear. */
  rms: number
  peak: number
  onsets: Onset[]
}

const dbToGain = (db: number) => Math.pow(10, db / 20)

export class AudioAnalyzer {
  readonly sampleRate: number
  private settings!: AnalysisSettings
  private inputGain = 1
  private bandGains = new Float32Array(BAND_COUNT)
  /** Bin index where each band starts; band b covers [edges[b], edges[b+1]). */
  private bandEdges = new Uint32Array(BAND_COUNT + 1)

  private readonly fft = new RealFft(FFT_SIZE)
  private readonly window = hannWindow(FFT_SIZE)
  private readonly ring = new Float32Array(FFT_SIZE)
  private ringPos = 0
  private readonly frameBuf = new Float32Array(FFT_SIZE)
  private readonly mags = new Float32Array(FFT_SIZE / 2 + 1)
  private readonly logMags = new Float32Array(FFT_SIZE / 2 + 1)
  /** Max-filtered log magnitudes of the last FLUX_LAG_HOPS frames, oldest first. */
  private readonly laggedMaxLogMags = Array.from(
    { length: FLUX_LAG_HOPS },
    () => new Float32Array(FFT_SIZE / 2 + 1),
  )
  private samplesUntilHop = HOP_SIZE
  private totalSamples = 0
  private hopSumSq = 0
  private hopPeak = 0

  private readonly envelopes: EnvelopeFollower[]
  private readonly bandLevels = new Float32Array(BAND_COUNT)
  private readonly detectors: Record<OnsetBand, OnsetDetector>
  private readonly onsetBins: Record<OnsetBand, [number, number]>
  /** Magnitude normalization so a full-scale sine reads ~1. */
  private readonly magScale = 1 / (FFT_SIZE / 4)
  private readonly onsetCompensationS: number

  constructor(sampleRate: number, settings: AnalysisSettings) {
    this.sampleRate = sampleRate
    this.onsetCompensationS = (FFT_SIZE * ONSET_COMPENSATION_WINDOWS) / sampleRate
    const hopSeconds = HOP_SIZE / sampleRate
    this.envelopes = Array.from(
      { length: BAND_COUNT },
      () => new EnvelopeFollower(hopSeconds, settings.attackMs, settings.releaseMs),
    )
    const detector = (band: OnsetBand, sensitivity: number) =>
      new OnsetDetector(
        {
          hopSeconds,
          minIntervalSeconds: ONSET_MIN_INTERVAL_S[band],
          historySeconds: 0.5,
          baseDelta: ONSET_BASE_DELTA[band],
          peakWindowSeconds: ONSET_PEAK_WINDOW_S,
          basePeakFraction: ONSET_PEAK_FRACTION[band],
        },
        sensitivity,
      )
    this.detectors = {
      low: detector('low', settings.kickSensitivity),
      high: detector('high', settings.highSensitivity),
    }
    this.onsetBins = {
      low: this.binRange(...ONSET_RANGES_HZ.low),
      high: this.binRange(...ONSET_RANGES_HZ.high),
    }
    this.setSettings(settings)
  }

  setSettings(settings: AnalysisSettings): void {
    const previous = this.settings as AnalysisSettings | undefined
    this.settings = settings
    this.inputGain = dbToGain(settings.inputGainDb)
    for (let b = 0; b < BAND_COUNT; b++) this.bandGains[b] = settings.bandGainsDb[b]!
    const edgesHz = [0, ...settings.crossoversHz, this.sampleRate / 2]
    for (let b = 0; b <= BAND_COUNT; b++) {
      this.bandEdges[b] = Math.min(FFT_SIZE / 2 + 1, Math.round(this.hzToBin(edgesHz[b]!)))
    }
    // The top edge includes the Nyquist bin.
    this.bandEdges[BAND_COUNT] = FFT_SIZE / 2 + 1
    for (const env of this.envelopes) env.setTimes(settings.attackMs, settings.releaseMs)
    this.detectors.low.setSensitivity(settings.kickSensitivity)
    this.detectors.high.setSensitivity(settings.highSensitivity)
    // A gain change rescales everything; let the onset thresholds re-learn from the new level.
    if (previous && previous.inputGainDb !== settings.inputGainDb) {
      this.detectors.low.resetLevels()
      this.detectors.high.resetLevels()
    }
  }

  get currentSettings(): AnalysisSettings {
    return this.settings
  }

  /** Seconds of audio processed so far. */
  get time(): number {
    return this.totalSamples / this.sampleRate
  }

  private hzToBin(hz: number): number {
    return (hz * FFT_SIZE) / this.sampleRate
  }

  private binRange(loHz: number, hiHz: number): [number, number] {
    const lo = Math.max(1, Math.floor(this.hzToBin(loHz)))
    const hi = Math.min(FFT_SIZE / 2, Math.ceil(this.hzToBin(hiHz)))
    return [lo, Math.max(lo, hi)]
  }

  /** Feed mono samples. `onFrame` is called for each completed hop. */
  process(samples: ArrayLike<number>, onFrame: (frame: AnalyzerFrame) => void): void {
    const gain = this.inputGain
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]! * gain
      this.ring[this.ringPos] = x
      this.ringPos = (this.ringPos + 1) % FFT_SIZE
      this.hopSumSq += x * x
      const ax = Math.abs(x)
      if (ax > this.hopPeak) this.hopPeak = ax
      this.totalSamples++
      if (--this.samplesUntilHop === 0) {
        this.samplesUntilHop = HOP_SIZE
        onFrame(this.analyzeFrame())
      }
    }
  }

  private analyzeFrame(): AnalyzerFrame {
    // Unroll the ring (oldest first) and window it.
    for (let i = 0; i < FFT_SIZE; i++) {
      this.frameBuf[i] = this.ring[(this.ringPos + i) % FFT_SIZE]! * this.window[i]!
    }
    this.fft.magnitudes(this.frameBuf, this.mags)
    const time = this.totalSamples / this.sampleRate

    // Band levels.
    for (let b = 0; b < BAND_COUNT; b++) {
      let power = 0
      for (let k = this.bandEdges[b]!; k < this.bandEdges[b + 1]!; k++) {
        const m = this.mags[k]! * this.magScale
        power += m * m
      }
      const db = 10 * Math.log10(power + 1e-12) + this.bandGains[b]!
      const norm = Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB))
      this.bandLevels[b] = this.envelopes[b]!.step(norm)
    }

    // Spectral flux per onset range.
    for (let k = 0; k < this.mags.length; k++) {
      this.logMags[k] = Math.log(1 + FLUX_COMPRESSION * this.mags[k]! * this.magScale)
    }
    const onsets: Onset[] = []
    const reference = this.laggedMaxLogMags[0]!
    for (const band of ['low', 'high'] as const) {
      const [lo, hi] = this.onsetBins[band]
      let flux = 0
      for (let k = lo; k <= hi; k++) {
        const d = this.logMags[k]! - reference[k]!
        if (d > 0) flux += d
      }
      flux /= hi - lo + 1
      const hit = this.detectors[band].push(flux, time)
      if (hit) {
        // The detector judges the previous frame (one-hop lookahead).
        onsets.push({
          band,
          time: Math.max(0, hit.time - this.onsetCompensationS),
          strength: hit.strength,
        })
      }
    }
    // Rotate the lag buffer; the newest slot gets this frame, max-filtered over +-1 bin, so
    // pitch glides (a kick's falling tone) don't register as new energy.
    const newest = this.laggedMaxLogMags.shift()!
    const last = this.logMags.length - 1
    for (let k = 0; k <= last; k++) {
      newest[k] = Math.max(
        this.logMags[Math.max(0, k - 1)]!,
        this.logMags[k]!,
        this.logMags[Math.min(last, k + 1)]!,
      )
    }
    this.laggedMaxLogMags.push(newest)

    const rms = Math.sqrt(this.hopSumSq / HOP_SIZE)
    const peak = this.hopPeak
    this.hopSumSq = 0
    this.hopPeak = 0
    return { time, bands: this.bandLevels, rms, peak, onsets }
  }

  /**
   * Log-spaced spectrum of the latest frame, 0..1 per bin, written into `out`.
   * Each display bin takes the strongest FFT bin in its range.
   */
  spectrum(out: Float32Array | number[]): void {
    const n = out.length
    const ratio = Math.pow(SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ, 1 / n)
    let lo = SPECTRUM_MIN_HZ
    for (let i = 0; i < n; i++) {
      const hi = lo * ratio
      const b0 = Math.max(1, Math.floor(this.hzToBin(lo)))
      const b1 = Math.max(b0, Math.min(FFT_SIZE / 2, Math.floor(this.hzToBin(hi))))
      let m = 0
      for (let k = b0; k <= b1; k++) if (this.mags[k]! > m) m = this.mags[k]!
      const db = 20 * Math.log10(m * this.magScale + 1e-9)
      out[i] = Math.min(1, Math.max(0, (db - SPECTRUM_FLOOR_DB) / -SPECTRUM_FLOOR_DB))
      lo = hi
    }
  }

  reset(): void {
    this.ring.fill(0)
    for (const m of this.laggedMaxLogMags) m.fill(0)
    this.ringPos = 0
    this.samplesUntilHop = HOP_SIZE
    this.hopSumSq = 0
    this.hopPeak = 0
    for (const env of this.envelopes) env.reset()
    this.detectors.low.reset()
    this.detectors.high.reset()
  }
}
