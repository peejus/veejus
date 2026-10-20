/**
 * Tap tempo: a least-squares line through the recent taps gives the beat period (robust to
 * single sloppy taps) and a smoothed time for the latest beat.
 */

/** A pause longer than this starts a new tap sequence. */
const RESET_AFTER_MS = 2000
const MAX_TAPS = 16

export interface TapResult {
  /** Null after a single tap: only the phase is known. */
  bpm: number | null
  /** Fitted time of the latest tap (a beat), ms. */
  beatAtMs: number
  taps: number
}

export class TapTempo {
  private taps: number[] = []

  get count(): number {
    return this.taps.length
  }

  tap(atMs: number): TapResult {
    const last = this.taps[this.taps.length - 1]
    if (last !== undefined && (atMs - last > RESET_AFTER_MS || atMs <= last)) this.taps = []
    this.taps.push(atMs)
    if (this.taps.length > MAX_TAPS) this.taps.shift()

    const n = this.taps.length
    if (n < 2) return { bpm: null, beatAtMs: atMs, taps: n }
    // Fit t = a + b * i.
    const meanI = (n - 1) / 2
    const meanT = this.taps.reduce((s, t) => s + t, 0) / n
    let num = 0
    let den = 0
    this.taps.forEach((t, i) => {
      num += (i - meanI) * (t - meanT)
      den += (i - meanI) ** 2
    })
    const period = num / den
    const fittedLast = meanT + period * (n - 1 - meanI)
    return { bpm: 60000 / period, beatAtMs: fittedLast, taps: n }
  }

  /** Forget the sequence if the last tap is old. */
  expire(nowMs: number): void {
    const last = this.taps[this.taps.length - 1]
    if (last !== undefined && nowMs - last > RESET_AFTER_MS) this.taps = []
  }

  reset(): void {
    this.taps = []
  }
}
