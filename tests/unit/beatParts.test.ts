import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BEAT_SETTINGS,
  isBeatCommand,
  isBeatEvent,
  isBeatState,
  type BeatEvent,
} from '@shared/beat'
import { isControlToOutput, isOutputToControl } from '@shared/protocol'
import { BeatClock } from '@core/beat/beatClock'
import { BeatEngine } from '@core/beat/beatEngine'
import { BeatTracker } from '@core/beat/beatTracker'
import { ClockSync } from '@core/beat/clockSync'
import { TapTempo } from '@core/beat/tapTempo'

const FRAME = 1000 / 60

/** Run the clock from `from` to `to` at 60 fps, collecting events. */
function run(clock: BeatClock, from: number, to: number, events: BeatEvent[] = []): BeatEvent[] {
  for (let t = from; t <= to; t += FRAME) events.push(...clock.update(t))
  return events
}

describe('TapTempo', () => {
  it('converges after 4 steady taps', () => {
    const tap = new TapTempo()
    let r = tap.tap(1000)
    expect(r.bpm).toBeNull()
    for (const t of [1500, 2000, 2500]) r = tap.tap(t)
    expect(r.bpm).toBeCloseTo(120, 6)
    expect(r.beatAtMs).toBeCloseTo(2500, 6)
    expect(r.taps).toBe(4)
  })

  it('averages out sloppy taps', () => {
    const tap = new TapTempo()
    const jitter = [8, -10, 6, -4, 9, -7, 3, -9, 10, -5, 2, -6]
    let r = tap.tap(0)
    jitter.forEach((j, i) => (r = tap.tap((i + 1) * 500 + j)))
    expect(Math.abs(r.bpm! - 120)).toBeLessThan(0.5)
  })

  it('starts a new sequence after a pause', () => {
    const tap = new TapTempo()
    tap.tap(0)
    tap.tap(500)
    const r = tap.tap(3000)
    expect(r.taps).toBe(1)
    expect(r.bpm).toBeNull()
  })
})

describe('ClockSync', () => {
  it('takes the smallest delivery offset, creeps with drift and re-locks after a pause', () => {
    const sync = new ClockSync()
    sync.observe(1.0, 5003)
    sync.observe(1.1, 5101) // lower offset wins
    expect(sync.toPerf(1.1)).toBeCloseTo(5101, 6)
    sync.observe(1.2, 5205) // 4 ms late: creeps only slightly
    expect(sync.toPerf(1.2)).toBeLessThan(5201.1)
    // Audio paused for 2 s: offset jumps; confirmed after repeated observations.
    for (let i = 0; i < 5; i++) sync.observe(1.3 + i * 0.05, 7301 + i * 50)
    expect(sync.toPerf(1.5)).toBeCloseTo(7501, 0)
    expect(sync.toAnalysis(sync.toPerf(2))).toBeCloseTo(2, 9)
  })
})

describe('BeatClock (simulated time)', () => {
  it('emits beats at the tempo with bar and phrase counts', () => {
    const clock = new BeatClock(0, 120, 8)
    const events = run(clock, 0, 64 * 500 + 1)
    expect(events.length).toBe(65)
    events.forEach((e, i) => {
      expect(e.beatIndex).toBe(i)
      expect(e.atMs).toBeCloseTo(i * 500, 6)
    })
    expect(events[4]).toMatchObject({ beatInBar: 1, barIndex: 1, barInPhrase: 2, phraseIndex: 0 })
    expect(events[32]).toMatchObject({ beatInBar: 1, barIndex: 8, barInPhrase: 1, phraseIndex: 1 })
    expect(events[7]!.beatInBar).toBe(4)
  })

  it('changes tempo smoothly: no jumps, no duplicates, converges to the new grid', () => {
    const clock = new BeatClock(0, 120)
    const events = run(clock, 0, 2000)
    clock.setTarget({ periodMs: 60000 / 128, beatAtMs: 2000 + 120 }) // new tempo, shifted phase
    let prev = clock.position(2000)
    for (let t = 2000; t < 8000; t += FRAME) {
      events.push(...clock.update(t))
      const p = clock.position(t)
      expect(p).toBeGreaterThanOrEqual(prev)
      prev = p
    }
    for (let i = 1; i < events.length; i++)
      expect(events[i]!.beatIndex).toBe(events[i - 1]!.beatIndex + 1)
    // After converging, beats land on the target grid.
    const late = events.filter((e) => e.atMs > 5000)
    for (const e of late) {
      const k = Math.round((e.atMs - 2120) / (60000 / 128))
      expect(Math.abs(e.atMs - (2120 + k * (60000 / 128)))).toBeLessThan(2)
    }
    expect(clock.bpm).toBeCloseTo(128, 6)
  })

  it('snaps to the target phase without re-emitting a beat', () => {
    const clock = new BeatClock(0, 120)
    const events = run(clock, 0, 1100) // beats 0, 1, 2
    clock.setTarget({ periodMs: 500, beatAtMs: 1300 })
    clock.snap(1100) // at 1100 the target grid is 0.4 beat before a beat -> moves back 0.2
    run(clock, 1100 + FRAME, 1400, events)
    expect(events.map((e) => e.beatIndex)).toEqual([0, 1, 2, 3])
    expect(events[3]!.atMs).toBeCloseTo(1300, 0)
  })

  it('makes the nearest beat a downbeat', () => {
    const clock = new BeatClock(0, 120)
    run(clock, 0, 1000) // around beat 2
    clock.setDownbeatNow(1000)
    expect(clock.snapshot(1000).beatInBar).toBe(1)
    const next = run(clock, 1000 + FRAME, 2600)
    // The downbeat itself (beat 2, at 1000 ms) fires first, then the rest of the bar.
    expect(next.map((e) => e.beatInBar)).toEqual([1, 2, 3, 4])
  })

  it('latency offset moves the visual timeline earlier', () => {
    const clock = new BeatClock(0, 120)
    run(clock, 0, 2000)
    clock.setLatencyOffset(40, 2000)
    const events = run(clock, 2000 + FRAME, 6000)
    // Converges so visual beats fire 40 ms before the audio grid (multiples of 500).
    const last = events.at(-1)!
    expect(((last.atMs % 500) + 500) % 500).toBeCloseTo(460, 0)
  })
})

describe('BeatTracker', () => {
  it('acquires phase from onsets and corrects small errors', () => {
    const tr = new BeatTracker()
    tr.setPeriod(0.5)
    for (let i = 0; i < 4; i++) tr.onOnset(10.03 + i * 0.5, 2)
    expect(tr.beatTime! % 0.5).toBeCloseTo(0.03, 2)
    // Onsets drift to +0.02: the grid follows within a few beats.
    for (let i = 4; i < 20; i++) tr.onOnset(10.02 + i * 0.5, 2)
    expect(Math.abs((tr.nearestBeat(20.02) - 20.02) * 1000)).toBeLessThan(1)
    expect(tr.inPhase).toBe(true)
  })

  it('ignores weak offbeat onsets but re-acquires after a strong phase change', () => {
    const tr = new BeatTracker()
    tr.setPeriod(0.5)
    for (let i = 0; i < 8; i++) tr.onOnset(i * 0.5, 5, true, 5)
    // Weak offbeat bass for 30 s: grid stays.
    for (let i = 0; i < 60; i++) tr.onOnset(4.25 + i * 0.5, 2, true, 2)
    expect(Math.abs(tr.nearestBeat(34) - 34)).toBeLessThan(0.001)
    // Strong kicks now on the offbeat (hard cut to an unsynced track): grid moves.
    for (let i = 0; i < 8; i++) tr.onOnset(34.25 + i * 0.5, 5, true, 5)
    expect(Math.abs(tr.nearestBeat(38.25) - 38.25)).toBeLessThan(0.02)
  })

  it('does not move when correction is off', () => {
    const tr = new BeatTracker()
    tr.setPeriod(0.5)
    tr.setBeatAt(0)
    for (let i = 0; i < 10; i++) tr.onOnset(0.04 + i * 0.5, 3, false)
    expect(tr.beatTime).toBe(0)
  })
})

describe('BeatEngine commands', () => {
  const engine = () => new BeatEngine(256 / 48000, 0)

  it('tapping sets a locked tempo and aligns beats to the taps', () => {
    const e = engine()
    const events: BeatEvent[] = []
    let t = 0
    for (const tap of [1000, 1600, 2200, 2800]) {
      for (; t < tap; t += FRAME) events.push(...e.update(t))
      e.command({ type: 'tap' }, tap)
    }
    const s = e.state(2800)
    expect(s.bpm).toBeCloseTo(100, 6)
    expect(s.settings.tempoMode).toBe('locked')
    expect(s.taps).toBe(4)
    for (; t < 6000; t += FRAME) events.push(...e.update(t))
    for (const ev of events.filter((x) => x.atMs > 3500)) {
      const beats = (ev.atMs - 2800) / 600
      expect(Math.abs(beats - Math.round(beats)) * 600).toBeLessThan(2)
    }
  })

  it('typed BPM, x2 / ÷2, lock and auto', () => {
    const e = engine()
    e.command({ type: 'setBpm', bpm: 128 }, 0)
    expect(e.state(0).bpm).toBe(128)
    e.command({ type: 'multiply', factor: 0.5 }, 0)
    expect(e.state(0).bpm).toBe(64)
    e.command({ type: 'multiply', factor: 2 }, 0)
    e.command({ type: 'multiply', factor: 2 }, 0)
    expect(e.state(0).bpm).toBe(256)
    e.command({ type: 'auto' }, 0)
    expect(e.state(0).settings.tempoMode).toBe('auto')
    e.command({ type: 'lock' }, 0)
    expect(e.state(0).settings.tempoMode).toBe('locked')
  })

  it('nudge shifts the grid; resync makes now a downbeat', () => {
    const e = engine()
    const before: BeatEvent[] = []
    let t = 0
    for (; t < 3000; t += FRAME) before.push(...e.update(t))
    e.command({ type: 'nudge', ms: 10 }, t)
    const after: BeatEvent[] = []
    for (; t < 7000; t += FRAME) after.push(...e.update(t))
    expect((((after.at(-1)!.atMs - before.at(-1)!.atMs) % 500) + 500) % 500).toBeCloseTo(10, 0)

    e.command({ type: 'resyncDownbeat' }, 7123)
    const s = e.state(7123)
    expect(s.beatInBar).toBe(1)
    expect(s.beatPhase < 0.01 || s.beatPhase > 0.99).toBe(true)
  })

  it('phrase length and latency offset settings', () => {
    const e = engine()
    e.command({ type: 'setPhraseBars', bars: 16 }, 0)
    e.command({ type: 'setLatencyOffset', ms: 30 }, 0)
    e.command({ type: 'setPhaseCorrection', enabled: false }, 0)
    const s = e.state(0)
    expect(s.settings).toMatchObject({
      phraseBars: 16,
      latencyOffsetMs: 30,
      phaseCorrection: false,
    })
    expect(isBeatState(s)).toBe(true)
  })
})

describe('beat message guards', () => {
  it('validate commands, settings, state and events', () => {
    expect(isBeatCommand({ type: 'tap' })).toBe(true)
    expect(isBeatCommand({ type: 'setBpm', bpm: 128 })).toBe(true)
    expect(isBeatCommand({ type: 'setBpm', bpm: 999 })).toBe(false)
    expect(isBeatCommand({ type: 'multiply', factor: 3 })).toBe(false)
    expect(isBeatCommand({ type: 'setPhraseBars', bars: 12 })).toBe(false)
    expect(isBeatCommand({ type: 'setTempoRange', minBpm: 70, maxBpm: 180 })).toBe(true)
    expect(isBeatCommand({ type: 'setTempoRange', minBpm: 100, maxBpm: 150 })).toBe(false) // < 1 octave
    expect(isBeatCommand({ type: 'setLatencyOffset', ms: 500 })).toBe(false)
    expect(
      isBeatEvent({
        beatIndex: 1,
        beatInBar: 2,
        barIndex: 0,
        barInPhrase: 1,
        phraseIndex: 0,
        atMs: 5,
      }),
    ).toBe(true)
    expect(isControlToOutput({ type: 'beatCommand', command: { type: 'tap' } })).toBe(true)
    expect(isControlToOutput({ type: 'beatCommand', command: { type: 'explode' } })).toBe(false)
    const state = new BeatEngine(256 / 48000, 0, DEFAULT_BEAT_SETTINGS).state(0)
    expect(isOutputToControl({ type: 'beatState', state })).toBe(true)
    expect(
      isOutputToControl({
        type: 'beat',
        event: { beatIndex: 1, beatInBar: 2, barIndex: 0, barInPhrase: 1, phraseIndex: 0, atMs: 5 },
      }),
    ).toBe(true)
  })
})
