import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ANALYSIS_SETTINGS,
  isAnalysisSettings,
  isAudioMeters,
  isAudioSource,
  isAudioStatus,
  type AnalysisSettings,
} from '@shared/audio'
import { AudioAnalyzer, HOP_SIZE, type AnalyzerFrame } from '@core/audio/analyzer'
import { EnvelopeFollower } from '@core/audio/envelope'
import { analyzeOffline, scoreOnsets } from '@core/audio/evaluate'
import { hannWindow, RealFft } from '@core/audio/fft'
import { PATTERNS, renderPattern } from '@core/audio/synth'
import { decodeWav, encodeWav, mixToMono } from '@core/audio/wav'
import { isControlToOutput, isOutputToControl } from '@shared/protocol'

const SR = 48000

function sine(freq: number, seconds: number, amp = 1, sr = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sr))
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr)
  return out
}

function lastFrame(samples: Float32Array, settings: Partial<AnalysisSettings> = {}): AnalyzerFrame {
  const a = new AudioAnalyzer(SR, { ...DEFAULT_ANALYSIS_SETTINGS, ...settings })
  let last: AnalyzerFrame | null = null
  a.process(samples, (f) => {
    last = { ...f, bands: Float32Array.from(f.bands) }
  })
  return last!
}

describe('RealFft', () => {
  it('finds a sine in the right bin with the right magnitude', () => {
    const n = 1024
    const fft = new RealFft(n)
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * 64 * i) / n)
    const mags = new Float32Array(n / 2 + 1)
    fft.magnitudes(input, mags)
    let peak = 0
    for (let k = 1; k <= n / 2; k++) if (mags[k]! > mags[peak]!) peak = k
    expect(peak).toBe(64)
    expect(mags[64]).toBeCloseTo(n / 2, 1)
    expect(mags[10]).toBeLessThan(1e-6)
  })

  it('rejects sizes that are not powers of two', () => {
    expect(() => new RealFft(1000)).toThrow()
  })

  it('Hann window sums to half its length', () => {
    const w = hannWindow(1024)
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(512, 3)
  })
})

describe('EnvelopeFollower', () => {
  it('rises with the attack time and falls with the release time', () => {
    const step = 0.001
    const env = new EnvelopeFollower(step, 10, 100)
    for (let i = 0; i < 10; i++) env.step(1)
    expect(env.current).toBeCloseTo(1 - Math.exp(-1), 2) // one time constant
    for (let i = 0; i < 100; i++) env.step(0)
    expect(env.current).toBeCloseTo((1 - Math.exp(-1)) * Math.exp(-1), 2)
  })

  it('zero time constants follow instantly', () => {
    const env = new EnvelopeFollower(0.005, 0, 0)
    expect(env.step(0.7)).toBe(0.7)
    expect(env.step(0.2)).toBe(0.2)
  })
})

describe('AudioAnalyzer levels', () => {
  it('puts sines in the right band', () => {
    const cases: [number, number][] = [
      [60, 0],
      [400, 1],
      [2000, 2],
      [9000, 3],
    ]
    for (const [freq, band] of cases) {
      const f = lastFrame(sine(freq, 0.5, 0.5))
      const loudest = f.bands.indexOf(Math.max(...f.bands))
      expect(loudest, `${freq} Hz`).toBe(band)
    }
  })

  it('maps a full-scale sine near 1 and -30 dB near 0.5', () => {
    expect(lastFrame(sine(1000, 0.5)).bands[2]).toBeGreaterThan(0.95)
    expect(lastFrame(sine(1000, 0.5, Math.pow(10, -30 / 20))).bands[2]).toBeCloseTo(0.5, 1)
  })

  it('applies per-band gain and moving crossovers', () => {
    const quiet = sine(1000, 0.5, 0.01)
    const plain = lastFrame(quiet).bands[2]!
    const boosted = lastFrame(quiet, { bandGainsDb: [0, 0, 12, 0] }).bands[2]!
    expect(boosted - plain).toBeCloseTo(12 / 60, 1)
    // 1 kHz moves from Mid to Low-mid when the low-mid/mid crossover rises above it.
    const moved = lastFrame(quiet, { crossoversHz: [150, 2000, 6000] })
    expect(moved.bands.indexOf(Math.max(...moved.bands))).toBe(1)
  })

  it('reports RMS and peak after input gain', () => {
    const s = sine(1000, 0.2, 0.5)
    const f = lastFrame(s)
    expect(f.rms).toBeCloseTo(0.5 / Math.SQRT2, 2)
    expect(f.peak).toBeCloseTo(0.5, 2)
    const g = lastFrame(s, { inputGainDb: 6 })
    expect(g.rms / f.rms).toBeCloseTo(2, 1)
  })

  it('emits one frame per hop, timed at the end of the hop', () => {
    const a = new AudioAnalyzer(SR, DEFAULT_ANALYSIS_SETTINGS)
    const times: number[] = []
    a.process(new Float32Array(HOP_SIZE * 10), (f) => times.push(f.time))
    expect(times).toHaveLength(10)
    expect(times[0]).toBeCloseTo(HOP_SIZE / SR, 9)
    expect(times[9]).toBeCloseTo((10 * HOP_SIZE) / SR, 9)
  })

  it('gives identical results whatever the input block size', () => {
    const r = renderPattern({ ...PATTERNS.house, bars: 2 })
    const a = analyzeOffline(r.samples, SR, DEFAULT_ANALYSIS_SETTINGS, 128)
    const b = analyzeOffline(r.samples, SR, DEFAULT_ANALYSIS_SETTINGS, 997)
    const c = analyzeOffline(r.samples, SR, DEFAULT_ANALYSIS_SETTINGS, r.samples.length)
    expect(b.onsets).toEqual(a.onsets)
    expect(c.onsets).toEqual(a.onsets)
    expect(b.bandFrames).toEqual(a.bandFrames)
  })

  it('spectrum puts a sine near its log-frequency position', () => {
    const a = new AudioAnalyzer(SR, DEFAULT_ANALYSIS_SETTINGS)
    a.process(sine(1000, 0.2, 0.5), () => {})
    const spec = new Float32Array(64)
    a.spectrum(spec)
    const peak = spec.indexOf(Math.max(...spec))
    const expected = Math.log(1000 / 30) / Math.log(16000 / 30)
    expect(peak / 64).toBeCloseTo(expected, 1)
    expect(spec[peak]).toBeGreaterThan(0.8)
  })

  it('settings changes apply to a running analyzer', () => {
    const a = new AudioAnalyzer(SR, DEFAULT_ANALYSIS_SETTINGS)
    let rms = 0
    a.process(sine(500, 0.1, 0.25), (f) => (rms = f.rms))
    a.setSettings({ ...DEFAULT_ANALYSIS_SETTINGS, inputGainDb: -6 })
    let rms2 = 0
    a.process(sine(500, 0.1, 0.25), (f) => (rms2 = f.rms))
    expect(rms2 / rms).toBeCloseTo(0.5, 1)
  })
})

describe('scoreOnsets', () => {
  it('matches within tolerance, one detection per truth', () => {
    const s = scoreOnsets([0.1, 0.505, 0.51, 1.2], [0.1, 0.5, 1.0], 0.015)
    expect(s.hits).toBe(2)
    expect(s.misses).toBe(1)
    expect(s.falsePositives).toBe(2)
    expect(s.meanOffsetMs).toBeCloseTo(2.5, 6)
  })
})

describe('WAV', () => {
  it('round-trips 16-bit, 24-bit and float stereo', () => {
    const left = sine(440, 0.05, 0.5)
    const right = sine(880, 0.05, -0.25)
    for (const bits of [16, 24, 32] as const) {
      const decoded = decodeWav(encodeWav([left, right], 44100, bits))
      expect(decoded.sampleRate).toBe(44100)
      expect(decoded.channels).toHaveLength(2)
      const tol = bits === 16 ? 1e-4 : 1e-6
      for (let i = 0; i < left.length; i += 97) {
        expect(Math.abs(decoded.channels[0]![i]! - left[i]!)).toBeLessThan(tol)
        expect(Math.abs(decoded.channels[1]![i]! - right[i]!)).toBeLessThan(tol)
      }
    }
  })

  it('mixes channels to mono and rejects non-WAV data', () => {
    const m = mixToMono([Float32Array.from([1, 0]), Float32Array.from([0, 1])])
    expect([...m]).toEqual([0.5, 0.5])
    expect(() => decodeWav(new TextEncoder().encode('definitely not a wav file'))).toThrow()
  })
})

describe('audio message guards', () => {
  it('validates sources and settings', () => {
    expect(isAudioSource({ kind: 'device', deviceId: 'abc' })).toBe(true)
    expect(isAudioSource({ kind: 'loopback' })).toBe(true)
    expect(isAudioSource({ kind: 'test', bpm: 120 })).toBe(true)
    expect(isAudioSource({ kind: 'test', bpm: 9000 })).toBe(false)
    expect(isAudioSource({ kind: 'file' })).toBe(false)
    expect(isAnalysisSettings(DEFAULT_ANALYSIS_SETTINGS)).toBe(true)
    expect(
      isAnalysisSettings({ ...DEFAULT_ANALYSIS_SETTINGS, crossoversHz: [800, 150, 4000] }),
    ).toBe(false)
    expect(isAnalysisSettings({ ...DEFAULT_ANALYSIS_SETTINGS, kickSensitivity: 2 })).toBe(false)
    expect(isAnalysisSettings({ ...DEFAULT_ANALYSIS_SETTINGS, inputGainDb: 60 })).toBe(false)
  })

  it('validates meters, status and protocol messages', () => {
    const meters = {
      bands: [0.1, 0.2, 0.3, 0.4],
      rms: 0.1,
      peak: 0.5,
      clipped: false,
      spectrum: new Array(64).fill(0),
      latencyMs: 12,
    }
    expect(isAudioMeters(meters)).toBe(true)
    expect(isAudioMeters({ ...meters, bands: [1, 2] })).toBe(false)
    expect(
      isAudioStatus({ state: 'running', source: { kind: 'loopback' }, label: 'System audio' }),
    ).toBe(true)
    expect(isAudioStatus({ state: 'sleeping', source: null })).toBe(false)
    expect(isControlToOutput({ type: 'setAudioSource', source: { kind: 'test', bpm: 120 } })).toBe(
      true,
    )
    expect(isControlToOutput({ type: 'setAudioSource', source: null })).toBe(true)
    expect(
      isControlToOutput({ type: 'setAnalysisSettings', settings: DEFAULT_ANALYSIS_SETTINGS }),
    ).toBe(true)
    expect(isOutputToControl({ type: 'audioOnset', band: 'low', strength: 2 })).toBe(true)
    expect(isOutputToControl({ type: 'audioOnset', band: 'mid', strength: 2 })).toBe(false)
    expect(isOutputToControl({ type: 'audioMeters', meters })).toBe(true)
    expect(
      isOutputToControl({ type: 'audioDevices', devices: [{ deviceId: 'a', label: 'Mic' }] }),
    ).toBe(true)
  })
})
