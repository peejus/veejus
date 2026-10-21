import { describe, expect, it } from 'vitest'
import { BeatClock } from '@core/beat/beatClock'
import { pickRandom } from '@core/trigger/randomPick'
import { GRACE_MS, TriggerScheduler, type TriggerAction } from '@core/trigger/scheduler'
import { isPadSpec, isTriggerState, type PadSource, type PadSpec } from '@shared/pads'
import { DEFAULT_KEY, DEFAULT_PLACEMENT } from '@shared/layers'

const FRAME = 1000 / 60
const HALF_FRAME = FRAME / 2 + 0.01

function spec(over: Partial<PadSpec> = {}): PadSpec {
  return {
    source: { kind: 'clip', clipId: 'clip-a' },
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
    ...over,
  }
}

const library: Record<string, string[]> = { all: ['c1', 'c2', 'c3', 'c4'], gifs: ['g1', 'g2'] }

/** A scheduler driven by a fixed-tempo BeatClock at 60 fps, with a scripted timeline. */
function harness(bpm = 120, phraseBars = 8) {
  const clock = new BeatClock(0, bpm, phraseBars)
  const prepared: string[] = []
  const sched = new TriggerScheduler({
    candidates: (s: PadSource) =>
      s.kind === 'clip' ? [s.clipId] : (library[s.folder ?? 'all'] ?? []),
    prepare: (id) => prepared.push(id),
  })
  const log: { atMs: number; action: TriggerAction }[] = []
  let now = 0
  const runTo = (ms: number) => {
    for (; now <= ms; now += FRAME) {
      clock.update(now)
      for (const action of sched.update(now, FRAME, clock)) log.push({ atMs: now, action })
    }
  }
  const at = (ms: number, fn: () => void) => {
    runTo(ms - FRAME)
    // Input arrives between frames.
    fn()
  }
  const period = 60000 / bpm
  return { clock, sched, log, runTo, at, period, prepared, now: () => now }
}

const starts = (log: { atMs: number; action: TriggerAction }[]) =>
  log.filter((l) => l.action.type === 'start')
const stops = (log: { atMs: number; action: TriggerAction }[]) =>
  log.filter((l) => l.action.type === 'stop')

describe('quantized starts (acceptance: within one frame of the boundary)', () => {
  it('bar quantize fires on the frame nearest the next bar', () => {
    const h = harness(120)
    h.at(1234, () => h.sched.press('p1', spec(), h.now(), h.clock))
    h.runTo(3000)
    const s = starts(h.log)
    expect(s).toHaveLength(1)
    expect(Math.abs(s[0]!.atMs - 2000)).toBeLessThanOrEqual(HALF_FRAME)
    expect(h.prepared).toEqual(['clip-a'])
  })

  for (const [quantize, pressMs, expectMs] of [
    // Presses well past the grace window after the previous boundary.
    ['quarter', 1100, 1125],
    ['beat', 1100, 1500],
    ['phrase', 1100, 16000],
  ] as const) {
    it(`${quantize} quantize`, () => {
      const h = harness(120)
      h.at(pressMs, () => h.sched.press('p1', spec({ quantize }), h.now(), h.clock))
      h.runTo(expectMs + 500)
      expect(Math.abs(starts(h.log)[0]!.atMs - expectMs)).toBeLessThanOrEqual(HALF_FRAME)
    })
  }

  it('quantize off starts on the next frame', () => {
    const h = harness(120)
    h.at(1010, () => h.sched.press('p1', spec({ quantize: 'off' }), h.now(), h.clock))
    h.runTo(1100)
    expect(starts(h.log)[0]!.atMs - 1010).toBeLessThanOrEqual(FRAME)
  })

  it(`a press up to ${GRACE_MS} ms late still counts for the boundary just passed`, () => {
    const h = harness(120)
    h.at(2060, () => h.sched.press('p1', spec(), h.now(), h.clock))
    h.runTo(2200)
    expect(starts(h.log)[0]!.atMs - 2060).toBeLessThanOrEqual(FRAME)
    const late = harness(120)
    late.at(2150, () => late.sched.press('p1', spec(), late.now(), late.clock))
    late.runTo(4500)
    expect(Math.abs(starts(late.log)[0]!.atMs - 4000)).toBeLessThanOrEqual(HALF_FRAME)
  })

  it('bars follow the resynced downbeat', () => {
    const h = harness(120)
    h.runTo(1500)
    h.clock.setDownbeatNow(1500) // beat 3 is now "1"
    h.at(1700, () => h.sched.press('p1', spec(), h.now(), h.clock))
    h.runTo(4000)
    expect(Math.abs(starts(h.log)[0]!.atMs - 3500)).toBeLessThanOrEqual(HALF_FRAME)
  })

  it('the latency offset makes triggers fire earlier than the audio grid', () => {
    const h = harness(120)
    h.clock.setLatencyOffset(40, 0)
    h.at(1234, () => h.sched.press('p1', spec(), h.now(), h.clock))
    h.runTo(3000)
    // The visual timeline runs 40 ms ahead, so the bar at 2000 ms (audio) fires at ~1960 ms.
    expect(Math.abs(starts(h.log)[0]!.atMs - 1960)).toBeLessThanOrEqual(HALF_FRAME)
  })
})

describe('play modes', () => {
  for (const bpm of [120, 174]) {
    for (const beats of [2, 4]) {
      it(`'beats' mode shows a clip for exactly ${beats} beats at ${bpm} BPM (+-1 frame)`, () => {
        const h = harness(bpm)
        h.at(100, () =>
          h.sched.press('p1', spec({ mode: 'beats', lengthBeats: beats }), h.now(), h.clock),
        )
        h.runTo(20 * (60000 / bpm))
        const start = starts(h.log)[0]!.atMs
        const stop = stops(h.log)[0]!.atMs
        expect(Math.abs(stop - start - beats * h.period)).toBeLessThanOrEqual(FRAME)
      })
    }
  }

  it('fades in and out over the given beats', () => {
    const h = harness(120)
    h.at(100, () =>
      h.sched.press(
        'p1',
        spec({ mode: 'beats', lengthBeats: 4, fadeInBeats: 1, fadeOutBeats: 1 }),
        h.now(),
        h.clock,
      ),
    )
    h.runTo(2100) // started at bar 1 (2000 ms)
    expect(h.sched.opacity('overlayA', 2250, h.clock)).toBeCloseTo(0.5, 1)
    expect(h.sched.opacity('overlayA', 3000, h.clock)).toBeCloseTo(1, 5)
    expect(h.sched.opacity('overlayA', 3750, h.clock)).toBeCloseTo(0.5, 1)
  })

  it("'hold' plays while held and stops on release; releasing before the start cancels", () => {
    const h = harness(120)
    h.at(100, () => h.sched.press('p1', spec({ mode: 'hold', quantize: 'beat' }), h.now(), h.clock))
    h.at(400, () => h.sched.press('p1', spec({ mode: 'hold', quantize: 'beat' }), h.now(), h.clock)) // key repeat
    h.at(1800, () => h.sched.release('p1', h.now(), h.clock))
    h.runTo(2500)
    expect(starts(h.log)).toHaveLength(1)
    expect(stops(h.log)[0]!.atMs - 1800).toBeLessThanOrEqual(FRAME * 2)

    const c = harness(120)
    c.at(100, () => c.sched.press('p1', spec({ mode: 'hold' }), c.now(), c.clock))
    c.at(900, () => c.sched.release('p1', c.now(), c.clock))
    c.runTo(3000)
    expect(starts(c.log)).toHaveLength(0)
  })

  it("'toggle' starts on one boundary and stops on a later one; double press before start cancels", () => {
    const h = harness(120)
    h.at(100, () => h.sched.press('p1', spec({ mode: 'toggle' }), h.now(), h.clock))
    h.at(2600, () => h.sched.press('p1', spec({ mode: 'toggle' }), h.now(), h.clock))
    h.runTo(5000)
    expect(Math.abs(starts(h.log)[0]!.atMs - 2000)).toBeLessThanOrEqual(HALF_FRAME)
    expect(Math.abs(stops(h.log)[0]!.atMs - 4000)).toBeLessThanOrEqual(FRAME * 1.5)

    const c = harness(120)
    c.at(100, () => c.sched.press('p1', spec({ mode: 'toggle' }), c.now(), c.clock))
    c.at(500, () => c.sched.press('p1', spec({ mode: 'toggle' }), c.now(), c.clock))
    c.runTo(3000)
    expect(starts(c.log)).toHaveLength(0)
  })

  it("'retrigger' restarts the clip on every beat until toggled off", () => {
    const h = harness(120)
    const s = spec({ mode: 'retrigger', quantize: 'beat', retriggerEvery: 'beat' })
    h.at(100, () => h.sched.press('p1', s, h.now(), h.clock))
    h.at(2600, () => h.sched.press('p1', s, h.now(), h.clock))
    h.runTo(4000)
    const restarts = h.log.filter((l) => l.action.type === 'restart').map((l) => l.atMs)
    expect(restarts).toHaveLength(4) // beats at 1000, 1500, 2000, 2500
    restarts.forEach((t, i) =>
      expect(Math.abs(t - (1000 + i * 500))).toBeLessThanOrEqual(HALF_FRAME),
    )
    expect(Math.abs(stops(h.log)[0]!.atMs - 3000)).toBeLessThanOrEqual(FRAME * 1.5)
  })

  it("'oneShot' ends when the clip ends; pressing again restarts it on the next boundary", () => {
    const h = harness(120)
    h.at(100, () => h.sched.press('p1', spec({ quantize: 'beat' }), h.now(), h.clock))
    h.at(800, () => h.sched.press('p1', spec({ quantize: 'beat' }), h.now(), h.clock))
    h.runTo(1200)
    expect(starts(h.log).map((s) => Math.round(s.atMs / 500))).toEqual([1, 2])
    h.sched.onClipEnded('p1')
    expect(h.sched.state(1200, h.clock).pads).toEqual({})
  })

  it('starting another pad replaces the one showing', () => {
    const h = harness(120)
    h.at(100, () =>
      h.sched.press('p1', spec({ mode: 'toggle', quantize: 'off' }), h.now(), h.clock),
    )
    h.at(600, () =>
      h.sched.press(
        'p2',
        spec({ quantize: 'off', source: { kind: 'clip', clipId: 'clip-b' } }),
        h.now(),
        h.clock,
      ),
    )
    h.runTo(700)
    expect(h.sched.voiceOn('overlayA')?.padId).toBe('p2')
    expect(Object.keys(h.sched.state(700, h.clock).pads)).toEqual(['p2'])
  })

  it('pads on different layers play at the same time', () => {
    const h = harness(120)
    h.at(100, () =>
      h.sched.press(
        'bg',
        spec({ mode: 'toggle', quantize: 'off', layer: 'background' }),
        h.now(),
        h.clock,
      ),
    )
    h.at(300, () =>
      h.sched.press('ov', spec({ quantize: 'off', layer: 'overlayA' }), h.now(), h.clock),
    )
    h.runTo(400)
    expect(h.sched.voiceOn('background')?.padId).toBe('bg')
    expect(h.sched.voiceOn('overlayA')?.padId).toBe('ov')
    expect(h.sched.state(400, h.clock).pads).toMatchObject({
      bg: { state: 'playing', layer: 'background' },
      ov: { state: 'playing', layer: 'overlayA' },
    })
    expect(h.sched.stopLayer('overlayA')).toEqual([
      { type: 'stop', layer: 'overlayA', padId: 'ov' },
    ])
    expect(h.sched.voiceOn('background')?.padId).toBe('bg')
  })

  it('a pad that changes layer leaves its old one', () => {
    const h = harness(120)
    h.at(100, () =>
      h.sched.press(
        'p1',
        spec({ mode: 'beats', lengthBeats: 8, quantize: 'off', layer: 'overlayA' }),
        h.now(),
        h.clock,
      ),
    )
    h.at(300, () =>
      h.sched.press(
        'p1',
        spec({ mode: 'beats', lengthBeats: 8, quantize: 'off', layer: 'overlayB' }),
        h.now(),
        h.clock,
      ),
    )
    h.runTo(400)
    expect(h.sched.voiceOn('overlayA')).toBeNull()
    expect(h.sched.voiceOn('overlayB')?.padId).toBe('p1')
    expect(h.log.some((l) => l.action.type === 'stop' && l.action.layer === 'overlayA')).toBe(true)
  })
})

describe('drop (arm and fire)', () => {
  it('fires exactly on the next phrase boundary with a correct countdown', () => {
    const h = harness(120, 8) // phrase = 32 beats = 16 s
    h.at(3000, () => h.sched.arm('p1', spec(), h.now(), h.clock))
    expect(h.sched.state(3000, h.clock).drop).toMatchObject({ padIds: ['p1'], barsRemaining: 7 })
    expect(h.sched.state(15000, h.clock).drop!.barsRemaining).toBe(1)
    h.runTo(17000)
    expect(Math.abs(starts(h.log)[0]!.atMs - 16000)).toBeLessThanOrEqual(HALF_FRAME)
    expect(h.sched.state(17000, h.clock).drop).toBeNull()
  })

  it('fires after N bars when set, and all armed pads fire together', () => {
    const h = harness(120)
    h.sched.settings = { quantize: 'beat', drop: { kind: 'bars', bars: 2 } }
    // beat 6: next bar at 8, +1 bar = 12
    h.at(3000, () => h.sched.arm('p1', spec({ layer: 'background' }), h.now(), h.clock))
    h.at(3500, () =>
      h.sched.arm('p2', spec({ source: { kind: 'clip', clipId: 'clip-b' } }), h.now(), h.clock),
    )
    h.runTo(7000)
    const s = starts(h.log)
    expect(s.map((x) => (x.action as { padId: string }).padId)).toEqual(['p1', 'p2'])
    // Different layers: both show after the drop.
    expect(h.sched.voiceOn('background')?.padId).toBe('p1')
    expect(h.sched.voiceOn('overlayA')?.padId).toBe('p2')
    for (const x of s) expect(Math.abs(x.atMs - 6000)).toBeLessThanOrEqual(HALF_FRAME)
  })

  it('changing the drop timing while armed retargets the pending drop from now', () => {
    const h = harness(120, 8) // phrase = 16 s
    h.at(3000, () => h.sched.arm('p1', spec(), h.now(), h.clock))
    expect(h.sched.state(3000, h.clock).drop!.barsRemaining).toBe(7)
    // At beat 10 (5 s) switch to "in 2 bars": next bar at beat 12, +1 bar = beat 16 (8 s).
    h.at(5000, () =>
      h.sched.setSettings({ quantize: 'beat', drop: { kind: 'bars', bars: 2 } }, h.now(), h.clock),
    )
    h.runTo(9000)
    expect(starts(h.log)).toHaveLength(1)
    expect(Math.abs(starts(h.log)[0]!.atMs - 8000)).toBeLessThanOrEqual(HALF_FRAME)
    // Changing only the quantize leaves a pending drop where it is.
    h.at(9100, () => h.sched.arm('p2', spec(), h.now(), h.clock))
    const before = h.sched.state(9100, h.clock).drop!.beatsRemaining
    h.sched.setSettings({ quantize: 'bar', drop: { kind: 'bars', bars: 2 } }, 9100, h.clock)
    expect(h.sched.state(9100, h.clock).drop!.beatsRemaining).toBeCloseTo(before, 6)
  })

  it('dropNow fires the armed drop on the next beat', () => {
    const h = harness(120, 8)
    h.at(3000, () => h.sched.arm('p1', spec(), h.now(), h.clock))
    h.at(3200, () => h.sched.dropNow(h.now(), h.clock))
    h.runTo(4000)
    // Beat 6.4 at 3.2 s: the next beat is beat 7 = 3.5 s.
    expect(Math.abs(starts(h.log)[0]!.atMs - 3500)).toBeLessThanOrEqual(HALF_FRAME)
  })

  it('pad velocity scales the clip opacity', () => {
    const h = harness(120)
    h.at(100, () => h.sched.press('p1', spec({ quantize: 'off' }), h.now(), h.clock, 0.25))
    h.runTo(300)
    expect(h.sched.opacity('overlayA', 300, h.clock)).toBeCloseTo(0.25)
  })

  it('arming an armed pad disarms it; disarming the last cancels the drop', () => {
    const h = harness(120)
    h.at(1000, () => h.sched.arm('p1', spec(), h.now(), h.clock))
    h.at(1500, () => h.sched.arm('p1', spec(), h.now(), h.clock))
    expect(h.sched.state(1500, h.clock).drop).toBeNull()
    h.runTo(20000)
    expect(starts(h.log)).toHaveLength(0)
  })

  it('stop all cancels the drop and stops the showing pad', () => {
    const h = harness(120)
    h.at(100, () =>
      h.sched.press('p1', spec({ mode: 'toggle', quantize: 'off' }), h.now(), h.clock),
    )
    h.at(500, () => h.sched.arm('p2', spec(), h.now(), h.clock))
    h.runTo(600)
    expect(h.sched.stopAll()).toEqual([{ type: 'stop', layer: 'overlayA', padId: 'p1' }])
    h.runTo(20000)
    expect(starts(h.log)).toHaveLength(1)
    const st = h.sched.state(20000, h.clock)
    expect(st).toMatchObject({ pads: {}, drop: null })
    expect(isTriggerState(st)).toBe(true)
  })
})

describe('random pick', () => {
  it('never picks the same clip twice in a row (acceptance)', () => {
    let seed = 42
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    let last: string | null = null
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const pick: string = pickRandom(['a', 'b', 'c'], last, rand)!
      expect(pick).not.toBe(last)
      seen.add(pick)
      last = pick
    }
    expect(seen).toEqual(new Set(['a', 'b', 'c']))
  })

  it('handles one or no candidates', () => {
    expect(pickRandom(['only'], 'only')).toBe('only')
    expect(pickRandom([], null)).toBeNull()
  })

  it('random pads pick from their folder without immediate repeats', () => {
    const h = harness(120)
    const s = spec({ quantize: 'off', source: { kind: 'random', folder: 'gifs' } })
    for (let i = 0; i < 10; i++) h.at(100 + i * 200, () => h.sched.press('p1', s, h.now(), h.clock))
    h.runTo(2500)
    const clips = starts(h.log).map((x) => (x.action as { clipId: string }).clipId)
    expect(clips.length).toBe(10)
    clips.forEach((c, i) => {
      expect(['g1', 'g2']).toContain(c)
      if (i > 0) expect(c).not.toBe(clips[i - 1])
    })
  })

  it('a pad with nothing to play does nothing', () => {
    const h = harness(120)
    h.at(100, () =>
      h.sched.press(
        'p1',
        spec({ quantize: 'off', source: { kind: 'random', folder: 'empty' } }),
        h.now(),
        h.clock,
      ),
    )
    h.runTo(500)
    expect(h.log).toHaveLength(0)
  })
})

describe('pad spec guard', () => {
  it('validates specs', () => {
    expect(isPadSpec(spec())).toBe(true)
    expect(isPadSpec(spec({ mode: 'loop' as never }))).toBe(false)
    expect(isPadSpec(spec({ lengthBeats: 0 }))).toBe(false)
    expect(isPadSpec(spec({ source: { kind: 'random', folder: null } }))).toBe(true)
    expect(isPadSpec(spec({ source: { kind: 'clip', clipId: '' } }))).toBe(false)
  })
})
