import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BeatClock } from '@core/beat/beatClock'
import { TriggerScheduler, loopBeatsOf, type TriggerAction } from '@core/trigger/scheduler'
import { DEFAULT_KEY, DEFAULT_PLACEMENT } from '@shared/layers'
import { DEFAULT_PAD_CONFIG, isPadSpec, type PadSpec } from '@shared/pads'
import { MIN_TRIM_MS, isClipTrim, isMainRequest } from '@shared/protocol'
import { isPadConfig } from '@shared/set'
import { clampTrim, formatClipTime, trimFor } from '@shared/trim'
import { Library } from '../../src/main/library'

const FRAME = 1000 / 60

function spec(over: Partial<PadSpec> = {}): PadSpec {
  return {
    source: { kind: 'clip', clipId: 'v' },
    mode: 'toggle',
    quantize: 'beat',
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

/** A scheduler at 120 BPM (500 ms beats) over clips of known length (ms; null = still). */
function harness(lengths: Record<string, number | null> = { v: 10000 }) {
  const clock = new BeatClock(0, 120, 8)
  const lib = { ...lengths }
  const cued: { id: string; startMs: number }[] = []
  let r = 0.37
  const sched = new TriggerScheduler(
    {
      candidates: (s) => (s.kind === 'clip' ? [s.clipId] : []),
      prepare: () => {},
      durationMs: (id) => lib[id] ?? null,
      cue: (id, startMs) => cued.push({ id, startMs }),
    },
    () => ((r = (r * 9301 + 0.4927) % 1), r),
  )
  const log: { atMs: number; action: TriggerAction }[] = []
  let now = 0
  const runTo = (ms: number) => {
    for (; now <= ms; now += FRAME) {
      clock.update(now)
      for (const action of sched.update(now, FRAME, clock)) log.push({ atMs: now, action })
    }
  }
  const press = (s: PadSpec, padId = 'A1') => sched.press(padId, s, now, clock)
  return { clock, sched, log, runTo, press, cued, lib }
}

const ofType = <T extends TriggerAction['type']>(
  log: { atMs: number; action: TriggerAction }[],
  type: T,
) =>
  log.filter((l) => l.action.type === type) as {
    atMs: number
    action: Extract<TriggerAction, { type: T }>
  }[]

describe('clip trim', () => {
  it('is validated: in ≥ 0, out at least MIN_TRIM_MS after in, or null for the end', () => {
    expect(isClipTrim({ inMs: 0, outMs: null })).toBe(true)
    expect(isClipTrim({ inMs: 1500, outMs: 4000 })).toBe(true)
    expect(isClipTrim({ inMs: 1500, outMs: 1500 + MIN_TRIM_MS - 1 })).toBe(false)
    expect(isClipTrim({ inMs: -1, outMs: null })).toBe(false)
    expect(isClipTrim({ inMs: 0 })).toBe(false)
    expect(isClipTrim({ inMs: Number.NaN, outMs: null })).toBe(false)
  })

  it('editor ranges clamp to the clip, keep a minimum length, and store none when untrimmed', () => {
    expect(clampTrim(-50, 20000, 8000, 'in')).toEqual({ inMs: 0, outMs: 8000 })
    // Dragging in past out pushes it back to the minimum length.
    expect(clampTrim(5000, 5020, 8000, 'in')).toEqual({ inMs: 5020 - MIN_TRIM_MS, outMs: 5020 })
    expect(clampTrim(5000, 4000, 8000, 'out')).toEqual({ inMs: 5000, outMs: 5000 + MIN_TRIM_MS })
    expect(trimFor(0, 8000, 8000)).toBeNull()
    expect(trimFor(1000, 8000, 8000)).toEqual({ inMs: 1000, outMs: null })
    expect(trimFor(0, 6000, 8000)).toEqual({ inMs: 0, outMs: 6000 })
    expect(formatClipTime(63_450)).toBe('1:03.5')
    expect(formatClipTime(4_000)).toBe('0:04.0')
  })

  describe('in the library', () => {
    const dir = mkdtempSync(join(tmpdir(), 'veejus-trim-'))
    writeFileSync(join(dir, 'a.mp4'), 'x')
    writeFileSync(join(dir, 'b.gif'), 'x')
    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    it('is kept for videos only, and a whole-clip range is stored as none', async () => {
      const lib = new Library()
      await lib.importPaths([dir])
      const [video, gif] = ['a.mp4', 'b.gif'].map((n) => lib.list().find((c) => c.name === n)!)
      expect(video!.trim).toBeNull()
      lib.setMeta(video!.id, { trim: { inMs: 1000, outMs: 3000 } })
      expect(lib.get(video!.id)!.trim).toEqual({ inMs: 1000, outMs: 3000 })
      lib.setMeta(video!.id, { favorite: true })
      expect(lib.get(video!.id)!.trim).toEqual({ inMs: 1000, outMs: 3000 })
      lib.setMeta(video!.id, { trim: { inMs: 0, outMs: null } })
      expect(lib.get(video!.id)!.trim).toBeNull()
      lib.setMeta(gif!.id, { trim: { inMs: 1000, outMs: 3000 } })
      expect(lib.get(gif!.id)!.trim).toBeNull()
    })

    it('comes back when a set is loaded', async () => {
      const lib = new Library()
      const path = join(dir, 'a.mp4')
      const ids = await lib.load([
        { path, tags: [], favorite: false, trim: { inMs: 500, outMs: null } },
      ])
      expect(lib.get(ids.get(path)!)!.trim).toEqual({ inMs: 500, outMs: null })
    })

    it('travels in setClipMeta requests, validated', () => {
      const req = (trim: unknown) => isMainRequest({ type: 'setClipMeta', id: 'x', trim })
      expect(req({ inMs: 0, outMs: 900 })).toBe(true)
      expect(req(null)).toBe(true)
      expect(req({ inMs: 800, outMs: 820 })).toBe(false)
    })
  })
})

describe('pad start spots and beat loops', () => {
  it('older pads without the new fields still load; bad values are refused', () => {
    const older: Record<string, unknown> = { ...DEFAULT_PAD_CONFIG, source: null }
    delete older.startAt
    delete older.loopBeats
    expect(isPadConfig(older)).toBe(true)
    expect(isPadConfig({ ...DEFAULT_PAD_CONFIG, source: null, startAt: 'random' })).toBe(true)
    expect(isPadConfig({ ...DEFAULT_PAD_CONFIG, source: null, loopBeats: 3 })).toBe(false)
    expect(isPadConfig({ ...DEFAULT_PAD_CONFIG, source: null, startAt: 'middle' })).toBe(false)
    expect(isPadSpec(spec({ startAt: 'random', loopBeats: 0.5 }))).toBe(true)
    expect(isPadSpec(spec({ loopBeats: 5 }))).toBe(false)
  })

  it('a random start lands inside the clip, leaving room for the loop, and is cued at press', () => {
    const h = harness({ v: 10000 })
    h.press(spec({ startAt: 'random', loopBeats: 2 }))
    expect(h.cued).toHaveLength(1)
    h.runTo(1000)
    const [s] = ofType(h.log, 'start')
    expect(s!.action.startMs).toBe(h.cued[0]!.startMs)
    expect(s!.action.startMs).toBeGreaterThan(0)
    // Room for 2 beats (1000 ms) before the end.
    expect(s!.action.startMs).toBeLessThanOrEqual(9000)
  })

  it('a beat loop jumps back to the same spot every N beats', () => {
    const h = harness({ v: 10000 })
    h.press(spec({ startAt: 'random', loopBeats: 1 }))
    h.runTo(4000)
    const [s] = ofType(h.log, 'start')
    const restarts = ofType(h.log, 'restart')
    expect(restarts.length).toBeGreaterThanOrEqual(6)
    for (const r of restarts) expect(r.action.startMs).toBe(s!.action.startMs)
    const gaps = restarts.map((r, i) => r.atMs - (i ? restarts[i - 1]! : s!).atMs)
    for (const g of gaps) expect(Math.abs(g - 500)).toBeLessThanOrEqual(FRAME)
  })

  it('a beat loop from the beginning restarts at 0; one-shot and retrigger ignore it', () => {
    const h = harness({ v: 10000 })
    h.press(spec({ loopBeats: 2 }))
    h.runTo(3000)
    const restarts = ofType(h.log, 'restart')
    expect(restarts.length).toBeGreaterThanOrEqual(2)
    for (const r of restarts) expect(r.action.startMs ?? 0).toBe(0)

    expect(loopBeatsOf(spec({ mode: 'oneShot', loopBeats: 2 }))).toBeNull()
    expect(loopBeatsOf(spec({ mode: 'retrigger', loopBeats: 2 }))).toBeNull()
    expect(loopBeatsOf(spec({ mode: 'hold', loopBeats: 2 }))).toBe(2)
    const k = harness({ v: 10000 })
    k.press(spec({ mode: 'oneShot', loopBeats: 1 }))
    k.runTo(3000)
    expect(ofType(k.log, 'restart')).toEqual([])
  })

  it('retrigger with a random start picks a new spot each time', () => {
    const h = harness({ v: 20000 })
    h.press(spec({ mode: 'retrigger', retriggerEvery: 'beat', startAt: 'random' }))
    h.runTo(4000)
    const spots = ofType(h.log, 'restart').map((r) => r.action.startMs ?? 0)
    expect(spots.length).toBeGreaterThanOrEqual(6)
    expect(new Set(spots).size).toBeGreaterThan(spots.length / 2)
    for (const ms of spots) expect(ms).toBeLessThanOrEqual(20000 - 500)
  })

  it('starts at the top when tempo-synced, for stills, or before the clip has loaded', () => {
    const h = harness({ v: 10000, still: null, cold: null })
    h.press(spec({ startAt: 'random', syncBeats: 4 }), 'A1')
    h.press(spec({ startAt: 'random', source: { kind: 'clip', clipId: 'still' } }), 'A2')
    h.press(spec({ startAt: 'random', source: { kind: 'clip', clipId: 'cold' } }), 'A3')
    h.runTo(1000)
    expect(h.cued).toEqual([])
    for (const s of ofType(h.log, 'start')) expect(s.action.startMs ?? 0).toBe(0)
  })

  it('a pad that was cold when pressed picks its spot when it fires, if loaded by then', () => {
    const h = harness({ v: null })
    h.press(spec({ startAt: 'random', quantize: 'bar' }))
    expect(h.cued).toEqual([])
    h.lib.v = 30000
    h.runTo(2100)
    const [s] = ofType(h.log, 'start')
    expect(s!.action.startMs).toBeGreaterThan(0)
  })
})
