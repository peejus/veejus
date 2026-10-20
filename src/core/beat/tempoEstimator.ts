/**
 * Tempo estimation from an onset-strength signal (one value per analysis hop).
 *
 * Every `intervalSeconds` it autocorrelates the last `windowSeconds` of the signal and scores
 * each candidate tempo by the autocorrelation at 1-4 multiples of its beat period. Octave
 * ambiguity (87 vs 174 BPM) is resolved toward the faster tempo when that tempo is nearly as
 * well supported, and results are always inside [minBpm, maxBpm].
 */

export interface TempoEstimate {
  bpm: number
  /** 0..1: how much the best tempo stands out from the rest. */
  confidence: number
}

export interface TempoEstimatorOptions {
  windowSeconds: number
  /** No estimate until this much signal has been seen. */
  minHistorySeconds: number
  intervalSeconds: number
}

const DEFAULTS: TempoEstimatorOptions = {
  windowSeconds: 8,
  minHistorySeconds: 3,
  intervalSeconds: 0.5,
}

const HARMONICS = 4
const SEARCH_STEP_BPM = 0.05
/** The faster octave wins if its score is at least this fraction of the slower one's. */
const OCTAVE_UP_RATIO = 0.7
/** Moving-average window removed from the signal so only transients correlate. */
const DETREND_SECONDS = 0.2

export class TempoEstimator {
  private readonly ring: Float32Array
  private writeIndex = 0
  private filled = 0
  private sinceEstimate = 0
  private minBpm = 70
  private maxBpm = 180
  private readonly options: TempoEstimatorOptions
  // Scratch buffers, reused between estimates.
  private readonly signal: Float32Array
  private acf: Float32Array

  constructor(
    private readonly hopSeconds: number,
    options: Partial<TempoEstimatorOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options }
    const n = Math.round(this.options.windowSeconds / hopSeconds)
    this.ring = new Float32Array(n)
    this.signal = new Float32Array(n)
    this.acf = new Float32Array(1)
  }

  setRange(minBpm: number, maxBpm: number): void {
    this.minBpm = minBpm
    this.maxBpm = maxBpm
  }

  /** Add one hop of onset strength. Returns a fresh estimate when one is due. */
  push(value: number): TempoEstimate | null {
    this.ring[this.writeIndex] = value
    this.writeIndex = (this.writeIndex + 1) % this.ring.length
    if (this.filled < this.ring.length) this.filled++
    if (++this.sinceEstimate * this.hopSeconds < this.options.intervalSeconds) return null
    this.sinceEstimate = 0
    if (this.filled * this.hopSeconds < this.options.minHistorySeconds) return null
    return this.estimate()
  }

  reset(): void {
    this.ring.fill(0)
    this.writeIndex = 0
    this.filled = 0
    this.sinceEstimate = 0
  }

  /** Estimate from the buffered signal now (also used directly by tests). */
  estimate(): TempoEstimate | null {
    const n = this.filled
    const x = this.signal
    const start = (this.writeIndex - n + this.ring.length) % this.ring.length
    for (let i = 0; i < n; i++) x[i] = this.ring[(start + i) % this.ring.length]!

    // Remove the slow envelope so only transients correlate, then the mean.
    const half = Math.max(1, Math.round(DETREND_SECONDS / this.hopSeconds / 2))
    let run = 0
    const detrended = new Float32Array(n)
    for (let i = 0; i < Math.min(n, half); i++) run += x[i]!
    let count = Math.min(n, half)
    for (let i = 0; i < n; i++) {
      const add = i + half
      if (add < n) {
        run += x[add]!
        count++
      }
      const drop = i - half - 1
      if (drop >= 0) {
        run -= x[drop]!
        count--
      }
      detrended[i] = Math.max(0, x[i]! - run / count)
    }
    let mean = 0
    for (let i = 0; i < n; i++) mean += detrended[i]!
    mean /= n
    for (let i = 0; i < n; i++) detrended[i]! -= mean

    // Unbiased autocorrelation up to the longest lag any candidate needs (capped so every
    // lag still averages over a decent stretch of signal).
    const maxLag = Math.min(
      Math.ceil((HARMONICS * 60) / this.minBpm / this.hopSeconds) + 2,
      Math.floor(n * 0.75),
    )
    if (this.acf.length < maxLag + 1) this.acf = new Float32Array(maxLag + 1)
    const acf = this.acf
    for (let lag = 0; lag <= maxLag; lag++) {
      let sum = 0
      for (let i = 0; i + lag < n; i++) sum += detrended[i]! * detrended[i + lag]!
      acf[lag] = sum / (n - lag)
    }
    const energy = acf[0]!
    if (!(energy > 1e-12)) return null

    const score = (bpm: number): number => {
      const lag = 60 / bpm / this.hopSeconds
      let total = 0
      let terms = 0
      for (let k = 1; k <= HARMONICS; k++) {
        const l = k * lag
        if (l > maxLag - 1) break
        const i = Math.floor(l)
        const f = l - i
        total += acf[i]! * (1 - f) + acf[i + 1]! * f
        terms++
      }
      return terms ? total / terms / energy : -Infinity
    }

    let bestBpm = 0
    let best = -Infinity
    let sum = 0
    let samples = 0
    for (let bpm = this.minBpm; bpm <= this.maxBpm + 1e-9; bpm += SEARCH_STEP_BPM) {
      const s = score(bpm)
      if (!Number.isFinite(s)) continue
      sum += s
      samples++
      if (s > best) {
        best = s
        bestBpm = bpm
      }
    }
    if (!samples || best <= 0) return null

    // Prefer the faster octave when it is nearly as well supported (174 rather than 87).
    while (bestBpm * 2 <= this.maxBpm && score(bestBpm * 2) >= OCTAVE_UP_RATIO * best) {
      bestBpm *= 2
      best = score(bestBpm)
    }

    // Parabolic refinement around the peak.
    const s0 = score(bestBpm - SEARCH_STEP_BPM)
    const s2 = score(bestBpm + SEARCH_STEP_BPM)
    const denom = s0 - 2 * best + s2
    if (Number.isFinite(s0) && Number.isFinite(s2) && denom < 0) {
      const shift = (SEARCH_STEP_BPM * 0.5 * (s0 - s2)) / denom
      bestBpm += Math.max(-SEARCH_STEP_BPM, Math.min(SEARCH_STEP_BPM, shift))
    }

    const avg = sum / samples
    const confidence = Math.min(1, Math.max(0, (best - avg) / Math.max(1e-6, 1 - avg)) * 2)
    return { bpm: bestBpm, confidence }
  }
}
