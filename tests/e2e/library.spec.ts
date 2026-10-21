import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { fitRect } from '../../src/core/fit'
import {
  FIXTURES,
  closeSetup,
  openSetup,
  importPaths,
  launchApp,
  near,
  pad,
  readOutput,
  samplePixel,
  type AppHandles,
} from './helpers'

const PINK = [255, 0x2b, 0xd6] as const
const MEDIA = join(FIXTURES, 'media')
const PLAYABLE = [
  'alpha-ball.webm',
  'bounce.png',
  'countdown.mp4',
  'half-alpha-still.png',
  'half-alpha.gif',
  'photo.jpg',
  'wave.webp',
]
const BROKEN = ['corrupt.gif', 'corrupt.mp4', 'prores.mov']

let h: AppHandles

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  h = await launchApp()
  await openSetup(h.control, 'Output')
  await h.control.getByTestId('swatch-ff2bd6').click()
  await closeSetup(h.control)
})

test.afterAll(async () => {
  await h?.app.close()
})

async function play(name: string) {
  await pad(h.control, name).click()
  await h.control.getByRole('button', { name: `Play ${name} on Background` }).click()
  await expect
    .poll(async () => {
      const cur = (await readOutput(h.output)).current
      return cur?.started ? cur.id : null
    })
    .toBe(await pad(h.control, name).getAttribute('data-clip-id'))
}

test('imports a folder, skipping non-media files', async () => {
  const res = await importPaths(h.control, [MEDIA])
  expect(res).toEqual({ type: 'imported', result: { added: 10, skipped: 1 } })
  await expect(h.control.getByTestId('clip-count')).toHaveText('10')
  await expect(h.control.getByTestId('pad')).toHaveCount(10)
})

test('importing the same folder again adds nothing', async () => {
  const res = await importPaths(h.control, [MEDIA])
  expect(res).toEqual({ type: 'imported', result: { added: 0, skipped: 11 } })
  await expect(h.control.getByTestId('pad')).toHaveCount(10)
})

test('playable clips get thumbnails and become ready on the output', async () => {
  for (const name of PLAYABLE) {
    await expect(pad(h.control, name)).toHaveAttribute('data-state', 'ready', { timeout: 15_000 })
    await expect(pad(h.control, name).locator('img')).toHaveAttribute('src', /^blob:/)
  }
  await expect(pad(h.control, 'countdown.mp4')).toContainText('2.0s · 320×180')
  await expect(pad(h.control, 'half-alpha.gif')).toContainText('10 fr · 160×120')
  await expect(pad(h.control, 'half-alpha.gif').locator('.badge.alpha')).toBeVisible()
  await expect(pad(h.control, 'countdown.mp4').locator('.badge.alpha')).toHaveCount(0)
})

test('corrupt and unsupported files show an error instead of crashing', async () => {
  for (const name of BROKEN) {
    await expect(pad(h.control, name)).toHaveAttribute('data-state', 'error', { timeout: 15_000 })
    await expect(pad(h.control, name).locator('.pad-error')).not.toBeEmpty()
  }
  // Double-clicking a broken pad does nothing; the app keeps rendering.
  const before = (await readOutput(h.output)).frameCount
  await pad(h.control, 'corrupt.mp4').dblclick()
  await expect.poll(async () => (await readOutput(h.output)).frameCount).toBeGreaterThan(before + 5)
  expect((await readOutput(h.output)).current).toBeNull()
})

test('a ready video starts within one frame and plays', async () => {
  await play('countdown.mp4')
  await expect(h.control.getByTestId('start-latency')).toContainText(/^Last start: [01] frame/)
  await expect(h.control.getByTestId('now-playing')).toHaveText('countdown.mp4')
  await expect(pad(h.control, 'countdown.mp4')).toHaveClass(/playing/)
  await expect
    .poll(async () => (await readOutput(h.output)).current?.videoTime ?? 0)
    .toBeGreaterThan(0.3)
})

test('each ready clip type starts within one frame', async () => {
  for (const name of PLAYABLE) {
    await play(name)
    await expect(h.control.getByTestId('start-latency')).toContainText(/^Last start: [01] frame/)
  }
})

test('animated images advance frames', async () => {
  await play('wave.webp')
  const seen = new Set<number>()
  await expect
    .poll(async () => {
      seen.add((await readOutput(h.output)).current?.imageFrame ?? -1)
      return seen.size
    })
    .toBeGreaterThan(3)
})

test('transparent pixels show the background; opaque pixels show the clip', async () => {
  await play('half-alpha-still.png')
  const { canvas } = await readOutput(h.output)
  const r = fitRect(64, 64, canvas.width, canvas.height, 'contain')
  const fy = (r.y + r.h / 2) / canvas.height
  const leftOfClip = (r.x + r.w * 0.25) / canvas.width
  const rightOfClip = (r.x + r.w * 0.75) / canvas.width
  expect(near(await samplePixel(h.output, leftOfClip, fy), [255, 0, 0])).toBe(true)
  expect(near(await samplePixel(h.output, rightOfClip, fy), PINK)).toBe(true)

  await play('half-alpha.gif')
  const g = fitRect(160, 120, canvas.width, canvas.height, 'contain')
  const gifRight = (g.x + g.w * 0.8) / canvas.width
  expect(near(await samplePixel(h.output, gifRight, 0.5), PINK)).toBe(true)
})

test('fit mode changes how the clip fills the output', async () => {
  await play('photo.jpg') // 4:3 photo in a wider output window
  const edge = [0.01, 0.5] as const
  expect(near(await samplePixel(h.output, ...edge), PINK)).toBe(true)
  await h.control.getByLabel('Fit').selectOption('cover')
  await expect.poll(async () => (await readOutput(h.output)).settings.fit).toBe('cover')
  expect(near(await samplePixel(h.output, ...edge), PINK)).toBe(false)
  await h.control.getByLabel('Fit').selectOption('stretch')
  expect(near(await samplePixel(h.output, ...edge), PINK)).toBe(false)
  await h.control.getByLabel('Fit').selectOption('contain')
  await expect.poll(async () => (await readOutput(h.output)).settings.fit).toBe('contain')
})

test('speed changes apply live', async () => {
  await play('countdown.mp4')
  await h.control.getByLabel('Speed').fill('1') // log2 scale: 2^1 = 2x
  await expect(h.control.getByTestId('speed-value')).toHaveText('2.00×')
  await expect.poll(async () => (await readOutput(h.output)).settings.speed).toBe(2)
  const t0 = (await readOutput(h.output)).current!.videoTime!
  await h.output.waitForTimeout(500)
  const t1 = (await readOutput(h.output)).current!.videoTime!
  // 500 ms of wall time at 2x is ~1 s of clip time (allowing for a loop wrap at 2 s).
  const advanced = t1 >= t0 ? t1 - t0 : t1 + 2 - t0
  expect(advanced).toBeGreaterThan(0.75)
  await h.control.getByRole('button', { name: '1×' }).click()
  await expect.poll(async () => (await readOutput(h.output)).settings.speed).toBe(1)
})

test('one-shot clips play once and then clear the layer', async () => {
  await h.control.getByRole('button', { name: 'One-shot' }).click()
  await play('wave.webp') // 1 s long
  await expect(h.control.getByTestId('now-playing')).toHaveText('Nothing', { timeout: 3000 })
  expect((await readOutput(h.output)).current).toBeNull()
  await h.control.getByRole('button', { name: 'Loop' }).click()
})

test('looping clips keep playing past their length', async () => {
  await play('wave.webp')
  await h.output.waitForTimeout(1500)
  expect((await readOutput(h.output)).current?.started).toBe(true)
})

test('stop clears the layer', async () => {
  await h.control.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(h.control.getByTestId('now-playing')).toHaveText('Nothing')
  expect((await readOutput(h.output)).current).toBeNull()
  expect(near(await samplePixel(h.output, 0.5, 0.5), PINK)).toBe(true)
})

test('removing a clip removes its pad and output state', async () => {
  const id = (await pad(h.control, 'photo.jpg').getAttribute('data-clip-id'))!
  await pad(h.control, 'photo.jpg').hover()
  await h.control.getByRole('button', { name: 'Remove photo.jpg' }).click()
  await expect(h.control.getByTestId('pad')).toHaveCount(9)
  await expect.poll(async () => id in (await readOutput(h.output)).clipStates).toBe(false)
})

test('hovering a pad shows a live preview', async () => {
  await pad(h.control, 'half-alpha.gif').hover()
  const img = pad(h.control, 'half-alpha.gif').locator('img')
  await expect(img).toHaveAttribute('src', /^veejus-media:\/\/clip\//)
  await expect
    .poll(() => img.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth))
    .toBe(160)

  await pad(h.control, 'countdown.mp4').hover()
  const video = pad(h.control, 'countdown.mp4').locator('video')
  await expect(video).toBeVisible()
  await expect
    .poll(() => video.evaluate((el) => (el as unknown as { currentTime: number }).currentTime))
    .toBeGreaterThan(0.2)
})

test('a single click only selects a clip; Play shows it', async () => {
  const stop = h.control.getByRole('button', { name: 'Stop', exact: true })
  if (await stop.isEnabled()) await stop.click()
  await expect.poll(async () => (await readOutput(h.output)).current).toBeNull()
  const tile = pad(h.control, 'bounce.png')
  await tile.click()
  await expect(tile).toHaveAttribute('aria-pressed', 'true')
  await h.output.waitForTimeout(300)
  expect((await readOutput(h.output)).current).toBeNull() // the show is untouched
  const id = await tile.getAttribute('data-clip-id')
  await h.control.getByRole('button', { name: 'Play bounce.png on Background' }).click()
  await expect.poll(async () => (await readOutput(h.output)).current?.id).toBe(id)
  // Selecting another clip moves the selection (and still doesn't change the show).
  await pad(h.control, 'wave.webp').click()
  await expect(tile).toHaveAttribute('aria-pressed', 'false')
  await expect(pad(h.control, 'wave.webp')).toHaveAttribute('aria-pressed', 'true')
  expect((await readOutput(h.output)).current?.id).toBe(id)
  // Double-click is the shortcut for Play.
  const wave = await pad(h.control, 'wave.webp').getAttribute('data-clip-id')
  await pad(h.control, 'wave.webp').dblclick()
  await expect.poll(async () => (await readOutput(h.output)).current?.id).toBe(wave)
})

test('clearing the library asks first and can be undone', async () => {
  const count = await h.control.getByTestId('pad').count()
  await h.control.getByRole('button', { name: 'Clear library…' }).click()
  await h.control.getByRole('button', { name: 'Cancel' }).click()
  await expect(h.control.getByTestId('pad')).toHaveCount(count)

  const id = await pad(h.control, 'bounce.png').getAttribute('data-clip-id')
  await h.control.getByRole('button', { name: 'Clear library…' }).click()
  await h.control.getByRole('button', { name: 'Remove all' }).click()
  await expect(h.control.getByTestId('pad')).toHaveCount(0)
  await h.control.getByRole('button', { name: 'Undo' }).click()
  await expect(h.control.getByTestId('pad')).toHaveCount(count)
  // Same file, same id: pad assignments survive the round trip.
  await expect(pad(h.control, 'bounce.png')).toHaveAttribute('data-clip-id', id!)
})
