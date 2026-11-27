import { describe, expect, it } from 'vitest'
import { BeatClock } from '@core/beat/beatClock'
import { TriggerScheduler, type TriggerAction } from '@core/trigger/scheduler'
import {
  AUTO_PAD_ID,
  DEFAULT_AUTO_PLAY,
  autoStepBeats,
  autoStepPlan,
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
  const cued: { id: string; startMs: number }[] = []
  let r = 0
  const sched = new TriggerScheduler(
    {
      candidates: (s) => (s.kind === 'clip' ? [s.clipId] : []),
      prepare: (id) => prepared.push(id),
      autoCandidates: (s: AutoSource) =>
        s.kind === 'images' || s.kind === 'all' ? Object.keys(lib) : [],
      durationMs: (id) => lib[id] ?? null,
      cue: (id, startMs) => cued.push({ id, startMs }),
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
  return { clock, sched, log, runTo, at, play, prepared, cued, lib, now: () => now }
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
    expect(autoStepBeats(11000, 120)).toBe(16) // 22 beats: still within √2 of 16
  })

  it('stretches by at most √2; longer videos play at normal speed, shorter clips loop', () => {
    expect(autoStepPlan(null, 120)).toEqual({ beats: 4, syncBeats: null })
    expect(autoStepPlan(1000, 120)).toEqual({ beats: 2, syncBeats: 2 })
    // A 60 s video at 120 BPM is 120 beats: it used to be squeezed into 16 beats (7.5×).
    expect(autoStepPlan(60000, 120)).toEqual({ beats: 16, syncBeats: null })
    expect(autoStepPlan(60000, 120, 8)).toEqual({ beats: 8, syncBeats: null })
    expect(autoStepPlan(12000, 120, 32)).toEqual({ beats: 32, syncBeats: null }) // 24 beats
    // Shorter than a beat: loops 2 or 4 times within it, stretched a little.
    expect(autoStepPlan(250, 120)).toEqual({ beats: 1, syncBeats: 0.5 })
    expect(autoStepPlan(130, 120)).toEqual({ beats: 1, syncBeats: 0.25 })
    expect(autoStepPlan(400, 120)).toEqual({ beats: 1, syncBeats: 1 })
    for (let ms = 100; ms < 11300; ms += 37) {
      const p = autoStepPlan(ms, 120)
      if (p.syncBeats === null) continue
      const stretch = (p.syncBeats * 500) / ms
      expect(stretch).toBeLessThanOrEqual(Math.SQRT2 + 1e-9)
      expect(stretch).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-9)
    }
  })
})

describe('auto-play with videos', () => {
  const VIDS = { v1: 60000, v2: 30000 }

  it('plays a long video at normal speed for the long-video length, from a random spot', () => {
    const h = harness(120, VIDS)
    h.play({ longBeats: 8, videoStart: 'random' })
    h.runTo(20000)
    const s = autoStarts(h.log)
    expect(s.length).toBeGreaterThanOrEqual(4)
    for (const x of s) {
      expect(x.action.spec.syncBeats).toBeNull()
      expect(x.action.spec.lengthBeats).toBe(8)
      const room = VIDS[x.action.clipId as keyof typeof VIDS] - 8 * 500
      expect(x.action.startMs).toBeGreaterThan(0)
      expect(x.action.startMs).toBeLessThanOrEqual(room)
    }
    // Two bars each (4000 ms).
    const gaps = s.slice(2).map((x, i) => x.atMs - s[i + 1]!.atMs)
    for (const g of gaps) expect(Math.abs(g - 4000)).toBeLessThanOrEqual(FRAME)
    // Every start after the first was cued ahead of time at the same spot.
    for (const x of s.slice(1)) {
      const cue = h.cued.find((c) => c.id === x.action.clipId && c.startMs === x.action.startMs)
      expect(cue).toBeDefined()
    }
  })

  it('carries on where it left off, wrapping to the start near the end', () => {
    const h = harness(120, { v: 10000 })
    h.play({ step: 4, videoStart: 'continue' })
    h.runTo(13000)
    // A one-clip source: each bar picks it up 2000 ms further on, then wraps.
    const starts = autoStarts(h.log).map((x) => x.action.startMs ?? 0)
    expect(starts.slice(0, 6)).toEqual([0, 2000, 4000, 6000, 8000, 0])
  })

  it('starts at the beginning when asked, and whenever a clip plays through (stretched)', () => {
    const h = harness(120, VIDS)
    h.play({ step: 4, videoStart: 'start' })
    h.runTo(6000)
    expect(autoStarts(h.log).every((x) => !x.action.startMs)).toBe(true)
    expect(h.cued).toEqual([])

    const k = harness(120, { short: 3000, still: null })
    k.play({ videoStart: 'random' })
    k.runTo(8000)
    const s = autoStarts(k.log)
    expect(s.some((x) => x.action.clipId === 'short')).toBe(true)
    // Synced to 8 beats, so it plays once from the top.
    for (const x of s) expect(x.action.startMs ?? 0).toBe(0)
  })

  it('cues the next video once it has loaded (its length becomes known)', () => {
    const h = harness(120, { s1: null, v1: null })
    h.play({ step: 4, videoStart: 'random' })
    h.runTo(500)
    expect(h.cued).toEqual([])
    h.lib.v1 = 20000 // finished loading
    h.runTo(600)
    expect(h.cued.map((c) => c.id)).toEqual(['v1'])
    h.runTo(2600)
    const v = autoStarts(h.log).find((x) => x.action.clipId === 'v1')!
    expect(v.action.startMs).toBe(h.cued[0]!.startMs)
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
    expect(isAutoPlaySettings({ ...DEFAULT_AUTO_PLAY, photoFx: 'mix' })).toBe(true)
    expect(isAutoPlaySettings({ ...DEFAULT_AUTO_PLAY, photoFx: 'sparkle' })).toBe(false)
    expect(isAutoPlaySettings({ ...DEFAULT_AUTO_PLAY, source: { kind: 'videos' } })).toBe(true)
    expect(isAutoPlaySettings({ ...DEFAULT_AUTO_PLAY, videoStart: 'middle' })).toBe(false)
    expect(isAutoPlaySettings({ ...DEFAULT_AUTO_PLAY, longBeats: 12 })).toBe(false)
    expect(isAutoPlaySettings({ ...DEFAULT_AUTO_PLAY, photoFxOn: 'gifs' })).toBe(false)
    // Settings saved before photo effects and video options existed still load.
    const older: Record<string, unknown> = { ...DEFAULT_AUTO_PLAY }
    for (const k of ['photoFx', 'photoFxOn', 'videoStart', 'longBeats']) delete older[k]
    expect(isAutoPlaySettings(older)).toBe(true)
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
