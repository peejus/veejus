import {
  DEFAULT_BEAT_SETTINGS,
  MANUAL_BPM_RANGE,
  type BeatCommand,
  type BeatEvent,
  type BeatSettings,
  type BeatState,
} from '@shared/beat'
import type { OnsetBand } from '@shared/audio'
import { BeatClock } from './beatClock'
import { BeatTracker } from './beatTracker'
import { ClockSync } from './clockSync'
import { TapTempo } from './tapTempo'
import { TempoEstimator, type TempoEstimate } from './tempoEstimator'

/**
 * Turns the audio analysis stream into the beat clock, and applies manual control.
 *
 * Audio-side inputs (onset strength, onsets) are in analysis seconds; the clock and every
 * control/query are in performance.now() ms. A ClockSync maps between the two.
 */

/** Estimates below this confidence are ignored (noise, beatless passages). */
const MIN_CONFIDENCE = 0.4
/** Estimates within this fraction of the current tempo refine it smoothly. */
const SAME_TEMPO = 0.02
const SMOOTHING = 0.3
/** A different tempo must be seen this many times in a row to be adopted. */
const CHANGE_CONFIRMATIONS = 3
const CONFIRM_TOLERANCE = 0.015
/** With no kicks for this long, snare/hat onsets steer the phase instead. */
const HIGH_FALLBACK_S = 2
/** The period measured from on-beat hits replaces the estimate when they agree this well. */
const PRECISE_AGREEMENT = 0.01

const clampBpm = (bpm: number) => Math.min(MANUAL_BPM_RANGE[1], Math.max(MANUAL_BPM_RANGE[0], bpm))

export class BeatEngine {
  private settings: BeatSettings
  private estimator: TempoEstimator
  private hopSeconds: number
  private readonly tracker = new BeatTracker()
  private readonly sync = new ClockSync()
  private readonly taps = new TapTempo()
  readonly clock: BeatClock

  /** Smoothed auto tempo (after the multiplier), null until detected. */
  private autoBpm: number | null = null
  private lastEstimate: TempoEstimate | null = null
  private confidence = 0
  private pending: { bpm: number; count: number } | null = null
  /** ×2 / ÷2 applied to detections in auto mode. */
  private multiplier = 1
  /** True once the tempo comes from measured beat spacing rather than an estimate. */
  private precise = false
  private lastLowOnsetS = -Infinity
  private trackerVersionSeen = -1
  /** Latest analysis time seen, for keeping phase around "now" on tempo changes. */
  private latestAnalysisS: number | undefined

  constructor(hopSeconds: number, nowMs: number, settings: BeatSettings = DEFAULT_BEAT_SETTINGS) {
    this.settings = { ...settings }
    this.hopSeconds = hopSeconds
    this.estimator = new TempoEstimator(hopSeconds)
    this.estimator.setRange(settings.minBpm, settings.maxBpm)
    this.clock = new BeatClock(
      nowMs,
      settings.tempoMode === 'locked' ? settings.lockedBpm : 120,
      settings.phraseBars,
    )
    this.clock.setLatencyOffset(settings.latencyOffsetMs, nowMs)
    this.tracker.setPeriod(60 / this.clock.bpm)
  }

  // ---- audio side ---------------------------------------------------------

  /** Pair an analysis time with the performance.now() it arrived at. */
  observeSync(analysisS: number, perfMs: number): void {
    this.sync.observe(analysisS, perfMs)
    this.latestAnalysisS = analysisS
  }

  /** One hop of onset strength (both ranges). */
  pushFlux(low: number, high: number): void {
    const estimate = this.estimator.push(low + high)
    if (estimate) this.onEstimate(estimate)
  }

  pushOnset(band: OnsetBand, timeS: number, strength: number, flux = strength): void {
    if (band === 'low') this.lastLowOnsetS = timeS
    else if (timeS - this.lastLowOnsetS < HIGH_FALLBACK_S) return
    this.tracker.onOnset(timeS, strength, this.settings.phaseCorrection, flux)
  }

  /** The analysis hop length changed (different sample rate). */
  setHopSeconds(hopSeconds: number): void {
    if (hopSeconds === this.hopSeconds) return
    this.hopSeconds = hopSeconds
    this.estimator = new TempoEstimator(hopSeconds)
    this.estimator.setRange(this.settings.minBpm, this.settings.maxBpm)
  }

  get currentSettings(): BeatSettings {
    return { ...this.settings }
  }

  /** The input changed: forget audio history but keep the clock running. */
  resetAudio(): void {
    this.estimator.reset()
    this.tracker.resetPhase()
    this.sync.reset()
    this.pending = null
    this.precise = false
    this.lastEstimate = null
    this.confidence = 0
    this.lastLowOnsetS = -Infinity
    this.latestAnalysisS = undefined
  }

  private onEstimate(e: TempoEstimate): void {
    this.lastEstimate = e
    this.confidence += (e.confidence - this.confidence) * 0.3
    if (e.confidence < MIN_CONFIDENCE) return
    const bpm = clampBpm(e.bpm * this.multiplier)

    if (this.autoBpm === null) {
      this.adoptCandidate(bpm)
      return
    }
    if (Math.abs(bpm - this.autoBpm) / this.autoBpm <= SAME_TEMPO) {
      this.pending = null
      // Once beats land on the grid, their spacing pins the tempo down far more precisely
      // than autocorrelation. Keep that value (e.g. through a breakdown) until a real tempo
      // change is confirmed.
      const measured = this.tracker.measuredPeriod
      if (measured !== null && this.tracker.inPhase) {
        // The tracker runs at the displayed tempo, so this already includes any ×2/÷2.
        const precise = clampBpm(60 / measured)
        if (Math.abs(precise - this.autoBpm) / this.autoBpm <= PRECISE_AGREEMENT) {
          this.autoBpm = precise
          this.precise = true
        }
      } else if (!this.precise) {
        this.autoBpm += (bpm - this.autoBpm) * SMOOTHING
      }
      this.applyTempo()
      return
    }
    this.adoptCandidate(bpm)
  }

  /** Count consistent sightings of a new tempo; switch once confirmed. */
  private adoptCandidate(bpm: number): void {
    const needed = this.autoBpm === null ? 2 : CHANGE_CONFIRMATIONS
    if (this.pending && Math.abs(bpm - this.pending.bpm) / this.pending.bpm <= CONFIRM_TOLERANCE) {
      this.pending.count++
      this.pending.bpm += (bpm - this.pending.bpm) / this.pending.count
    } else {
      this.pending = { bpm, count: 1 }
    }
    if (this.pending.count >= needed) {
      this.autoBpm = this.pending.bpm
      this.precise = false
      this.pending = null
      this.applyTempo()
    }
  }

  // ---- tempo / phase plumbing ----------------------------------------------

  get bpm(): number {
    if (this.settings.tempoMode === 'locked') return this.settings.lockedBpm
    return this.autoBpm ?? this.clock.bpm
  }

  /** Push the current tempo into the tracker (keeping its phase around "now"). */
  private applyTempo(): void {
    this.tracker.setPeriod(60 / this.bpm, this.latestAnalysisS)
  }

  // ---- control --------------------------------------------------------------

  command(cmd: BeatCommand, nowMs: number): void {
    const s = this.settings
    switch (cmd.type) {
      case 'tap': {
        const tap = this.taps.tap(nowMs)
        if (tap.bpm !== null) {
          s.tempoMode = 'locked'
          s.lockedBpm = clampBpm(tap.bpm)
          this.applyTempoAt(nowMs)
        }
        this.placeBeat(tap.beatAtMs, nowMs)
        break
      }
      case 'setBpm':
        s.tempoMode = 'locked'
        s.lockedBpm = clampBpm(cmd.bpm)
        this.applyTempoAt(nowMs)
        break
      case 'lock':
        s.lockedBpm = clampBpm(Math.round(this.bpm * 100) / 100)
        s.tempoMode = 'locked'
        this.applyTempoAt(nowMs)
        break
      case 'auto':
        // Pressing Auto while already in auto clears any ×2/÷2 correction.
        if (s.tempoMode === 'auto') {
          this.multiplier = 1
          if (this.lastEstimate && this.lastEstimate.confidence >= MIN_CONFIDENCE) {
            this.autoBpm = clampBpm(this.lastEstimate.bpm)
          }
        }
        s.tempoMode = 'auto'
        this.pending = null
        this.applyTempoAt(nowMs)
        break
      case 'multiply':
        if (s.tempoMode === 'locked') {
          s.lockedBpm = clampBpm(s.lockedBpm * cmd.factor)
        } else {
          this.multiplier = Math.min(4, Math.max(0.25, this.multiplier * cmd.factor))
          if (this.autoBpm !== null) this.autoBpm = clampBpm(this.autoBpm * cmd.factor)
          this.pending = null
        }
        this.applyTempoAt(nowMs)
        break
      case 'nudge': {
        this.tracker.shift(cmd.ms / 1000)
        const t = this.clock.getTarget()
        this.clock.setTarget({ ...t, beatAtMs: t.beatAtMs + cmd.ms })
        this.trackerVersionSeen = this.tracker.version
        break
      }
      case 'resyncDownbeat':
        this.placeBeat(nowMs, nowMs)
        this.clock.setDownbeatNow(nowMs)
        break
      case 'setPhaseCorrection':
        s.phaseCorrection = cmd.enabled
        break
      case 'setLatencyOffset':
        s.latencyOffsetMs = cmd.ms
        this.clock.setLatencyOffset(cmd.ms, nowMs)
        break
      case 'setPhraseBars':
        s.phraseBars = cmd.bars
        this.clock.phraseBars = cmd.bars
        break
      case 'setTempoRange':
        s.minBpm = cmd.minBpm
        s.maxBpm = cmd.maxBpm
        this.estimator.setRange(cmd.minBpm, cmd.maxBpm)
        this.estimator.reset()
        this.pending = null
        break
    }
  }

  private applyTempoAt(nowMs: number): void {
    const periodMs = 60000 / this.bpm
    this.clock.setTempo(periodMs, nowMs)
    this.tracker.setPeriod(
      periodMs / 1000,
      this.sync.ready ? this.sync.toAnalysis(nowMs) : undefined,
    )
    this.trackerVersionSeen = this.tracker.version
  }

  /** A beat happens (in audio time) at `beatAtMs`: align tracker and snap the clock to it. */
  private placeBeat(beatAtMs: number, nowMs: number): void {
    this.tracker.setBeatAt(this.sync.ready ? this.sync.toAnalysis(beatAtMs) : beatAtMs / 1000)
    this.clock.setTarget({ periodMs: 60000 / this.bpm, beatAtMs })
    this.clock.snap(nowMs)
    this.trackerVersionSeen = this.tracker.version
  }

  // ---- per frame --------------------------------------------------------------

  /** Advance the clock; returns beats crossed since the last call. Call every frame. */
  update(nowMs: number): BeatEvent[] {
    this.taps.expire(nowMs)
    if (this.tracker.version !== this.trackerVersionSeen) {
      this.trackerVersionSeen = this.tracker.version
      const period = this.tracker.period
      const beat = this.tracker.beatTime
      if (period !== null) {
        if (beat !== null && this.sync.ready) {
          this.clock.setTarget({ periodMs: period * 1000, beatAtMs: this.sync.toPerf(beat) })
        } else {
          this.clock.setTempo(period * 1000, nowMs)
        }
      }
    }
    return this.clock.update(nowMs)
  }

  state(nowMs: number): BeatState {
    const snap = this.clock.snapshot(nowMs)
    return {
      bpm: this.bpm,
      detectedBpm: this.lastEstimate ? this.lastEstimate.bpm : null,
      confidence: Math.min(1, Math.max(0, this.confidence)),
      inPhase: this.tracker.inPhase,
      settings: { ...this.settings },
      beatIndex: snap.beatIndex,
      beatPhase: snap.beatPhase,
      beatInBar: snap.beatInBar,
      barIndex: snap.barIndex,
      barInPhrase: snap.barInPhrase,
      phraseIndex: snap.phraseIndex,
      taps: this.taps.count,
    }
  }
}
