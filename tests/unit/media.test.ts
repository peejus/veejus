import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fitRect } from '@core/fit'
import { parseRange } from '@shared/httpRange'
import { clipUrl, extensionOf, mediaTypeFor } from '@shared/mediaTypes'
import { isControlToOutput, isLayerSettings, isOutputToControl } from '@shared/protocol'
import { clipIdForPath, Library } from '../../src/main/library'

describe('mediaTypes', () => {
  it('classifies supported extensions case-insensitively', () => {
    expect(mediaTypeFor('C:\\clips\\Air Horn.MP4')).toEqual({ kind: 'video', mime: 'video/mp4' })
    expect(mediaTypeFor('/x/alpha.webm')?.kind).toBe('video')
    expect(mediaTypeFor('/x/dance.gif')).toEqual({ kind: 'image', mime: 'image/gif' })
    expect(mediaTypeFor('/x/a.webp')?.kind).toBe('image')
    expect(mediaTypeFor('/x/a.jpeg')?.mime).toBe('image/jpeg')
  })

  it('rejects unsupported or extensionless files', () => {
    expect(mediaTypeFor('/x/notes.txt')).toBeNull()
    expect(mediaTypeFor('/x/README')).toBeNull()
    expect(mediaTypeFor('/x/.gif')).toBeNull()
    expect(extensionOf('/a.b/c')).toBe('')
  })

  it('builds clip URLs', () => {
    expect(clipUrl('abc123')).toBe('veejus-media://clip/abc123')
  })
})

describe('parseRange', () => {
  it('returns null without a usable header', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('items=0-1', 100)).toBeNull()
    expect(parseRange('bytes=-', 100)).toBeNull()
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
  })

  it('parses open, closed and suffix ranges', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-30', 100)).toEqual({ start: 70, end: 99 })
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
  })

  it('flags unsatisfiable ranges', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
  })
})

describe('fitRect', () => {
  // 16:9 clip into a 4:3 target, and a 4:3 clip into 16:9.
  it('contain letterboxes inside the target', () => {
    expect(fitRect(1600, 900, 800, 600, 'contain')).toEqual({ x: 0, y: 75, w: 800, h: 450 })
    expect(fitRect(400, 300, 1600, 900, 'contain')).toEqual({ x: 200, y: 0, w: 1200, h: 900 })
  })

  it('cover fills the target and crops', () => {
    const r = fitRect(1600, 900, 800, 600, 'cover')
    expect(r.h).toBe(600)
    expect(r.w).toBeCloseTo(1066.67, 1)
    expect(r.x).toBeCloseTo(-133.33, 1)
    expect(r.y).toBe(0)
  })

  it('stretch fills exactly; original centers at native size', () => {
    expect(fitRect(10, 10, 800, 600, 'stretch')).toEqual({ x: 0, y: 0, w: 800, h: 600 })
    expect(fitRect(200, 100, 800, 600, 'original')).toEqual({ x: 300, y: 250, w: 200, h: 100 })
  })

  it('returns an empty rect for empty sizes', () => {
    expect(fitRect(0, 100, 800, 600, 'contain')).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
})

describe('layer/clip message guards', () => {
  const settings = { loop: true, speed: 1, fit: 'contain' }

  it('validates layer settings', () => {
    expect(isLayerSettings(settings)).toBe(true)
    expect(isLayerSettings({ ...settings, speed: 0 })).toBe(false)
    expect(isLayerSettings({ ...settings, speed: 10 })).toBe(false)
    expect(isLayerSettings({ ...settings, fit: 'zoom' })).toBe(false)
    expect(isLayerSettings({ ...settings, loop: 'yes' })).toBe(false)
  })

  it('validates clip messages in both directions', () => {
    expect(isControlToOutput({ type: 'playClip', id: 'a1', settings })).toBe(true)
    expect(isControlToOutput({ type: 'playClip', id: '', settings })).toBe(false)
    expect(isControlToOutput({ type: 'stopClip' })).toBe(true)
    expect(isOutputToControl({ type: 'clipState', id: 'a1', state: 'ready' })).toBe(true)
    expect(isOutputToControl({ type: 'clipState', id: 'a1', state: 'error', error: 'x' })).toBe(
      true,
    )
    expect(isOutputToControl({ type: 'clipState', id: 'a1', state: 'warm' })).toBe(false)
    expect(isOutputToControl({ type: 'clipStarted', id: 'a1', waitFrames: 1 })).toBe(true)
  })
})

describe('Library', () => {
  const dir = mkdtempSync(join(tmpdir(), 'veejus-lib-'))
  mkdirSync(join(dir, 'sub', 'deeper'), { recursive: true })
  for (const f of ['clip10.mp4', 'clip2.mp4', 'dance.gif', 'notes.txt', '.hidden.gif']) {
    writeFileSync(join(dir, f), 'x')
  }
  writeFileSync(join(dir, 'sub', 'horn.webm'), 'xy')
  writeFileSync(join(dir, 'sub', 'deeper', 'boom.png'), 'xyz')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('imports a folder recursively, skipping unsupported and hidden files', async () => {
    const lib = new Library()
    const result = await lib.importPaths([dir])
    expect(result).toEqual({ added: 5, skipped: 1 })
    // Natural sort within each folder: clip2 before clip10. Subfolders come in name order.
    expect(lib.list().map((c) => c.name)).toEqual([
      'clip2.mp4',
      'clip10.mp4',
      'dance.gif',
      'boom.png',
      'horn.webm',
    ])
    const horn = lib.list().find((c) => c.name === 'horn.webm')!
    expect(horn).toMatchObject({ kind: 'video', mime: 'video/webm', sizeBytes: 2 })
    expect(horn.url).toBe(clipUrl(horn.id))
    expect(lib.pathFor(horn.id)).toBe(join(dir, 'sub', 'horn.webm'))
  })

  it('does not import the same file twice', async () => {
    const lib = new Library()
    await lib.importPaths([dir])
    const again = await lib.importPaths([join(dir, 'dance.gif'), dir])
    expect(again.added).toBe(0)
    expect(lib.list()).toHaveLength(5)
  })

  it('skips missing paths and removes clips by id', async () => {
    const lib = new Library()
    const r = await lib.importPaths([join(dir, 'nope.mp4'), join(dir, 'dance.gif')])
    expect(r).toEqual({ added: 1, skipped: 1 })
    const id = lib.list()[0]!.id
    expect(lib.remove([id, 'unknown'])).toBe(1)
    expect(lib.list()).toHaveLength(0)
  })

  it('derives stable ids from paths', () => {
    expect(clipIdForPath(join(dir, 'a.gif'))).toBe(clipIdForPath(join(dir, 'a.gif')))
    expect(clipIdForPath(join(dir, 'a.gif'))).not.toBe(clipIdForPath(join(dir, 'b.gif')))
    expect(clipIdForPath(join(dir, 'a.gif'))).toMatch(/^[0-9a-f]{16}$/)
  })
})
