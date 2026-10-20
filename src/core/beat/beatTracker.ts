/**
 * Keeps a beat grid (period + a reference beat time) aligned to detected onsets, in seconds
 * of analysis time. A phase-locked loop nudges the grid toward onsets that land near a
 * predicted beat; onsets far from any beat (offbeat bass, fills) are ignored. If most recent
 * onsets keep landing in the same off-grid place, the grid re-acquires that phase.
 */

/** Fraction of the phase error corrected per matching onset. */
const PHASE_GAIN = 0.2
/** Onsets within this fraction of a period from a predicted beat count as hits. */
const HIT_WINDOW = 0.15
/** Recent onsets kept for hit-rate and re-acquisition. */
const HISTORY = 8
const HISTORY_SECONDS = 4
/** Re-acquire when fewer than this fraction of recent onsets hit the grid... */
const REACQUIRE_HIT_RATE = 0.4
/** ...and their phases agree at least this well (mean resultant length). */
const REACQUIRE_CONSISTENCY = 0.6
const MIN_ONSETS_TO_ACQUIRE = 4
/**
 * Off-grid onsets weaker than this fraction of the typical on-grid hit are ignored: in a
 * breakdown, offbeat bass notes must not drag the grid off the beat.
 */
const WEAK_ONSET_FRACTION = 0.5
/**
 * With no on-grid hits for this long, the typical hit strength starts decaying, very slowly:
 * a DJ mix keeps the phase across tracks, so the grid should outlast long breakdowns.
 */
const TYPICAL_DECAY_AFTER_S = 8
const TYPICAL_DECAY_TAU_S = 600

/** On-grid hits kept for measuring the period precisely. */
const PERIOD_FIT_SECONDS = 16
const PERIOD_FIT_MIN_HITS = 8
const PERIOD_FIT_MIN_SPAN_S = 4

interface RecentOnset {
  time: number
  strength: number
  hit: boolean
}

export class BeatTracker {
  private periodS: number | null = null
  /** Time of some beat on the grid; null until phase is known. */
  private beatS: number | null = null
  private readonly recent: RecentOnset[] = []
  /** Smoothed flux of on-grid hits (0 until known). */
  private typicalHitFlux = 0
  private lastHitS = -Infinity
  private lastOnsetS = -Infinity
  /** On-grid hits with their beat number, for a least-squares period fit. */
  private hits: { t: number; k: number }[] = []
  /** Changes whenever the grid moves, so consumers can tell when to re-read it. */
  version = 0

  get period(): number | null {
    return this.periodS
  }

  get beatTime(): number | null {
    return this.beatS
  }

  /** Fraction of recent onsets that landed on the grid. */
  get hitRate(): number {
    if (this.recent.length === 0) return 0
    return this.recent.filter((o) => o.hit).length / this.recent.length
  }

  /**
   * True when recent onsets confirm the grid: some land on it and not so few that the
   * tracker would re-acquire. (Syncopated styles put many kicks off the beat on purpose.)
   */
  get inPhase(): boolean {
    const hits = this.recent.filter((o) => o.hit).length
    return this.beatS !== null && hits >= 2 && this.hitRate >= REACQUIRE_HIT_RATE
  }

  /** Change the tempo. The beat nearest `aroundS` stays where it is. */
  setPeriod(periodS: number, aroundS?: number): void {
    if (this.periodS === periodS) return
    // A real tempo change means a new track: forget how strong the old track's hits were.
    if (this.periodS !== null && Math.abs(periodS - this.periodS) / this.periodS > 0.02) {
      this.typicalHitFlux = 0
      this.hits = []
    }
    if (this.beatS !== null && this.periodS !== null && aroundS !== undefined) {
      this.beatS = this.nearestBeat(aroundS)
    }
    this.periodS = periodS
    this.version++
  }

  /** Put a beat exactly at `timeS` (tap, resync). */
  setBeatAt(timeS: number): void {
    this.beatS = timeS
    this.recent.length = 0
    this.hits = []
    this.version++
  }

  /** Move the grid by `deltaS` (positive = later). */
  shift(deltaS: number): void {
    if (this.beatS === null) return
    this.beatS += deltaS
    this.version++
  }

  /** The grid beat closest to `timeS`. */
  nearestBeat(timeS: number): number {
    if (this.beatS === null || this.periodS === null) return timeS
    const k = Math.round((timeS - this.beatS) / this.periodS)
    return this.beatS + k * this.periodS
  }

  /**
   * Feed a detected onset. With `correct` false the grid never moves (phase correction off),
   * but hit statistics are still kept.
   */
  onOnset(timeS: number, strength: number, correct = true, flux = strength): void {
    const p = this.periodS
    if (p === null) return
    while (this.recent.length > 0 && timeS - this.recent[0]!.time > HISTORY_SECONDS)
      this.recent.shift()
    if (timeS - this.lastHitS > TYPICAL_DECAY_AFTER_S && this.lastOnsetS > -Infinity) {
      this.typicalHitFlux *= Math.exp(-Math.max(0, timeS - this.lastOnsetS) / TYPICAL_DECAY_TAU_S)
    }
    this.lastOnsetS = timeS

    if (this.beatS === null) {
      this.recent.push({ time: timeS, strength, hit: false })
      if (correct && this.recent.length >= MIN_ONSETS_TO_ACQUIRE) this.acquire()
      return
    }

    const error = timeS - this.nearestBeat(timeS)
    const hit = Math.abs(error) <= HIT_WINDOW * p
    if (hit) {
      this.lastHitS = timeS
      this.typicalHitFlux =
        this.typicalHitFlux === 0 ? flux : this.typicalHitFlux * 0.8 + flux * 0.2
      const prev = this.hits[this.hits.length - 1]
      const k = prev ? prev.k + Math.round((timeS - prev.t) / p) : 0
      if (!prev || k > prev.k) this.hits.push({ t: timeS, k })
      while (this.hits.length > 0 && timeS - this.hits[0]!.t > PERIOD_FIT_SECONDS) this.hits.shift()
    } else if (flux < WEAK_ONSET_FRACTION * this.typicalHitFlux) {
      return
    }
    this.recent.push({ time: timeS, strength, hit })
    if (this.recent.length > HISTORY) this.recent.shift()
    if (!correct) return

    if (hit) {
      this.beatS += PHASE_GAIN * error
      this.version++
    } else if (this.recent.length >= MIN_ONSETS_TO_ACQUIRE && this.hitRate < REACQUIRE_HIT_RATE) {
      this.acquire()
    }
  }

  /**
   * The beat period measured from recent on-grid hits (least-squares slope of hit time vs
   * beat number), or null without enough evidence. Far more precise than autocorrelation.
   */
  get measuredPeriod(): number | null {
    const h = this.hits
    if (h.length < PERIOD_FIT_MIN_HITS || h[h.length - 1]!.t - h[0]!.t < PERIOD_FIT_MIN_SPAN_S)
      return null
    const n = h.length
    const mk = h.reduce((a, x) => a + x.k, 0) / n
    const mt = h.reduce((a, x) => a + x.t, 0) / n
    let num = 0
    let den = 0
    for (const x of h) {
      num += (x.k - mk) * (x.t - mt)
      den += (x.k - mk) ** 2
    }
    return den > 0 ? num / den : null
  }

  /** Set the phase to the strength-weighted circular mean of recent onsets, if consistent. */
  private acquire(): void {
    const p = this.periodS
    if (p === null || this.recent.length < MIN_ONSETS_TO_ACQUIRE) return
    let x = 0
    let y = 0
    let w = 0
    for (const o of this.recent) {
      const angle = (2 * Math.PI * (o.time % p)) / p
      x += o.strength * Math.cos(angle)
      y += o.strength * Math.sin(angle)
      w += o.strength
    }
    if (w <= 0 || Math.hypot(x, y) / w < REACQUIRE_CONSISTENCY) return
    let phase = (Math.atan2(y, x) / (2 * Math.PI)) * p
    if (phase < 0) phase += p
    const last = this.recent[this.recent.length - 1]!.time
    this.beatS = last - ((((last - phase) % p) + p) % p)
    for (const o of this.recent)
      o.hit = Math.abs(o.time - this.nearestBeat(o.time)) <= HIT_WINDOW * p
    this.typicalHitFlux = 0
    this.hits = []
    this.version++
  }

  reset(): void {
    this.periodS = null
    this.beatS = null
    this.recent.length = 0
    this.typicalHitFlux = 0
    this.hits = []
    this.version++
  }

  /** Forget phase and onset history but keep the tempo (e.g. after switching inputs). */
  resetPhase(): void {
    this.beatS = null
    this.recent.length = 0
    this.typicalHitFlux = 0
    this.hits = []
    this.version++
  }
}
