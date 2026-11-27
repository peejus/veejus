import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Library } from '../../src/main/library'
import { PhotosDrop, assetIdFromPreview, isPhotosLibraryPath } from '../../src/main/photosDrop'

const root = mkdtempSync(join(tmpdir(), 'veejus-photosdrop-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ASSET = '86442640-EB9D-4E69-8B6D-D73F83996210'
const LIB = join(root, 'Photos Library.photoslibrary')
const PREVIEW = join(LIB, 'resources', 'derivatives', 'masters', '8', `${ASSET}_4_5005_c.jpeg`)

let n = 0
/** A fresh drop: a preview JPEG in a fake Photos library and an incoming folder for the movie. */
function setup() {
  const dir = join(root, `case-${n++}`)
  const videos = join(dir, 'From Photos')
  const incoming = join(dir, 'incoming')
  mkdirSync(join(LIB, 'resources', 'derivatives', 'masters', '8'), { recursive: true })
  writeFileSync(PREVIEW, 'jpeg')
  return { videos, incoming, drop: new PhotosDrop(videos) }
}

/** What Photos does when a promise is redeemed: write the movie into the token's folder. */
function writeMovie(incoming: string, token: string, name = 'IMG_3418.MOV'): string {
  mkdirSync(join(incoming, token), { recursive: true })
  const path = join(incoming, token, name)
  writeFileSync(path, `movie ${token}`)
  return path
}

describe('Photos drop helpers', () => {
  it('recognizes Photos library paths and asset ids', () => {
    expect(isPhotosLibraryPath(PREVIEW)).toBe(true)
    expect(isPhotosLibraryPath('/Users/me/Movies/clip.mov')).toBe(false)
    expect(assetIdFromPreview(PREVIEW)).toBe(ASSET)
    expect(assetIdFromPreview('/x/preview.jpeg')).toBeNull()
  })
})

describe('PhotosDrop', () => {
  it('swaps a dropped video preview for the movie Photos exports', async () => {
    const { videos, incoming, drop } = setup()
    drop.handle({
      type: 'promised',
      token: 't1',
      previewPath: PREVIEW,
      fileType: 'com.apple.quicktime-movie',
    })
    const resolving = drop.resolve([PREVIEW, '/Users/me/other.png'])
    drop.handle({ type: 'received', token: 't1', path: writeMovie(incoming, 't1') })

    const { paths, warnings } = await resolving
    const kept = join(videos, ASSET, 'IMG_3418.MOV')
    expect(paths).toEqual([kept, '/Users/me/other.png'])
    expect(warnings).toEqual([])
    expect(readFileSync(kept, 'utf8')).toBe('movie t1')
    expect(existsSync(join(incoming, 't1'))).toBe(false) // the temporary folder is cleaned up
  })

  it('imports the result as a video, not a still', async () => {
    const { incoming, drop } = setup()
    drop.handle({
      type: 'promised',
      token: 't2',
      previewPath: PREVIEW,
      fileType: 'com.apple.quicktime-movie',
    })
    drop.handle({ type: 'received', token: 't2', path: writeMovie(incoming, 't2') })
    const { paths } = await drop.resolve([PREVIEW])

    const library = new Library()
    expect(await library.importPaths(paths)).toEqual({ added: 1, skipped: 0 })
    const [clip] = library.list()
    expect(clip?.kind).toBe('video')
    expect(clip?.mime).toBe('video/quicktime')
  })

  it('reuses the kept movie when the same video is dropped again', async () => {
    const { videos, incoming, drop } = setup()
    drop.handle({ type: 'promised', token: 'a', previewPath: PREVIEW, fileType: 'public.mpeg-4' })
    drop.handle({ type: 'received', token: 'a', path: writeMovie(incoming, 'a', 'clip.mp4') })
    const first = await drop.resolve([PREVIEW])

    drop.handle({ type: 'promised', token: 'b', previewPath: PREVIEW, fileType: 'public.mpeg-4' })
    drop.handle({ type: 'received', token: 'b', path: writeMovie(incoming, 'b', 'clip.mp4') })
    const second = await drop.resolve([PREVIEW])

    expect(second.paths).toEqual(first.paths)
    expect(first.paths[0]).toBe(join(videos, ASSET, 'clip.mp4'))
    expect(existsSync(join(incoming, 'b'))).toBe(false)
  })

  it('reports a failed export instead of importing the still', async () => {
    const { drop } = setup()
    drop.handle({
      type: 'promised',
      token: 'f',
      previewPath: PREVIEW,
      fileType: 'com.apple.quicktime-movie',
    })
    drop.handle({ type: 'failed', token: 'f', error: 'The operation couldn’t be completed.' })
    const { paths, warnings } = await drop.resolve([PREVIEW])
    expect(paths).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/Couldn’t get a video from Photos/)
  })

  it('waits briefly for a drop reported after the import arrives', async () => {
    const { incoming, drop } = setup()
    const resolving = drop.resolve([PREVIEW])
    setTimeout(() => {
      drop.handle({
        type: 'promised',
        token: 'late',
        previewPath: PREVIEW,
        fileType: 'com.apple.quicktime-movie',
      })
      drop.handle({ type: 'received', token: 'late', path: writeMovie(incoming, 'late') })
    }, 50)
    const { paths } = await resolving
    expect(paths[0]).toMatch(/IMG_3418\.MOV$/)
  })

  it('passes photos from Photos through unchanged when no video was promised', async () => {
    const { drop } = setup()
    const still = join(LIB, 'resources', 'derivatives', 'masters', '8', 'PHOTO_1_105_c.jpeg')
    const started = Date.now()
    const { paths, warnings } = await drop.resolve([still, still.replace('PHOTO', 'PHOTO2')])
    expect(paths).toEqual([still, still.replace('PHOTO', 'PHOTO2')])
    expect(warnings).toEqual([])
    expect(Date.now() - started).toBeLessThan(2500) // one shared wait, not one per photo
  })
})
