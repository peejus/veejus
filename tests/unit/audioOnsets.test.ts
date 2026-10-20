import { describe, expect, it } from 'vitest'
import { DEFAULT_ANALYSIS_SETTINGS, type AnalysisSettings } from '@shared/audio'
import { AudioAnalyzer } from '@core/audio/analyzer'
import { analyzeOffline, scoreOnsets } from '@core/audio/evaluate'
import { PATTERNS, renderPattern, type DrumPattern } from '@core/audio/synth'

/**
 * Offline accuracy tests: synthesized drum patterns with known hit times go through the same
 * analyzer the live engine runs, in the same 128-sample blocks.
 */

const TOL_S = 0.015

function run(p: DrumPattern, settings: Partial<AnalysisSettings> = {}, sampleRate = 48000) {
  const r = renderPattern(p, sampleRate)
  const a = analyzeOffline(r.samples, r.sampleRate, { ...DEFAULT_ANALYSIS_SETTINGS, ...settings })
  const highTruth = [...r.truth.snare, ...r.truth.hat, ...r.truth.kick]
    .sort((x, y) => x - y)
    .filter((t, i, arr) => i === 0 || t - arr[i - 1]! > 0.001)
  return {
    r,
    a,
    kick: scoreOnsets(
      a.onsets.low.map((o) => o.time),
      r.truth.kick,
      TOL_S,
    ),
    // A kick's beater click is a real high-frequency transient, so kicks count as high truth.
    high: scoreOnsets(
      a.onsets.high.map((o) => o.time),
      highTruth,
      TOL_S,
    ),
  }
}

describe('kick detection (acceptance: >=95% within +-15 ms, <5% false positives)', () => {
  for (const [name, pattern] of Object.entries(PATTERNS)) {
    it(`${name} at ${pattern.bpm} BPM`, () => {
      const { kick } = run(pattern)
      expect(kick.recall).toBeGreaterThanOrEqual(0.95)
      expect(kick.falsePositiveRate).toBeLessThan(0.05)
      expect(kick.maxAbsOffsetMs).toBeLessThanOrEqual(15)
      // Latency compensation is calibrated: no systematic early/late bias.
      expect(Math.abs(kick.meanOffsetMs)).toBeLessThan(5)
    })
  }

  for (const bpm of [90, 128, 140, 174]) {
    it(`kick every beat at ${bpm} BPM`, () => {
      const { kick } = run({ ...PATTERNS.house, bpm })
      expect(kick.recall).toBeGreaterThanOrEqual(0.95)
      expect(kick.falsePositiveRate).toBeLessThan(0.05)
    })
  }

  it('works at 44.1 kHz', () => {
    const { kick } = run(PATTERNS.house, {}, 44100)
    expect(kick.recall).toBeGreaterThanOrEqual(0.95)
    expect(kick.falsePositiveRate).toBeLessThan(0.05)
    expect(kick.maxAbsOffsetMs).toBeLessThanOrEqual(15)
  })

  it('handles a quiet input (-24 dB) without extra gain', () => {
    const { kick } = run({ ...PATTERNS.house, gainDb: -24 })
    expect(kick.recall).toBeGreaterThanOrEqual(0.95)
    expect(kick.falsePositiveRate).toBeLessThan(0.05)
  })

  it('handles a noisy floor (-35 dBFS white noise)', () => {
    const { kick } = run({ ...PATTERNS.house, noiseDb: -35 })
    expect(kick.recall).toBeGreaterThanOrEqual(0.95)
    expect(kick.falsePositiveRate).toBeLessThan(0.05)
  })
})

describe('level changes', () => {
  it('detects kicks down to about -45 dBFS peaks', () => {
    for (const gainDb of [-36, -42]) {
      const { kick } = run({ ...PATTERNS.house, gainDb })
      expect(kick.recall, `${gainDb} dB`).toBeGreaterThanOrEqual(0.95)
      expect(kick.falsePositiveRate).toBeLessThan(0.05)
    }
  })

  /** Feed `samples`, applying `atTime` changes; returns detected kick times. */
  function kicksWith(
    samples: Float32Array,
    sr: number,
    change: (a: AudioAnalyzer, t: number) => void,
  ) {
    const a = new AudioAnalyzer(sr, DEFAULT_ANALYSIS_SETTINGS)
    const kicks: number[] = []
    for (let i = 0; i < samples.length; i += 128) {
      change(a, i / sr)
      a.process(samples.subarray(i, i + 128), (f) => {
        for (const o of f.onsets) if (o.band === 'low') kicks.push(o.time)
      })
    }
    return kicks
  }

  it('keeps detecting kicks right after a 12 dB fader drop', () => {
    const r = renderPattern(PATTERNS.house)
    const dropAt = 10
    const s = r.samples.slice()
    for (let i = Math.round(dropAt * r.sampleRate); i < s.length; i++) s[i]! *= 0.25
    const kicks = kicksWith(s, r.sampleRate, () => {})
    const window = (t: number) => t > dropAt && t < dropAt + 4
    const score = scoreOnsets(kicks.filter(window), r.truth.kick.filter(window), TOL_S)
    expect(score.recall).toBe(1)
  })

  it('re-learns immediately when the input gain setting changes', () => {
    const r = renderPattern(PATTERNS.house)
    const changeAt = 10
    let changed = false
    const kicks = kicksWith(r.samples, r.sampleRate, (a, t) => {
      if (!changed && t >= changeAt) {
        changed = true
        a.setSettings({ ...DEFAULT_ANALYSIS_SETTINGS, inputGainDb: -24 })
      }
    })
    const window = (t: number) => t > changeAt && t < changeAt + 3
    const score = scoreOnsets(kicks.filter(window), r.truth.kick.filter(window), TOL_S)
    expect(score.recall).toBe(1)
  })
})

describe('high (snare/clap/hat) detection', () => {
  it('house and dnb: >=95% within +-15 ms, <5% false positives', () => {
    for (const p of [PATTERNS.house, PATTERNS.dnb]) {
      const { high } = run(p)
      expect(high.recall).toBeGreaterThanOrEqual(0.95)
      expect(high.falsePositiveRate).toBeLessThan(0.05)
    }
  })

  it('techno sixteenth hats: most hits, except hats masked by a snare tail', () => {
    const { high } = run(PATTERNS.techno)
    expect(high.recall).toBeGreaterThanOrEqual(0.85)
    expect(high.falsePositiveRate).toBeLessThan(0.05)
  })
})

describe('no false triggers without hits', () => {
  it('silence with a faint noise floor produces no onsets', () => {
    const { a } = run({ bpm: 120, bars: 8, kick: [], snare: [], hat: [], noiseDb: -70 })
    expect(a.onsets.low).toHaveLength(0)
    expect(a.onsets.high).toHaveLength(0)
  })

  it('steady loud noise produces almost no onsets', () => {
    const { a, r } = run({ bpm: 120, bars: 8, kick: [], snare: [], hat: [], noiseDb: -20 })
    const perSecond = (a.onsets.low.length + a.onsets.high.length) / r.durationS
    expect(perSecond).toBeLessThan(0.5)
  })
})

describe('sensitivity', () => {
  it('lower sensitivity never detects more than higher sensitivity', () => {
    const counts = [0, 0.5, 1].map((s) => {
      const { a } = run(
        { ...PATTERNS.techno, gainDb: -12 },
        {
          kickSensitivity: s,
          highSensitivity: s,
        },
      )
      return a.onsets.low.length + a.onsets.high.length
    })
    expect(counts[0]!).toBeLessThanOrEqual(counts[1]!)
    expect(counts[1]!).toBeLessThanOrEqual(counts[2]!)
  })
})
