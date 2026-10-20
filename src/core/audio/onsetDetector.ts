/**
 * Picks onsets from a spectral-flux stream with an adaptive threshold.
 *
 * A frame is an onset when its flux:
 *  - is a local peak (greater than the previous frames, not less than the next one),
 *  - exceeds `ratio` x the recent mean flux plus an absolute floor `delta`,
 *  - is at least `peakFraction` of the second-strongest onset within `peakWindowSeconds`
 *    (so bass notes and beating between a kick tail and a bassline, which are much weaker
 *    than the kicks around them, are ignored). Using the second-strongest means one huge
 *    hit (the first kick of a drop after silence) can't mask the hits that follow it, and
 *    weaker onsets that slip through can't lower the bar for more of them,
 *  - and comes at least `minIntervalSeconds` after the previous onset, unless it is more than
 *    twice as strong as that onset (so a weak false trigger can't swallow the real hit).
 * The one-frame lookahead adds a single hop of latency.
 */

export interface DetectedOnset {
  /** Time of the peak frame, in seconds (before any latency compensation). */
  time: number
  /** Flux relative to the threshold (>= 1). */
  strength: number
  /** Raw spectral flux of the peak, comparable across time. */
  flux: number
}

export interface OnsetDetectorOptions {
  hopSeconds: number
  minIntervalSeconds: number
  /** Length of the history the adaptive mean threshold averages over. */
  historySeconds: number
  /** Absolute flux floor at sensitivity 0.5 (scales with sensitivity). */
  baseDelta: number
  /** Onsets older than this stop counting toward the recent-onset gate. */
  peakWindowSeconds: number
  /** Fraction of the second-strongest recent onset's flux required at sensitivity 0.5. */
  basePeakFraction: number
}

/** Frames before the candidate it must exceed, so a peak is a real local maximum. */
const PEAK_LOOKBACK = 3
/** Recent onsets remembered for the gate. */
const GATE_ONSETS = 8

/** Fixed-length ring of recent values with running sum. */
class Ring {
  readonly values: Float32Array
  private index = 0
  filled = 0
  sum = 0

  constructor(length: number) {
    this.values = new Float32Array(Math.max(4, length))
  }

  push(v: number): void {
    if (this.filled === this.values.length) this.sum -= this.values[this.index]!
    else this.filled++
    this.values[this.index] = v
    this.sum += v
    this.index = (this.index + 1) % this.values.length
  }

  get mean(): number {
    return this.filled ? this.sum / this.filled : 0
  }

  clear(): void {
    this.values.fill(0)
    this.index = 0
    this.filled = 0
    this.sum = 0
  }
}

export class OnsetDetector {
  private readonly meanHistory: Ring
  /** Flux and time of recent onsets, oldest first. */
  private readonly onsetFlux: number[] = []
  private readonly onsetTimes: number[] = []
  /** Recent flux values, newest last, for peak picking. */
  private readonly recent: number[] = []
  private readonly recentTimes: number[] = []
  private lastOnsetTime = -Infinity
  private lastOnsetFlux = 0
  private ratio = 2.5
  private delta = 0
  private peakFraction = 0

  constructor(
    private readonly options: OnsetDetectorOptions,
    sensitivity: number,
  ) {
    this.meanHistory = new Ring(Math.round(options.historySeconds / options.hopSeconds))
    this.setSensitivity(sensitivity)
  }

  /** 0 = only the biggest hits, 1 = nearly every bump. */
  setSensitivity(sensitivity: number): void {
    const s = Math.min(1, Math.max(0, sensitivity))
    const strictness = 2 * (1 - s) // 0..2, 1 at the default 0.5
    this.ratio = 1.3 + 1.2 * strictness
    this.delta = this.options.baseDelta * (0.25 + strictness)
    this.peakFraction = this.options.basePeakFraction * strictness
  }

  /** Feed the flux of the frame ending at `time`. Returns an onset for the previous frame, if any. */
  push(flux: number, time: number): DetectedOnset | null {
    this.recent.push(flux)
    this.recentTimes.push(time)
    if (this.recent.length > PEAK_LOOKBACK + 2) {
      this.recent.shift()
      this.recentTimes.shift()
    }

    let onset: DetectedOnset | null = null
    const n = this.recent.length
    if (n === PEAK_LOOKBACK + 2) {
      const candIdx = n - 2
      const cand = this.recent[candIdx]!
      const candTime = this.recentTimes[candIdx]!
      let isPeak = cand >= this.recent[n - 1]!
      for (let i = 0; i < candIdx && isPeak; i++) if (this.recent[i]! >= cand) isPeak = false
      if (isPeak) {
        const threshold = this.ratio * this.meanHistory.mean + this.delta
        const peakGate = this.peakFraction * this.gateReference(candTime)
        const spaced =
          candTime - this.lastOnsetTime >= this.options.minIntervalSeconds ||
          cand > 2 * this.lastOnsetFlux
        if (cand > threshold && cand >= peakGate && spaced) {
          this.lastOnsetTime = candTime
          this.lastOnsetFlux = cand
          onset = { time: candTime, strength: threshold > 0 ? cand / threshold : 1, flux: cand }
          this.onsetFlux.push(cand)
          this.onsetTimes.push(candTime)
          if (this.onsetFlux.length > GATE_ONSETS) {
            this.onsetFlux.shift()
            this.onsetTimes.shift()
          }
        }
      }
      // The candidate joins the history only after being judged, so it can't raise its own bar.
      this.meanHistory.push(cand)
    }
    return onset
  }

  /** Second-largest onset flux in the gate window; 0 (no gate) until two such onsets exist. */
  private gateReference(now: number): number {
    while (
      this.onsetTimes.length > 0 &&
      now - this.onsetTimes[0]! > this.options.peakWindowSeconds
    ) {
      this.onsetTimes.shift()
      this.onsetFlux.shift()
    }
    let first = 0
    let second = 0
    for (const f of this.onsetFlux) {
      if (f > first) {
        second = first
        first = f
      } else if (f > second) second = f
    }
    return second
  }

  /**
   * Forget the adaptive levels (mean and recent-onset gate) but keep peak-picking state.
   * Call when the input level is deliberately rescaled, so detection adapts immediately.
   */
  resetLevels(): void {
    this.meanHistory.clear()
    this.onsetFlux.length = 0
    this.onsetTimes.length = 0
  }

  reset(): void {
    this.meanHistory.clear()
    this.onsetFlux.length = 0
    this.onsetTimes.length = 0
    this.recent.length = 0
    this.recentTimes.length = 0
    this.lastOnsetTime = -Infinity
    this.lastOnsetFlux = 0
  }
}
