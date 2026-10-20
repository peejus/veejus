import { describe, expect, it } from 'vitest'
import { DEFAULT_ANALYSIS_SETTINGS } from '@shared/audio'
import { DEFAULT_BEAT_SETTINGS } from '@shared/beat'
import { HOP_SIZE } from '@core/audio/analyzer'
import { analyzeOffline } from '@core/audio/evaluate'
import { PATTERNS, renderPattern, renderSequence, type DrumPattern } from '@core/audio/synth'
import { scoreBeats, simulateBeatTracking } from '@core/beat/simulate'
import { TempoEstimator } from '@core/beat/tempoEstimator'

/**
 * Offline accuracy of tempo detection and beat tracking: synthesized audio goes through the
 * analyzer and beat engine exactly as in the live app, in simulated time.
 */

const click = (bpm: number, bars = 16): DrumPattern => ({
  bpm,
  bars,
  kick: [],
  snare: [],
  hat: [],
  click: [0, 4, 8, 12],
})
const breakdown = (bpm: number, bars: number): DrumPattern => ({
  bpm,
  bars,
  kick: [],
  snare: [],
  hat: [],
  bass: true,
  noiseDb: -50,
})

/** True beat times for a sequence of segments, starting at the first hit. */
function beatGrid(segments: DrumPattern[], firstBeatS: number): number[] {
  const out: number[] = []
  let t = firstBeatS
  for (const s of segments) {
    for (let i = 0; i < s.bars * 4; i++) {
      out.push(t)
      t += 60 / s.bpm
    }
  }
  return out
}

function track(segments: DrumPattern[]) {
  const r = renderSequence(segments)
  const first = Math.min(r.truth.kick[0] ?? Infinity, r.truth.click[0] ?? Infinity)
  const sim = simulateBeatTracking(r.samples, r.sampleRate)
  return { r, sim, beats: beatGrid(segments, first) }
}

const bpmAt = (trace: [number, number][], s: number) => trace.find(([t]) => t >= s)![1]

describe('TempoEstimator (acceptance: within +-0.5 BPM by 8 s, no octave errors)', () => {
  for (const bpm of [90, 120, 128, 140, 174]) {
    it(`click track at ${bpm} BPM`, () => {
      const r = renderPattern(click(bpm, 6))
      const a = analyzeOffline(r.samples, r.sampleRate, DEFAULT_ANALYSIS_SETTINGS)
      const est = new TempoEstimator(HOP_SIZE / r.sampleRate)
      let last = null
      const hops8s = Math.round(8 / (HOP_SIZE / r.sampleRate))
      for (let i = 0; i < Math.min(hops8s, a.flux.low.length); i++) {
        last = est.push(a.flux.low[i]! + a.flux.high[i]!) ?? last
      }
      expect(last).not.toBeNull()
      expect(Math.abs(last!.bpm - bpm)).toBeLessThanOrEqual(0.5)
      expect(last!.confidence).toBeGreaterThan(0.8)
    })
  }

  it('folds tempos into the configured range', () => {
    const r = renderPattern(click(174, 6))
    const a = analyzeOffline(r.samples, r.sampleRate, DEFAULT_ANALYSIS_SETTINGS)
    const est = new TempoEstimator(HOP_SIZE / r.sampleRate)
    est.setRange(60, 120)
    let last = null
    for (let i = 0; i < a.flux.low.length; i++)
      last = est.push(a.flux.low[i]! + a.flux.high[i]!) ?? last
    expect(Math.abs(last!.bpm - 87)).toBeLessThanOrEqual(0.5)
  })

  it('reports low confidence for noise', () => {
    const r = renderPattern({ bpm: 120, bars: 8, kick: [], snare: [], hat: [], noiseDb: -20 })
    const a = analyzeOffline(r.samples, r.sampleRate, DEFAULT_ANALYSIS_SETTINGS)
    const est = new TempoEstimator(HOP_SIZE / r.sampleRate)
    const confidences: number[] = []
    for (let i = 0; i < a.flux.low.length; i++) {
      const e = est.push(a.flux.low[i]! + a.flux.high[i]!)
      if (e) confidences.push(e.confidence)
    }
    expect(Math.max(...confidences)).toBeLessThan(0.4)
  })
})

describe('beat tracking end to end (beats within +-15 ms after 8 s)', () => {
  const cases: [string, DrumPattern[]][] = [
    ...[90, 120, 128, 140, 174].map(
      (bpm) => [`click ${bpm}`, [click(bpm)]] as [string, DrumPattern[]],
    ),
    ['house 124', [PATTERNS.house]],
    ['techno 132', [PATTERNS.techno]],
    ['drum & bass 174 (offbeat kicks)', [PATTERNS.dnb]],
  ]
  for (const [name, segments] of cases) {
    it(name, () => {
      const { sim, beats } = track(segments)
      expect(Math.abs(bpmAt(sim.bpmTrace, 8) - segments[0]!.bpm)).toBeLessThanOrEqual(0.5)
      const score = scoreBeats(sim, beats, 8)
      expect(score.recall).toBeGreaterThanOrEqual(0.95)
      expect(score.worstErrorMs).toBeLessThanOrEqual(15)
      expect(sim.engine.state(sim.beats.at(-1)!.atMs).inPhase).toBe(true)
    })
  }

  it('stays locked for 3 minutes of house', () => {
    const { sim, beats } = track([{ ...PATTERNS.house, bars: 92 }])
    const score = scoreBeats(sim, beats, 8)
    expect(score.recall).toBeGreaterThanOrEqual(0.99)
    expect(score.extraBeats).toBeLessThanOrEqual(3)
    expect(score.worstErrorMs).toBeLessThanOrEqual(15)
  })

  for (const bars of [8, 32]) {
    it(`keeps the grid through a ${bars}-bar breakdown with an offbeat bassline`, () => {
      const segments = [
        { ...PATTERNS.house, bars: 16 },
        breakdown(124, bars),
        { ...PATTERNS.house, bars: 16 },
      ]
      const { sim, beats } = track(segments)
      const score = scoreBeats(sim, beats, 8)
      expect(score.recall).toBeGreaterThanOrEqual(0.98)
    })
  }

  it('measures the tempo precisely once beats lock (128 BPM within 0.05)', () => {
    const { sim } = track([{ ...PATTERNS.house, bpm: 128, bars: 24 }])
    expect(Math.abs(bpmAt(sim.bpmTrace, 20) - 128)).toBeLessThanOrEqual(0.05)
  })

  it('freewheels through a 32-bar breakdown at 128 BPM without drifting off the grid', () => {
    const segments = [
      { ...PATTERNS.house, bpm: 128, bars: 16 },
      breakdown(128, 32),
      { ...PATTERNS.house, bpm: 128, bars: 8 },
    ]
    const { r, sim, beats } = track(segments)
    // The last beats of the breakdown, before any kick can correct the grid.
    const dropS = r.truth.kick[64]!
    const lateBreakdown = beats.filter((t) => t > dropS - 4 && t < dropS - 0.1)
    const events = sim.beats.map((b) => (b.atMs - sim.startMs) / 1000)
    for (const t of lateBreakdown) {
      const nearest = events.reduce((a, e) => (Math.abs(e - t) < Math.abs(a - t) ? e : a))
      expect(Math.abs(nearest - t) * 1000).toBeLessThanOrEqual(15)
    }
  })

  it('follows a tempo change (120 -> 128) within 10 seconds', () => {
    const segments = [
      { ...PATTERNS.house, bpm: 120, bars: 16 },
      { ...PATTERNS.house, bpm: 128, bars: 24 },
    ]
    const { r, sim, beats } = track(segments)
    const changeAt = r.truth.kick[64]!
    expect(Math.abs(bpmAt(sim.bpmTrace, changeAt + 10) - 128)).toBeLessThanOrEqual(0.5)
    const after = scoreBeats(sim, beats, changeAt + 10)
    expect(after.recall).toBeGreaterThanOrEqual(0.95)
  })

  it('beat events are strictly increasing and never duplicated', () => {
    const { sim } = track([
      { ...PATTERNS.house, bpm: 120, bars: 16 },
      { ...PATTERNS.house, bpm: 128, bars: 16 },
    ])
    for (let i = 1; i < sim.beats.length; i++) {
      expect(sim.beats[i]!.beatIndex).toBe(sim.beats[i - 1]!.beatIndex + 1)
      expect(sim.beats[i]!.atMs).toBeGreaterThan(sim.beats[i - 1]!.atMs)
    }
  })

  it('with phase correction off, the grid does not follow the audio', () => {
    const r = renderPattern(PATTERNS.house)
    const sim = simulateBeatTracking(r.samples, r.sampleRate, {
      beat: {
        ...DEFAULT_BEAT_SETTINGS,
        tempoMode: 'locked',
        lockedBpm: 124,
        phaseCorrection: false,
      },
    })
    const beats = beatGrid([PATTERNS.house], r.truth.kick[0]!)
    // Tempo is right but the free-running phase is wherever it started: not aligned.
    expect(scoreBeats(sim, beats, 8).recall).toBeLessThan(0.5)
    const corrected = simulateBeatTracking(r.samples, r.sampleRate, {
      beat: {
        ...DEFAULT_BEAT_SETTINGS,
        tempoMode: 'locked',
        lockedBpm: 124,
        phaseCorrection: true,
      },
    })
    expect(scoreBeats(corrected, beats, 8).recall).toBeGreaterThanOrEqual(0.95)
  })
})
