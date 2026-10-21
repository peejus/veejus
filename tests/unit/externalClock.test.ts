import { describe, expect, it } from 'vitest'
import { BeatEngine, type ExternalSample } from '@core/beat/beatEngine'
import { MidiClockFollower, TICKS_PER_BEAT } from '@core/beat/midiClock'
import { TriggerScheduler, type TriggerAction } from '@core/trigger/scheduler'
import { DEFAULT_KEY, DEFAULT_PLACEMENT } from '@shared/layers'
import { isBeatCommand, isBeatState, type BeatEvent } from '@shared/beat'
import type { PadSpec } from '@shared/pads'

const FRAME = 1000 / 60
const HOP = 256 / 48000

/** Deterministic jitter in [-amp, amp]. */
function jitter(seed: number) {
  let x = seed
  return (amp: number) => {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    return ((x / 0x7fffffff) * 2 - 1) * amp
  }
}

/** MIDI clock ticks at `bpm`, Start at `startMs`, ticks every tick period with jitter. */
function feedClock(
  f: MidiClockFollower,
  bpm: number,
  fromMs: number,
  toMs: number,
  startMs: number,
) {
  const tick = 60000 / bpm / TICKS_PER_BEAT
  for (let n = 0; ; n++) {
    const t = startMs + n * tick
    if (t > toMs) break
    if (t < fromMs) continue
    if (n === 0) f.onMessage([0xfa], t - 1) // Start, right before the first tick
    f.onMessage([0xf8], t + jitter(7 + n)(1))
  }
}

describe('MIDI clock follower', () => {
  it('measures tempo through jitter and knows the beat after Start', () => {
    const f = new MidiClockFollower()
    const bpm = 128
    const beatMs = 60000 / bpm
    feedClock(f, bpm, 1000, 4000, 1000)
    const s = f.sample(4000)!
    expect(s.phaseKnown).toBe(true)
    expect(60000 / s.periodMs).toBeCloseTo(bpm, 1)
    // beatAtMs is the true time of beat number `beatNumber` (beat 0 at the Start + first tick).
    expect(Math.abs(s.beatAtMs - (1000 + s.beatNumber! * beatMs))).toBeLessThan(1)
    expect(f.status(4000)).toMatchObject({ ok: true })
  })

  it('without a Start only the tempo is known', () => {
    const f = new MidiClockFollower()
    for (let i = 0; i < 60; i++) f.onMessage([0xf8], i * (500 / 24))
    const s = f.sample(60 * (500 / 24))!
    expect(s.phaseKnown).toBe(false)
    expect(60000 / s.periodMs).toBeCloseTo(120, 3)
    expect(f.status(1250).text).toContain('press play')
  })

  it('Song Position Pointer sets the position (in sixteenths)', () => {
    const f = new MidiClockFollower()
    f.onMessage([0xfa], 0)
    f.onMessage([0xf2, 16, 0], 0) // 16 sixteenths = beat 4 (bar 2)
    for (let i = 0; i < 30; i++) f.onMessage([0xf8], 10 + i * 20)
    // 30 ticks from beat 4 = beat 5 + 6 ticks.
    expect(f.sample(600)!.beatNumber).toBe(5)
  })

  it('goes quiet when ticks stop arriving', () => {
    const f = new MidiClockFollower()
    for (let i = 0; i < 30; i++) f.onMessage([0xf8], i * 20)
    expect(f.sample(600)).not.toBeNull()
    expect(f.sample(1200)).toBeNull()
    expect(f.status(1200).text).toContain('stopped arriving')
  })
})

/** Run an engine at 60 fps, feeding it an external sample each frame. */
function runEngine(
  engine: BeatEngine,
  fromMs: number,
  toMs: number,
  sampleAt: (t: number) => ExternalSample | null,
  events: BeatEvent[] = [],
) {
  for (let t = fromMs; t <= toMs; t += FRAME) {
    engine.setExternal(sampleAt(t), { ok: true, text: 'test' })
    events.push(...engine.update(t))
  }
  return events
}

describe('external clock sources in the beat engine', () => {
  it('follows MIDI clock: tempo, beat times within a frame, and downbeats on its bars', () => {
    const engine = new BeatEngine(HOP, 0)
    engine.command({ type: 'setClockSource', source: 'midi' }, 0)
    const f = new MidiClockFollower()
    const bpm = 128
    const beatMs = 60000 / bpm
    const start = 1234
    // Ticks arrive as time passes: feed each frame's worth before sampling.
    let fed = 0
    const events = runEngine(engine, 0, 12000, (t) => {
      if (t >= start) feedClock(f, bpm, fed, t, start)
      fed = t + 1e-9
      return f.sample(t)
    })
    expect(engine.bpm).toBeCloseTo(bpm, 1)
    // After settling, every beat lands on a true beat time and downbeats on beats 0, 4, 8...
    for (const e of events.filter((e) => e.atMs > 4000)) {
      const n = Math.round((e.atMs - start) / beatMs)
      expect(Math.abs(e.atMs - (start + n * beatMs))).toBeLessThan(FRAME)
      expect(e.beatInBar).toBe((n % 4) + 1)
    }
    const st = engine.state(12000)
    expect(st.settings.clockSource).toBe('midi')
    expect(st.external).toEqual({ ok: true, text: 'test' })
    expect(isBeatState(st)).toBe(true)
  })

  it('snaps onto a Link-style grid at once and lines up beat 1', () => {
    const engine = new BeatEngine(HOP, 0)
    // Run on the internal clock first (120 BPM, arbitrary phase).
    runEngine(engine, 0, 3000, () => null)
    engine.command({ type: 'setClockSource', source: 'link' }, 3000)
    const bpm = 100
    const beatMs = 60000 / bpm
    const origin = 777 // link beat 0
    const link = (t: number): ExternalSample => {
      const beat = (t - origin) / beatMs
      const n = Math.floor(beat)
      return { periodMs: beatMs, beatAtMs: origin + n * beatMs, phaseKnown: true, beatNumber: n }
    }
    const events = runEngine(engine, 3000 + FRAME, 9000, link)
    // The first beat after switching is already on the Link grid (snapped, no slow drift).
    for (const e of events) {
      const n = Math.round((e.atMs - origin) / beatMs)
      expect(Math.abs(e.atMs - (origin + n * beatMs))).toBeLessThan(FRAME)
    }
    for (const e of events.filter((e) => e.atMs > 4500)) {
      const n = Math.round((e.atMs - origin) / beatMs)
      expect(e.beatInBar).toBe((((n % 4) + 4) % 4) + 1)
    }
  })

  it('ignores tempo commands while external, and returns to the internal tempo after', () => {
    const engine = new BeatEngine(HOP, 0)
    engine.command({ type: 'setBpm', bpm: 90 }, 0)
    engine.command({ type: 'setClockSource', source: 'link' }, 100)
    const link: ExternalSample = { periodMs: 500, beatAtMs: 0, phaseKnown: true, beatNumber: 0 }
    runEngine(engine, 100, 2000, () => link)
    engine.command({ type: 'setBpm', bpm: 150 }, 2000)
    engine.command({ type: 'tap' }, 2000)
    expect(engine.bpm).toBeCloseTo(120, 6)
    engine.command({ type: 'setClockSource', source: 'internal' }, 2100)
    runEngine(engine, 2100, 3000, () => null)
    expect(engine.bpm).toBe(90)
    expect(engine.state(3000).external).toBeNull()
  })

  it('freewheels at the last tempo when the source goes quiet', () => {
    const engine = new BeatEngine(HOP, 0)
    engine.command({ type: 'setClockSource', source: 'midi' }, 0)
    const s: ExternalSample = { periodMs: 400, beatAtMs: 0, phaseKnown: true, beatNumber: 0 }
    runEngine(engine, 0, 2000, () => s)
    const events = runEngine(engine, 2000 + FRAME, 6000, () => null)
    const gaps = events.slice(1).map((e, i) => e.atMs - events[i]!.atMs)
    for (const g of gaps) expect(Math.abs(g - 400)).toBeLessThan(FRAME)
  })

  it('a queued bar trigger re-anchors to the new grid when the source switches', () => {
    const engine = new BeatEngine(HOP, 0)
    const sched = new TriggerScheduler({ candidates: () => ['c1'], prepare: () => {} })
    const spec: PadSpec = {
      source: { kind: 'clip', clipId: 'c1' },
      mode: 'oneShot',
      quantize: 'bar',
      lengthBeats: 2,
      retriggerEvery: 'beat',
      fadeInBeats: 0,
      fadeOutBeats: 0,
      syncBeats: null,
      layer: 'overlayA',
      placement: DEFAULT_PLACEMENT,
      key: DEFAULT_KEY,
    }
    const log: { atMs: number; action: TriggerAction; inBar: number }[] = []
    const beatMs = 60000 / 140
    const origin = 333
    const link = (t: number): ExternalSample => {
      const n = Math.floor((t - origin) / beatMs)
      return { periodMs: beatMs, beatAtMs: origin + n * beatMs, phaseKnown: true, beatNumber: n }
    }
    let external = false
    for (let t = 0; t <= 8000; t += FRAME) {
      if (Math.abs(t - 1000) < FRAME / 2) sched.press('p1', spec, t, engine.clock)
      if (Math.abs(t - 1100) < FRAME / 2) {
        engine.command({ type: 'setClockSource', source: 'link' }, t)
        external = true
      }
      engine.setExternal(external ? link(t) : null, { ok: true, text: '' })
      engine.update(t)
      for (const action of sched.update(t, FRAME, engine.clock))
        log.push({ atMs: t, action, inBar: engine.state(t).beatInBar })
    }
    const start = log.find((l) => l.action.type === 'start')!
    expect(start).toBeDefined()
    // It fired on a downbeat of the new (Link) grid.
    expect(start.inBar).toBe(1)
    const n = Math.round((start.atMs - origin) / beatMs)
    expect(Math.abs(start.atMs - (origin + n * beatMs))).toBeLessThan(FRAME)
    expect(((n % 4) + 4) % 4).toBe(0)
  })

  it('validates the clock-source command', () => {
    expect(isBeatCommand({ type: 'setClockSource', source: 'link' })).toBe(true)
    expect(isBeatCommand({ type: 'setClockSource', source: 'osc' })).toBe(false)
  })
})
