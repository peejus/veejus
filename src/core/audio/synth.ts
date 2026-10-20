/**
 * Deterministic drum-machine synth for tests, fixtures and the built-in test beat.
 * Renders a pattern to mono samples and returns the exact hit times as ground truth.
 */

export interface DrumPattern {
  bpm: number
  bars: number
  /** Step indices (0-15, sixteenth notes) in each bar. */
  kick: number[]
  snare: number[]
  hat: number[]
  /** Add an offbeat bassline (the usual source of false kick detections). */
  bass?: boolean
  /** Constant white-noise floor, dBFS. Omit for none. */
  noiseDb?: number
  /** Overall level, dB. */
  gainDb?: number
  /** Leading silence before the first bar, seconds. */
  leadIn?: number
  seed?: number
}

export interface RenderedPattern {
  samples: Float32Array
  sampleRate: number
  durationS: number
  truth: { kick: number[]; snare: number[]; hat: number[] }
}

export const PATTERNS = {
  /** Kick on every beat, nothing else. */
  kickOnly: { bpm: 120, bars: 16, kick: [0, 4, 8, 12], snare: [], hat: [] },
  /** House: four-on-the-floor kick, offbeat hats, clap on 2 and 4, offbeat bass. */
  house: {
    bpm: 124,
    bars: 16,
    kick: [0, 4, 8, 12],
    snare: [4, 12],
    hat: [2, 6, 10, 14],
    bass: true,
    noiseDb: -60,
  },
  /** Techno with sixteenth hats. */
  techno: {
    bpm: 132,
    bars: 16,
    kick: [0, 4, 8, 12],
    snare: [4, 12],
    hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    noiseDb: -55,
  },
  /** Drum & bass two-step: kicks on 1 and the "and" of 3, snares on 2 and 4. */
  dnb: { bpm: 174, bars: 24, kick: [0, 10], snare: [4, 12], hat: [2, 6, 10, 14], bass: true },
} satisfies Record<string, DrumPattern>

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BASS_NOTES_HZ = [55, 55, 73.42, 65.41]

/** Linear fade over the last `fadeS` seconds of a voice, so voices never end with a click. */
const tailFade = (t: number, lengthS: number, fadeS = 0.03) =>
  Math.min(1, Math.max(0, (lengthS - t) / fadeS))

export function renderPattern(p: DrumPattern, sampleRate = 48000): RenderedPattern {
  const rand = mulberry32(p.seed ?? 1)
  const noise = () => rand() * 2 - 1
  const stepS = 60 / p.bpm / 4
  const leadIn = p.leadIn ?? 0.25
  const durationS = leadIn + p.bars * 16 * stepS + 0.5
  const out = new Float32Array(Math.ceil(durationS * sampleRate))
  const truth = { kick: [] as number[], snare: [] as number[], hat: [] as number[] }

  const addKick = (start: number) => {
    const lengthS = 0.45
    const n = Math.round(lengthS * sampleRate)
    let phase = 0
    for (let i = 0; i < n && start + i < out.length; i++) {
      const t = i / sampleRate
      const f = 45 + 105 * Math.exp(-t / 0.03)
      phase += (2 * Math.PI * f) / sampleRate
      const amp = 0.8 * Math.exp(-t / 0.18) * Math.min(1, t / 0.001) * tailFade(t, lengthS, 0.1)
      const click = t < 0.004 ? 0.25 * noise() * Math.exp(-t / 0.001) : 0
      out[start + i]! += amp * Math.sin(phase) + click
    }
  }
  const addSnare = (start: number) => {
    const lengthS = 0.3
    const n = Math.round(lengthS * sampleRate)
    for (let i = 0; i < n && start + i < out.length; i++) {
      const t = i / sampleRate
      const tone = 0.3 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.05)
      const body = 0.35 * noise() * Math.exp(-t / 0.09)
      out[start + i]! += (tone + body) * Math.min(1, t / 0.0005) * tailFade(t, lengthS, 0.1)
    }
  }
  const addHat = (start: number) => {
    const lengthS = 0.08
    const n = Math.round(lengthS * sampleRate)
    let prev = 0
    for (let i = 0; i < n && start + i < out.length; i++) {
      const t = i / sampleRate
      const x = noise()
      // First difference = simple high-pass, so the hat sits in the top octaves.
      out[start + i]! += 0.18 * (x - prev) * Math.exp(-t / 0.02) * tailFade(t, lengthS)
      prev = x
    }
  }
  const addBass = (start: number, freq: number, lengthS: number) => {
    // Band-limited saw (first 8 harmonics), so it doesn't alias into the hi-hat range.
    const n = Math.round(lengthS * sampleRate)
    for (let i = 0; i < n && start + i < out.length; i++) {
      const t = i / sampleRate
      let saw = 0
      for (let h = 1; h <= 8; h++) saw += Math.sin(2 * Math.PI * freq * h * t) / h
      const env = Math.min(1, t / 0.012) * Math.min(1, (lengthS - t) / 0.02)
      out[start + i]! += 0.16 * saw * env
    }
  }

  for (let bar = 0; bar < p.bars; bar++) {
    for (let step = 0; step < 16; step++) {
      const t = leadIn + (bar * 16 + step) * stepS
      const s = Math.round(t * sampleRate)
      const at = s / sampleRate
      if (p.kick.includes(step)) {
        addKick(s)
        truth.kick.push(at)
      }
      if (p.snare.includes(step)) {
        addSnare(s)
        truth.snare.push(at)
      }
      if (p.hat.includes(step)) {
        addHat(s)
        truth.hat.push(at)
      }
      if (p.bass && step % 4 === 2) {
        addBass(s, BASS_NOTES_HZ[(bar + step) % BASS_NOTES_HZ.length]!, stepS * 1.8)
      }
    }
  }

  if (p.noiseDb !== undefined) {
    const a = Math.pow(10, p.noiseDb / 20)
    for (let i = 0; i < out.length; i++) out[i]! += a * noise()
  }
  const g = Math.pow(10, (p.gainDb ?? 0) / 20)
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i]! * g)

  return { samples: out, sampleRate, durationS, truth }
}
