import { BEATS_PER_BAR, type BeatEvent } from '@shared/beat'

/**
 * The master musical clock, in performance.now() milliseconds.
 *
 * It runs on the *visual* timeline: `latencyOffsetMs` ahead of the audio, so visuals can be
 * pulled earlier to cancel input and display latency. Its beat position only moves forward
 * and never jumps when the tempo or phase target changes: it runs slightly fast or slow until
 * it converges on the target grid. Only explicit alignment (tap, resync) snaps it.
 */

export interface ClockTarget {
  periodMs: number
  /** Real (audio) time of a beat on the target grid. */
  beatAtMs: number
}

/** Phase errors converge with roughly this time constant, in beats. */
const CONVERGE_BEATS = 1
/** The running rate never strays further than this from the target rate. */
const MAX_RATE_DEVIATION = 0.5

export class BeatClock {
  private anchorV = 0
  private anchorPos = 0
  /** Beats per ms. */
  private rate: number
  private target: ClockTarget
  private lastEmitted: number
  private barOffset = 0
  private offsetMs = 0
  phraseBars: number

  constructor(nowMs: number, bpm = 120, phraseBars = 8) {
    const periodMs = 60000 / bpm
    this.rate = 1 / periodMs
    this.anchorV = nowMs
    this.target = { periodMs, beatAtMs: nowMs }
    this.lastEmitted = -1
    this.phraseBars = phraseBars
  }

  get bpm(): number {
    return 60000 / this.target.periodMs
  }

  get latencyOffsetMs(): number {
    return this.offsetMs
  }

  /** Position in beats on the visual timeline at real time `nowMs`. */
  position(nowMs: number): number {
    return this.anchorPos + (nowMs + this.offsetMs - this.anchorV) * this.rate
  }

  /** Converge smoothly onto a new grid. */
  setTarget(target: ClockTarget): void {
    this.target = { ...target }
  }

  /** Change tempo, keeping the current phase. */
  setTempo(periodMs: number, nowMs: number): void {
    const v = nowMs + this.offsetMs
    const pos = this.position(nowMs)
    const frac = pos - Math.floor(pos)
    this.target = { periodMs, beatAtMs: v - frac * periodMs }
  }

  getTarget(): ClockTarget {
    return { ...this.target }
  }

  /**
   * Snap onto the target grid now, choosing the nearest beat (moves at most half a beat).
   * A beat already emitted is not emitted again.
   */
  snap(nowMs: number): void {
    const v = nowMs + this.offsetMs
    const pos = this.position(nowMs)
    const tgtPhase = (v - this.target.beatAtMs) / this.target.periodMs
    let delta = tgtPhase - pos
    delta -= Math.round(delta)
    this.anchorPos = pos + delta
    this.anchorV = v
    this.rate = 1 / this.target.periodMs
  }

  /** Make the beat nearest to now beat 1 of a bar. */
  setDownbeatNow(nowMs: number): void {
    const beat = Math.round(this.position(nowMs))
    this.barOffset = ((-beat % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR
  }

  setLatencyOffset(ms: number, nowMs: number): void {
    // Keep the position continuous at this instant; convergence then shifts the phase.
    const pos = this.position(nowMs)
    this.offsetMs = ms
    this.anchorV = nowMs + ms
    this.anchorPos = pos
  }

  /**
   * Advance to `nowMs`: emit beats crossed since the last call, then steer the rate toward
   * the target grid. Call once per rendered frame.
   */
  update(nowMs: number): BeatEvent[] {
    const v = nowMs + this.offsetMs
    const pos = this.position(nowMs)
    const events: BeatEvent[] = []
    const last = Math.floor(pos)
    if (last - this.lastEmitted > 64) this.lastEmitted = last - 1 // after a long stall
    for (let k = this.lastEmitted + 1; k <= last; k++) {
      const crossV = this.anchorV + (k - this.anchorPos) / this.rate
      events.push(this.eventFor(k, crossV - this.offsetMs))
    }
    if (last > this.lastEmitted) this.lastEmitted = last

    const { periodMs, beatAtMs } = this.target
    const tgtPhase = (v - beatAtMs) / periodMs
    let err = tgtPhase - pos
    err -= Math.round(err)
    const base = 1 / periodMs
    const steer = err / (CONVERGE_BEATS * periodMs)
    this.rate = Math.min(
      base * (1 + MAX_RATE_DEVIATION),
      Math.max(base * (1 - MAX_RATE_DEVIATION), base + steer),
    )
    this.anchorV = v
    this.anchorPos = pos
    return events
  }

  private eventFor(beatIndex: number, atMs: number): BeatEvent {
    const b = this.musical(beatIndex)
    return { beatIndex, atMs, ...b }
  }

  private musical(beatIndex: number) {
    const shifted = beatIndex + this.barOffset
    const barIndex = Math.floor(shifted / BEATS_PER_BAR)
    const beatInBar = (((shifted % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR) + 1
    const phraseIndex = Math.floor(barIndex / this.phraseBars)
    const barInPhrase = (((barIndex % this.phraseBars) + this.phraseBars) % this.phraseBars) + 1
    return { beatInBar, barIndex, phraseIndex, barInPhrase }
  }

  /** Musical position at `nowMs` (visual timeline). */
  snapshot(nowMs: number) {
    const pos = this.position(nowMs)
    // Tolerate float error right at a beat (1.9999999 is beat 2).
    const beatIndex = Math.floor(pos + 1e-6)
    return { beatIndex, beatPhase: Math.max(0, pos - beatIndex), ...this.musical(beatIndex) }
  }
}
