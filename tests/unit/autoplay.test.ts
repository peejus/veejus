import { describe, expect, it } from 'vitest'
import { BeatClock } from '@core/beat/beatClock'
import { TriggerScheduler, type TriggerAction } from '@core/trigger/scheduler'
import {
  AUTO_PAD_ID,
  DEFAULT_AUTO_PLAY,
  autoStepBeats,
  isAutoPlaySettings,
  type AutoPlaySettings,
  type AutoSource,
} from '@shared/autoplay'
import { DEFAULT_KEY, DEFAULT_PLACEMENT } from '@shared/layers'
import { isTriggerState, type PadSpec } from '@shared/pads'
import { checkSet, setFingerprint } from '@shared/set'

const FRAME = 1000 / 60
const HALF_FRAME = FRAME / 2 + 0.01

/** Images in library order; gifs have a natural length (ms), stills none. */
const CLIPS: Record<string, number | null> = { s1: null, g1: 1000, s2: null, g2: 3900 }

function harness(bpm = 120, clips: Record<string, number | null> = CLIPS) {
  const clock = new BeatClock(0, bpm, 8)
  const lib = { ...clips }
  const prepared: string[] = []
  let r = 0
  const sched = new TriggerScheduler(
    {
      candidates: (s) => (s.kind === 'clip' ? [s.clipId] : []),
      prepare: (id) => prepared.push(id),
      autoCandidates: (s: AutoSource) => (s.kind === 'images' ? Object.keys(lib) : []),
      durationMs: (id) => lib[id] ?? null,
    },
    // Deterministic "random" for shuffle.
    () => ((r = (r * 7 + 3) % 11), r / 11),
  )
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
    fn()
  }
  const play = (over: Partial<AutoPlaySettings> = {}) =>
    sched.setAutoPlay({ ...DEFAULT_AUTO_PLAY, enabled: true, ...over }, now, clock)
  return { clock, sched, log, runTo, at, play, prepared, lib, now: () => now }
}

const autoStarts = (log: { atMs: number; action: TriggerAction }[]) =>
  log.filter((l) => l.action.type === 'start' && l.action.padId === AUTO_PAD_ID) as {
    atMs: number
    action: Extract<TriggerAction, { type: 'start' }>
  }[]

describe('auto step lengths', () => {
  it('a still holds one bar; a GIF plays once, snapped to 1/2/4/8/16 beats', () => {
    expect(autoStepBeats(null, 120)).toBe(4)
    expect(autoStepBeats(1000, 120)).toBe(2) // 2 beats at 120
    expect(autoStepBeats(1400, 120)).toBe(2) // 2.8 beats: closer to 2 than 4 on a log scale
    expect(autoStepBeats(1600, 120)).toBe(4) // 3.2 beats
    expect(autoStepBeats(200, 120)).toBe(1) // shorter than a beat: one beat
    expect(autoStepBeats(60000, 120)).toBe(16) // long ones cap at 4 bars
  })
})

describe('auto-play', () => {
  it('steps through the images in order on the beat, each for its own length', () => {
    const h = harness(120) // 500 ms beats, 2000 ms bars
    h.at(1100, () => h.play())
    h.runTo(13000)
    const s = autoStarts(h.log)
    // Switched on mid-beat: the first clip goes up on the next beat (1500).
    expect(s.map((x) => x.action.clipId).slice(0, 5)).toEqual(['s1', 'g1', 's2', 'g2', 's1'])
    const times = s.map((x) => x.atMs)
    // s1 (a bar, cut short to land on the bar line at 2000) → g1 (1000 ms = 2 beats) → s2
    // (a bar, but it went up mid-bar, so it gives way at the bar line) → g2 (3900 ms ≈ 8 beats).
    for (const [i, expected] of [1500, 2000, 3000, 4000, 8000].entries())
      expect(Math.abs(times[i]! - expected)).toBeLessThanOrEqual(HALF_FRAME)
    for (const x of s) expect(x.action.layer).toBe('background')
  })

  it('stretches each GIF to its step with the auto step, and plays at normal speed otherwise', () => {
    const h = harness(120)
    h.play()
    h.runTo(4000)
    const byClip = Object.fromEntries(autoStarts(h.log).map((x) => [x.action.clipId, x.action]))
    expect(byClip.g1!.spec.syncBeats).toBe(2)
    expect(byClip.s1!.spec.syncBeats).toBeNull()
    expect(byClip.s1!.spec.placement.fit).toBe('cover')

    const k = harness(120)
    k.play({ step: 2 })
    k.runTo(4000)
    const fixed = autoStarts(k.log)
    expect(fixed.every((x) => x.action.spec.syncBeats === null)).toBe(true)
    const gaps = fixed.slice(1).map((x, i) => x.atMs - fixed[i]!.atMs)
    for (const g of gaps) expect(Math.abs(g - 1000)).toBeLessThanOrEqual(FRAME)
  })

  it('loads the next clip a step ahead', () => {
    const h = harness(120)
    h.play()
    expect(h.prepared).toEqual(['s1'])
    h.runTo(100)
    expect(h.prepared).toEqual(['s1', 'g1'])
    const st = h.sched.state(h.now(), h.clock)
    expect(isTriggerState(st)).toBe(true)
    expect(st.auto).toMatchObject({ enabled: true, clipId: 's1', nextClipId: 'g1' })
    // The auto-play voice is not a pad.
    expect(st.pads).toEqual({})
  })

  it('shuffle plays every clip once per round, never the same one twice in a row', () => {
    const h = harness(120)
    h.play({ order: 'shuffle', step: 1 })
    h.runTo(500 * 40)
    const ids = autoStarts(h.log).map((x) => x.action.clipId)
    for (let i = 0; i + 4 <= 36; i += 4) expect(new Set(ids.slice(i, i + 4)).size).toBe(4)
    for (let i = 1; i < ids.length; i++) expect(ids[i]).not.toBe(ids[i - 1])
  })

  it('a pad on the same layer takes over, and auto-play carries on after it', () => {
    const h = harness(120)
    h.play({ step: 1 })
    const pad: PadSpec = {
      source: { kind: 'clip', clipId: 'x' },
      mode: 'beats',
      quantize: 'beat',
      lengthBeats: 2,
      retriggerEvery: 'beat',
      fadeInBeats: 0,
      fadeOutBeats: 0,
      syncBeats: null,
      layer: 'background',
      placement: DEFAULT_PLACEMENT,
      key: DEFAULT_KEY,
    }
    h.at(1100, () => h.sched.press('A1', pad, h.now(), h.clock))
    h.runTo(1600)
    expect(h.sched.state(h.now(), h.clock).auto.yielding).toBe(true)
    h.runTo(4000)
    const s = autoStarts(h.log).map((x) => x.atMs)
    // Steps at 0, 500, 1000; the pad holds 1500–2500; auto-play is back at 2500.
    expect(s.some((t) => t > 1400 && t < 2400)).toBe(false)
    expect(s.some((t) => Math.abs(t - 2500) <= HALF_FRAME)).toBe(true)
  })

  it('stop all switches it off (and says so once); switching off clears its layer', () => {
    const h = harness(120)
    h.play()
    h.runTo(700)
    const stops = h.sched.stopAll()
    expect(stops).toContainEqual({ type: 'stop', layer: 'background', padId: AUTO_PAD_ID })
    expect(h.sched.autoPlay.enabled).toBe(false)
    expect(h.sched.takeAutoInterrupted()).toBe(true)
    expect(h.sched.takeAutoInterrupted()).toBe(false)
    const before = autoStarts(h.log).length
    h.runTo(5000)
    expect(autoStarts(h.log).length).toBe(before)

    const k = harness(120)
    k.play()
    k.runTo(700)
    const off = k.sched.setAutoPlay({ ...DEFAULT_AUTO_PLAY, enabled: false }, k.now(), k.clock)
    expect(off).toEqual([{ type: 'stop', layer: 'background', padId: AUTO_PAD_ID }])
    expect(k.sched.takeAutoInterrupted()).toBe(false)
  })

  it('waits for clips when there are none, and starts once some arrive', () => {
    const h = harness(120, {})
    h.play()
    h.runTo(1200)
    expect(autoStarts(h.log)).toHaveLength(0)
    h.lib.s9 = null
    h.runTo(2200)
    const s = autoStarts(h.log)
    expect(s.map((x) => x.action.clipId)).toEqual(['s9'])
    expect(Math.abs(s[0]!.atMs - 1500)).toBeLessThanOrEqual(HALF_FRAME)
  })

  it('moving to another layer clears the old one', () => {
    const h = harness(120)
    h.play()
    h.runTo(300)
    const a = h.sched.setAutoPlay(
      { ...DEFAULT_AUTO_PLAY, enabled: true, layer: 'overlayA' },
      h.now(),
      h.clock,
    )
    expect(a).toEqual([{ type: 'stop', layer: 'background', padId: AUTO_PAD_ID }])
    h.runTo(1000)
    expect(autoStarts(h.log).at(-1)!.action.layer).toBe('overlayA')
  })
})

describe('auto-play settings in sets', () => {
  it('are validated, optional for older sets, and switching on is not an unsaved change', () => {
    expect(isAutoPlaySettings(DEFAULT_AUTO_PLAY)).toBe(true)
    expect(isAutoPlaySettings({ ...DEFAULT_AUTO_PLAY, step: 3 })).toBe(false)
    expect(
      isAutoPlaySettings({ ...DEFAULT_AUTO_PLAY, source: { kind: 'collection', tag: '' } }),
    ).toBe(false)
    const base = {
      format: 'veejus-set',
      version: 1,
      savedAt: 'x',
      clips: [],
    }
    // A damaged auto-play block is reported (other parts are checked first, so this only
    // shows the field is looked at when present).
    const bad = checkSet({ ...base, autoPlay: { nope: 1 } })
    expect(bad.ok).toBe(false)
    const s = { autoPlay: { ...DEFAULT_AUTO_PLAY } } as unknown as Parameters<
      typeof setFingerprint
    >[0]
    const on = { autoPlay: { ...DEFAULT_AUTO_PLAY, enabled: true } } as typeof s
    const slower = { autoPlay: { ...DEFAULT_AUTO_PLAY, step: 16 } } as typeof s
    expect(setFingerprint(on)).toBe(setFingerprint(s))
    expect(setFingerprint(slower)).not.toBe(setFingerprint(s))
  })
})
