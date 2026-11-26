import { describe, expect, it } from 'vitest'
import { BeatClock } from '@core/beat/beatClock'
import {
  effectIsActive,
  envelopeShape,
  lastTrigger,
  lfoValue,
  modulatorOutput,
  resolveChain,
  stepRandom,
  waveform,
  type ModContext,
} from '@core/modulation/modulation'
import {
  EFFECT_TYPES,
  MAX_EFFECTS,
  LFO_PERIODS,
  LFO_SHAPES,
  PRESET_IDS,
  defaultParams,
  emptyFxConfig,
  isFxChain,
  isFxConfig,
  isModulator,
  presetItems,
  targetSpec,
  type FxChain,
  type Modulator,
} from '@shared/fx'
import { isControlToOutput, isOutputToControl } from '@shared/protocol'

const FRAME = 1000 / 60

const ctx = (pos: number, over: Partial<ModContext> = {}): ModContext => ({
  pos,
  barOffset: 0,
  phraseBeats: 32,
  lastKickPos: null,
  lastHighPos: null,
  bands: [0, 0, 0, 0],
  ...over,
})

const mod = (over: Partial<Modulator> = {}): Modulator => ({
  id: 'm1',
  enabled: true,
  target: 'opacity',
  source: { kind: 'lfo', shape: 'sine', periodBeats: 4, phase: 0 },
  amount: 1,
  min: 0,
  max: 1,
  invert: false,
  ...over,
})

describe('LFO waveforms', () => {
  it('have the expected shape over one cycle', () => {
    expect(waveform('sine', 0)).toBeCloseTo(0)
    expect(waveform('sine', 0.25)).toBeCloseTo(0.5)
    expect(waveform('sine', 0.5)).toBeCloseTo(1)
    expect(waveform('triangle', 0.25)).toBeCloseTo(0.5)
    expect(waveform('triangle', 0.5)).toBeCloseTo(1)
    expect(waveform('triangle', 0.75)).toBeCloseTo(0.5)
    expect(waveform('saw', 0.3)).toBeCloseTo(0.3)
    expect(waveform('square', 0.2)).toBe(1)
    expect(waveform('square', 0.7)).toBe(0)
  })

  it('stay within 0..1 for every shape and phase', () => {
    for (const shape of LFO_SHAPES) {
      for (let i = 0; i <= 200; i++) {
        const v = lfoValue(shape, 1.5, 0.3, i * 0.137)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })

  it('complete exactly one cycle per period, for every musical period', () => {
    for (const { beats } of LFO_PERIODS) {
      for (let k = 0; k < 4; k++) {
        // Same value one period apart; the peak sits half a period in.
        const at = 0.37 * beats + k * beats
        expect(lfoValue('sine', beats, 0, at)).toBeCloseTo(
          lfoValue('sine', beats, 0, at + beats),
          9,
        )
        expect(lfoValue('sine', beats, 0, k * beats)).toBeCloseTo(0, 9)
        expect(lfoValue('sine', beats, 0, k * beats + beats / 2)).toBeCloseTo(1, 9)
      }
    }
  })

  it('align to the bar grid and honor the phase offset', () => {
    // With the downbeat moved by 1 beat, a 1-bar LFO restarts on beat 3, 7, ...
    expect(lfoValue('saw', 4, 0, 3, 1)).toBeCloseTo(0)
    expect(lfoValue('saw', 4, 0, 5, 1)).toBeCloseTo(0.5)
    expect(lfoValue('saw', 4, 0.25, 3, 1)).toBeCloseTo(0.25)
  })

  it('random-step holds one value per period and changes between periods', () => {
    const a = lfoValue('random', 1, 0, 2.1)
    expect(lfoValue('random', 1, 0, 2.9)).toBe(a)
    const distinct = new Set(Array.from({ length: 32 }, (_, i) => stepRandom(i)))
    expect(distinct.size).toBe(32)
    for (const v of distinct) expect(v).toBeGreaterThanOrEqual(0)
  })

  it('stay phase-continuous through tempo changes (no jumps)', () => {
    const clock = new BeatClock(0, 120)
    const values: number[] = []
    const positions: number[] = []
    let t = 0
    const steps: [number, number][] = [
      [3000, 120],
      [3000, 174],
      [3000, 90],
      [3000, 128],
    ]
    for (const [dur, bpm] of steps) {
      clock.setTempo(60000 / bpm, t)
      for (const end = t + dur; t < end; t += FRAME) {
        clock.update(t)
        const pos = clock.position(t)
        positions.push(pos)
        values.push(lfoValue('sine', 0.25, 0, pos))
      }
    }
    // Position only moves forward; at the fastest rate (174 BPM, +50% steering) one frame is
    // < 0.15 beats, so a 1/16 sine (0.25 beat) can move at most sin-slope * that.
    let maxStep = 0
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]!).toBeGreaterThanOrEqual(positions[i - 1]!)
      maxStep = Math.max(maxStep, positions[i]! - positions[i - 1]!)
    }
    expect(maxStep).toBeLessThan(0.13)
    // The value change per frame never exceeds what the waveform slope allows.
    const slope = Math.PI / 0.25 // max |d sine01/d pos| for a 0.25-beat period
    for (let i = 1; i < values.length; i++) {
      const dPos = positions[i]! - positions[i - 1]!
      expect(Math.abs(values[i]! - values[i - 1]!)).toBeLessThanOrEqual(slope * dPos + 1e-9)
    }
  })

  it('a 1-bar LFO runs exactly one cycle per bar at any tempo', () => {
    for (const bpm of [90, 128, 174]) {
      const clock = new BeatClock(0, bpm)
      const barMs = (4 * 60000) / bpm
      // Let it settle, then sample one bar at 1 ms.
      for (let t = 0; t < 2000; t += FRAME) clock.update(t)
      const start = clock.boundaryAfter(clock.position(2000), 'bar')
      const startMs = 2000 + (start - clock.position(2000)) / clock.beatsPerMs
      let peaks = 0
      let prev = lfoValue('sine', 4, 0, clock.position(startMs))
      expect(prev).toBeCloseTo(0, 3)
      for (let ms = 1; ms <= barMs; ms++) {
        const v = lfoValue('sine', 4, 0, clock.position(startMs + ms))
        if (prev < 0.5 && v >= 0.5) peaks++
        prev = v
      }
      expect(peaks).toBe(1)
      expect(lfoValue('sine', 4, 0, clock.position(startMs + barMs))).toBeCloseTo(0, 3)
    }
  })
})

describe('beat envelopes', () => {
  it('rise over the attack and fall to zero over the decay', () => {
    expect(envelopeShape(-0.1, 0, 1)).toBe(0)
    expect(envelopeShape(0, 0, 1)).toBe(1)
    expect(envelopeShape(0.5, 0, 1)).toBeCloseTo(0.25)
    expect(envelopeShape(1, 0, 1)).toBe(0)
    expect(envelopeShape(0.05, 0.1, 1)).toBeCloseTo(0.5)
    expect(envelopeShape(0.1, 0.1, 1)).toBe(1)
  })

  it('retrigger on beats, backbeats, bars and phrases', () => {
    expect(lastTrigger('beat', ctx(5.3))).toBe(5)
    // Beats are 0-based; beat-in-bar 2 and 4 are positions 1, 3, 5, 7...
    expect(lastTrigger('backbeat', ctx(5.3))).toBe(5)
    expect(lastTrigger('backbeat', ctx(6.3))).toBe(5)
    expect(lastTrigger('backbeat', ctx(7))).toBe(7)
    expect(lastTrigger('bar', ctx(7.9))).toBe(4)
    expect(lastTrigger('bar', ctx(8))).toBe(8)
    expect(lastTrigger('bar', ctx(7.9, { barOffset: 1 }))).toBe(7)
    expect(lastTrigger('phrase', ctx(40))).toBe(32)
    expect(lastTrigger('kick', ctx(4))).toBeNull()
    expect(lastTrigger('kick', ctx(4, { lastKickPos: 3.5 }))).toBe(3.5)
  })

  it('kick envelopes are zero until the first kick, then decay from it', () => {
    const m = mod({
      source: { kind: 'envelope', trigger: 'kick', attackBeats: 0, decayBeats: 0.5 },
    })
    expect(modulatorOutput(m, ctx(3))).toBe(0)
    expect(modulatorOutput(m, ctx(3, { lastKickPos: 3 }))).toBe(1)
    expect(modulatorOutput(m, ctx(3.25, { lastKickPos: 3 }))).toBeCloseTo(0.25)
    expect(modulatorOutput(m, ctx(3.6, { lastKickPos: 3 }))).toBe(0)
  })
})

describe('modulators', () => {
  it('map the source onto min..max, scaled by amount, optionally inverted', () => {
    const src = { kind: 'lfo', shape: 'saw', periodBeats: 1, phase: 0 } as const
    expect(modulatorOutput(mod({ source: src, min: -1, max: 0 }), ctx(0.25))).toBeCloseTo(-0.75)
    expect(modulatorOutput(mod({ source: src, amount: 0.5 }), ctx(0.5))).toBeCloseTo(0.25)
    expect(modulatorOutput(mod({ source: src, invert: true }), ctx(0.25))).toBeCloseTo(0.75)
  })

  it('read audio bands with gain, clamped', () => {
    const m = mod({ source: { kind: 'audio', band: 0, gain: 2 } })
    expect(modulatorOutput(m, ctx(0, { bands: [0.3, 0, 0, 0] }))).toBeCloseTo(0.6)
    expect(modulatorOutput(m, ctx(0, { bands: [0.9, 0, 0, 0] }))).toBe(1)
  })

  it('sum onto chain parameters and effect parameters, clamped to their ranges', () => {
    const chain: FxChain = {
      effects: [
        { id: 'fx1', type: 'pixelate', enabled: true, params: { amount: 4 } },
        { id: 'fx2', type: 'invert', enabled: false, params: { amount: 1 } },
      ],
      mods: [
        mod({
          target: 'scale',
          source: { kind: 'lfo', shape: 'square', periodBeats: 1, phase: 0 },
          max: 0.1,
        }),
        mod({
          id: 'm2',
          target: 'scale',
          source: { kind: 'lfo', shape: 'square', periodBeats: 1, phase: 0 },
          max: 0.05,
        }),
        mod({ id: 'm3', target: 'fx1.amount', min: 500, max: 500 }),
        mod({ id: 'm4', target: 'missing.amount' }),
        mod({ id: 'm5', target: 'rotation', enabled: false, min: 90, max: 90 }),
      ],
    }
    const r = resolveChain(chain, ctx(0.1))
    expect(r.scale).toBeCloseTo(0.15)
    expect(r.rotation).toBe(0)
    expect(r.effects.map((e) => e.id)).toEqual(['fx1'])
    expect(r.effects[0]!.params.amount).toBe(128)
    // The stored chain is untouched.
    expect(chain.effects[0]!.params.amount).toBe(4)
  })

  it('skip effects that do nothing at their current values', () => {
    expect(
      effectIsActive({
        id: 'a',
        type: 'strobe',
        params: { ...defaultParams('strobe'), amount: 0 },
      }),
    ).toBe(false)
    expect(effectIsActive({ id: 'a', type: 'pixelate', params: { amount: 1 } })).toBe(false)
    expect(effectIsActive({ id: 'a', type: 'hueRotate', params: { amount: 360 } })).toBe(false)
    expect(effectIsActive({ id: 'a', type: 'feedback', params: defaultParams('feedback') })).toBe(
      true,
    )
  })
})

describe('presets', () => {
  it('Kick Bump scales +10% right on a kick and settles back', () => {
    const chain = presetItems('kickBump', 'p1')
    expect(isFxChain(chain)).toBe(true)
    expect(resolveChain(chain, ctx(8, { lastKickPos: 8 })).scale).toBeCloseTo(0.1)
    expect(resolveChain(chain, ctx(8.6, { lastKickPos: 8 })).scale).toBe(0)
  })

  it('Snare Strobe flashes on beats 2 and 4 only', () => {
    const chain = presetItems('snareStrobe', 'p2')
    const amount = (pos: number) => resolveChain(chain, ctx(pos)).effects[0]!.params.amount!
    expect(amount(1)).toBeCloseTo(0.8)
    expect(amount(3)).toBeCloseTo(0.8)
    expect(amount(2)).toBe(0)
    expect(amount(4)).toBe(0)
  })

  it('Drop Flash fires a flash and a zoom on the phrase start', () => {
    const chain = presetItems('dropFlash', 'p3')
    const at = resolveChain(chain, ctx(32))
    expect(at.effects.find((e) => e.type === 'strobe')!.params.amount).toBe(1)
    expect(at.effects.find((e) => e.type === 'zoomBump')!.params.amount).toBeCloseTo(0.25)
    const later = resolveChain(chain, ctx(36))
    expect(later.effects.every((e) => !effectIsActive(e))).toBe(true)
  })

  it('every preset is a valid chain whose modulators point at real targets', () => {
    for (const id of PRESET_IDS) {
      const chain = presetItems(id, 'x')
      expect(isFxChain(chain)).toBe(true)
      for (const m of chain.mods) expect(targetSpec(chain, m.target)).not.toBeNull()
    }
  })
})

describe('fx guards', () => {
  it('accept defaults for every effect and reject out-of-range values', () => {
    const cfg = emptyFxConfig()
    for (const [i, type] of EFFECT_TYPES.entries()) {
      // Two chains: there are more effect types than one chain may hold.
      const scope = i < MAX_EFFECTS ? 'overlayA' : 'overlayB'
      cfg[scope].effects.push({ id: `e${i}`, type, enabled: true, params: defaultParams(type) })
    }
    expect(isFxConfig(cfg)).toBe(true)
    expect(isControlToOutput({ type: 'setFx', config: cfg })).toBe(true)
    cfg.overlayA.effects[0]!.params.amount = 5
    expect(isFxConfig(cfg)).toBe(false)
    expect(isModulator(mod({ amount: 2 }))).toBe(false)
    expect(
      isModulator(mod({ source: { kind: 'lfo', shape: 'sine', periodBeats: 0, phase: 0 } })),
    ).toBe(false)
    expect(isModulator(mod({ id: 'bad id!' }))).toBe(false)
  })
})

describe('fxLive message', () => {
  it('accepts per-scope numeric values and rejects anything else', () => {
    const ok = {
      type: 'fxLive',
      values: { overlayA: { opacity: 0.4, 'e1.amount': 3 }, master: {} },
    }
    expect(isOutputToControl(ok)).toBe(true)
    expect(isOutputToControl({ type: 'fxLive', values: {} })).toBe(true)
    expect(isOutputToControl({ type: 'fxLive', values: { nope: { opacity: 1 } } })).toBe(false)
    expect(isOutputToControl({ type: 'fxLive', values: { overlayA: { opacity: NaN } } })).toBe(
      false,
    )
    expect(isOutputToControl({ type: 'fxLive', values: { overlayA: { opacity: '1' } } })).toBe(
      false,
    )
  })
})
