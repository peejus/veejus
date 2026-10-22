import { describe, expect, it } from 'vitest'
import { DEGRADE_AFTER_MS, MAX_LEVEL, RECOVER_AFTER_MS, Watchdog } from '@core/watchdog'
import { pictureLayout } from '@shared/output'
import {
  SET_FORMAT,
  SET_VERSION,
  checkSet,
  missingPadClips,
  remapPadClips,
  setFingerprint,
  type VeejusSet,
} from '@shared/set'
import { DEFAULT_PAD_CONFIG, DEFAULT_TRIGGER_SETTINGS, type PadConfig } from '@shared/pads'
import { DEFAULT_LAYERS_CONFIG, DEFAULT_MASTER } from '@shared/layers'
import { emptyFxConfig } from '@shared/fx'
import { DEFAULT_BEAT_SETTINGS } from '@shared/beat'
import { DEFAULT_MIDI_SETTINGS } from '@shared/midi'
import { DEFAULT_ANALYSIS_SETTINGS } from '@shared/audio'
import { DEFAULT_OUTPUT_OPTIONS } from '@shared/output'
import { isPadSource } from '@shared/pads'

const emptyPad = (): PadConfig => ({ ...DEFAULT_PAD_CONFIG, source: null })

function makeSet(): VeejusSet {
  const banks = Array.from({ length: 4 }, () => Array.from({ length: 32 }, emptyPad))
  banks[0]![0] = { ...emptyPad(), source: { kind: 'clip', clipId: 'aaaa' } }
  banks[1]![3] = { ...emptyPad(), source: { kind: 'clip', clipId: 'bbbb' }, mode: 'toggle' }
  banks[2]![5] = { ...emptyPad(), source: { kind: 'collection', tag: 'Air Horns' } }
  return {
    format: SET_FORMAT,
    version: SET_VERSION,
    savedAt: '2026-10-21T10:00:00.000Z',
    clips: [
      {
        id: 'aaaa',
        name: 'a.gif',
        path: 'C:/v/a.gif',
        relPath: 'v/a.gif',
        tags: ['Air Horns'],
        favorite: true,
      },
      { id: 'bbbb', name: 'b.mp4', path: 'C:/v/b.mp4', relPath: null, tags: [], favorite: false },
    ],
    pads: { banks, settings: DEFAULT_TRIGGER_SETTINGS, bank: 1 },
    layers: DEFAULT_LAYERS_CONFIG,
    master: DEFAULT_MASTER,
    fx: emptyFxConfig(),
    beat: DEFAULT_BEAT_SETTINGS,
    midi: DEFAULT_MIDI_SETTINGS,
    background: '#ff2bd6',
    libraryPlay: { loop: true, speed: 1, fit: 'contain' },
    audio: { source: { kind: 'test', bpm: 124 }, settings: DEFAULT_ANALYSIS_SETTINGS },
    output: DEFAULT_OUTPUT_OPTIONS,
  }
}

describe('set files', () => {
  it('a full set validates, survives a JSON round trip, and fingerprints ignore the save time', () => {
    const s = makeSet()
    const back = JSON.parse(JSON.stringify(s)) as unknown
    const check = checkSet(back)
    expect(check.ok).toBe(true)
    expect(setFingerprint({ ...s, savedAt: 'later' })).toBe(setFingerprint(s))
    expect(setFingerprint({ ...s, background: '#000000' })).not.toBe(setFingerprint(s))
  })

  it('rejects other files, other versions and damaged parts, saying why', () => {
    expect(checkSet({ hello: 1 })).toEqual({ ok: false, reason: 'Not a Veejus set file' })
    const newer = { ...makeSet(), version: 2 }
    const r = checkSet(newer)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('newer version')
    const bad = makeSet()
    ;(bad.pads.banks[0] as unknown[]).pop()
    const r2 = checkSet(bad)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toContain('pads')
    expect(checkSet({ ...makeSet(), background: 'red' }).ok).toBe(false)
  })

  it('remaps moved clips in pads and lists the ones still missing', () => {
    const s = makeSet()
    const banks = remapPadClips(s.pads.banks, { aaaa: 'cccc' })
    expect(banks[0]![0]!.source).toEqual({ kind: 'clip', clipId: 'cccc' })
    expect(banks[1]![3]!.source).toEqual({ kind: 'clip', clipId: 'bbbb' })
    expect(banks[1]![3]!.mode).toBe('toggle')
    expect(missingPadClips(banks, new Set(['cccc']))).toEqual(['bbbb'])
  })

  it('collections and favorites are pad sources', () => {
    expect(isPadSource({ kind: 'collection', tag: 'Drops' })).toBe(true)
    expect(isPadSource({ kind: 'collection', tag: ' padded ' })).toBe(false)
    expect(isPadSource({ kind: 'favorites' })).toBe(true)
  })
})

describe('picture layout (letterbox and resolution)', () => {
  it('fill uses the whole window at native resolution', () => {
    expect(pictureLayout(1920, 1080, { aspect: 'fill', resolution: 'native' })).toEqual({
      viewport: { x: 0, y: 0, width: 1920, height: 1080 },
      render: { width: 1920, height: 1080 },
    })
  })

  it('letterboxes and pillarboxes to the chosen shape, centered', () => {
    expect(pictureLayout(1920, 1080, { aspect: '4:3', resolution: 'native' }).viewport).toEqual({
      x: 240,
      y: 0,
      width: 1440,
      height: 1080,
    })
    expect(pictureLayout(1080, 1920, { aspect: '16:9', resolution: 'native' }).viewport).toEqual({
      x: 0,
      y: 656,
      width: 1080,
      height: 608,
    })
  })

  it('caps the render size but never upscales it', () => {
    expect(pictureLayout(3840, 2160, { aspect: 'fill', resolution: '1080p' }).render).toEqual({
      width: 1920,
      height: 1080,
    })
    expect(pictureLayout(1280, 720, { aspect: 'fill', resolution: '1080p' }).render).toEqual({
      width: 1280,
      height: 720,
    })
    expect(pictureLayout(1080, 1920, { aspect: '9:16', resolution: '720p' }).render).toEqual({
      width: 720,
      height: 1280,
    })
  })
})

describe('frame-drop watchdog', () => {
  it('steps down one level per sustained slump, never past the last level', () => {
    const w = new Watchdog()
    let t = 0
    const run = (fps: number, ms: number) => {
      const changes: number[] = []
      for (const end = t + ms; t < end; t += 100) {
        const c = w.update(fps, t)
        if (c !== null) changes.push(c)
      }
      return changes
    }
    expect(run(45, DEGRADE_AFTER_MS - 200)).toEqual([])
    expect(run(45, 400)).toEqual([1])
    expect(run(45, DEGRADE_AFTER_MS * 4)).toEqual([2, 3])
    expect(w.level).toBe(MAX_LEVEL)
    // A brief recovery doesn't step back up; a sustained one does, one level at a time.
    expect(run(60, RECOVER_AFTER_MS - 500)).toEqual([])
    expect(run(60, 1000)).toEqual([2])
    expect(run(60, RECOVER_AFTER_MS * 2 + 100)).toEqual([1, 0])
  })

  it('ignores short dips and the in-between zone', () => {
    const w = new Watchdog()
    let t = 0
    for (let i = 0; i < 300; i++, t += 100) {
      // 2 s low, 1 s at 55 fps (neither low nor good), repeat: never 3 s of continuous low.
      const fps = i % 30 < 20 ? 40 : 55
      expect(w.update(fps, t)).toBeNull()
    }
    expect(w.level).toBe(0)
  })
})
