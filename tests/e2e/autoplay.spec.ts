import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { FIXTURES, importPaths, launchApp, readOutput, type AppHandles } from './helpers'

/**
 * Auto-play: one button steps through the images and GIFs on the beat. The clock is locked at
 * 120 BPM (500 ms beats) so step timing is exact.
 */

let h: AppHandles
const IMAGES = ['bounce.png', 'half-alpha-still.png', 'half-alpha.gif', 'photo.jpg', 'wave.webp']

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  h = await launchApp()
})

test.afterAll(async () => {
  await h?.app.close()
})

const button = () => h.control.getByTestId('auto-play-button')
const focusBody = (page: Page) => page.locator('body').click({ position: { x: 5, y: 5 } })

async function autoStarts() {
  const s = await readOutput(h.output)
  return s.trigger.recentActions.filter((a) => a.type === 'start' && a.padId === 'auto')
}

async function clipNames(): Promise<Map<string, string>> {
  const clips = await h.control.evaluate(() =>
    (
      globalThis as unknown as {
        veejus: { request(r: unknown): Promise<{ clips: { id: string; name: string }[] }> }
      }
    ).veejus.request({ type: 'getLibrary' }),
  )
  return new Map(clips.clips.map((c) => [c.id, c.name]))
}

test('an empty library offers a one-click start, which goes once clips are in', async () => {
  const card = h.control.getByTestId('quick-start')
  await expect(card).toBeVisible()
  await expect(card.getByRole('button', { name: 'Choose images, GIFs & videos…' })).toBeVisible()
  await expect(button()).toHaveAttribute('aria-pressed', 'false')

  await importPaths(h.control, [join(FIXTURES, 'media')])
  await expect(card).toHaveCount(0)
  await h.control.getByLabel('Type BPM').fill('120')
  await h.control.getByLabel('Type BPM').press('Enter')
  await expect(h.control.getByTestId('bpm-value')).toHaveText('120.0')
})

test('one button steps through the images and GIFs on the beat', async () => {
  // Everything is the default source; pick Images & GIFs for this one.
  await h.control.getByRole('button', { name: 'Auto-play settings' }).click()
  await h.control.getByTestId('auto-panel').getByLabel('Auto-play source').selectOption('images')
  await h.control.getByRole('button', { name: 'Auto-play settings' }).click()
  await button().click()
  await expect(button()).toHaveAttribute('aria-pressed', 'true')
  // Five steps or so (stills hold a bar = 2 s; GIFs their own length).
  await expect.poll(async () => (await autoStarts()).length, { timeout: 15_000 }).toBeGreaterThan(3)
  const names = await clipNames()
  const starts = await autoStarts()
  for (const a of starts) {
    // Only images and GIFs, never the videos.
    expect(IMAGES.concat('corrupt.gif')).toContain(names.get(a.clipId!))
    // Each change lands on a beat, within a frame (2 beats per second at 120 BPM).
    expect(Math.abs(a.startPos! - Math.round(a.startPos!))).toBeLessThan(1e-6)
    expect(Math.abs(a.posAtFire - a.startPos!)).toBeLessThan((2 * 1000) / 60 / 1000 + 0.02)
  }
  // In library order, so consecutive steps differ.
  for (let i = 1; i < starts.length; i++) expect(starts[i]!.clipId).not.toBe(starts[i - 1]!.clipId)

  const out = await readOutput(h.output)
  expect(out.layers.background.owner).toBe('auto')
  expect(out.trigger.state.auto.enabled).toBe(true)
  // Pads don't light up for it.
  expect(out.trigger.state.pads).not.toHaveProperty('auto')
})

test('the settings panel shows what is up and next, and the step can change', async () => {
  await h.control.getByRole('button', { name: 'Auto-play settings' }).click()
  const panel = h.control.getByTestId('auto-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByLabel('Auto-play source')).toContainText('Images & GIFs (6)')
  const names = await clipNames()
  await expect
    .poll(async () => {
      const now = await h.control.getByTestId('auto-now').textContent()
      const id = (await readOutput(h.output)).layers.background.clipId
      return id !== null && now === names.get(id)
    })
    .toBe(true)
  await expect(h.control.getByTestId('auto-next')).toContainText(/in \d beats?/)

  await expect(panel.getByLabel('Auto-play source')).toContainText('Videos (')
  await panel.getByLabel('Auto-play step').selectOption('1')
  const before = (await autoStarts()).length
  await expect
    .poll(async () => (await autoStarts()).length, { timeout: 10_000 })
    .toBeGreaterThan(before + 4)
  const recent = (await autoStarts()).slice(-4)
  for (let i = 1; i < recent.length; i++)
    expect(recent[i]!.startPos! - recent[i - 1]!.startPos!).toBeCloseTo(1, 5)

  // Settings travel with the set.
  const saved = await h.control.evaluate(() =>
    (
      globalThis as unknown as { __veejusSet: { current(): { autoPlay?: { step: unknown } } } }
    ).__veejusSet.current(),
  )
  expect(saved.autoPlay?.step).toBe(1)
})

test('P toggles it, and Esc (stop everything) switches it off too', async () => {
  await focusBody(h.control)
  await h.control.keyboard.press('p')
  await expect(button()).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => (await readOutput(h.output)).layers.background.owner).toBeNull()

  await h.control.keyboard.press('p')
  await expect(button()).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await readOutput(h.output)).layers.background.owner).toBe('auto')

  await h.control.keyboard.press('Escape')
  await expect(button()).toHaveAttribute('aria-pressed', 'false')
  const s = await readOutput(h.output)
  expect(s.trigger.state.auto.enabled).toBe(false)
  expect(s.layers.background.clipId).toBeNull()
})

test('videos play at normal speed from a random spot, cued ahead, on the beat', async () => {
  const names = await clipNames()
  const videoIds = [...names].filter(([, n]) => n === 'countdown.mp4' || n === 'alpha-ball.webm')
  expect(videoIds.length).toBe(2)
  const panel = h.control.getByTestId('auto-panel')
  if (!(await panel.isVisible()))
    await h.control.getByRole('button', { name: 'Auto-play settings' }).click()
  await expect(panel).toBeVisible()
  await panel.getByLabel('Auto-play source').selectOption('videos')
  // One beat each (500 ms) of 2 s videos: each starts somewhere in its first 1.5 s.
  await panel.getByLabel('Auto-play step').selectOption('1')
  await panel.getByLabel('Auto-play video start').selectOption('random')
  const before = (await autoStarts()).length
  await button().click()
  await expect(button()).toHaveAttribute('aria-pressed', 'true')

  // Watch the layer: once a video is up, it plays at 1× near where it was asked to start.
  const seen: { startMs: number; videoTime: number; rate: number | null }[] = []
  await expect
    .poll(
      async () => {
        const out = await readOutput(h.output)
        const last = out.trigger.recentActions.filter((a) => a.padId === 'auto').at(-1)
        const bg = out.layers.background
        if (last?.type === 'start' && bg.clipId === last.clipId && bg.videoTime !== null)
          seen.push({ startMs: last.startMs ?? 0, videoTime: bg.videoTime, rate: bg.playbackRate })
        return (await autoStarts()).length - before
      },
      { timeout: 10_000, intervals: [70] },
    )
    .toBeGreaterThan(5)
  expect(seen.length).toBeGreaterThan(8)
  for (const x of seen) {
    expect(x.rate).toBe(1)
    // Within a beat (500 ms) of the start spot; the frames are a beat long.
    expect(x.videoTime * 1000).toBeGreaterThanOrEqual(x.startMs - 50)
    expect(x.videoTime * 1000).toBeLessThan(x.startMs + 600)
  }
  const starts = (await autoStarts()).slice(before)
  expect(starts.length).toBeGreaterThan(3)
  for (const a of starts) {
    expect(videoIds.map(([id]) => id)).toContain(a.clipId)
    expect(a.syncBeats).toBeNull()
    expect(a.startMs ?? 0).toBeLessThanOrEqual(1500)
    expect(Math.abs(a.startPos! - Math.round(a.startPos!))).toBeLessThan(1e-6)
    expect(Math.abs(a.posAtFire - a.startPos!)).toBeLessThan((2 * 1000) / 60 / 1000 + 0.02)
  }
  // Random spots, not all from the top.
  expect(starts.filter((a) => (a.startMs ?? 0) > 0).length).toBeGreaterThan(starts.length / 2)
  await button().click()
  await expect(button()).toHaveAttribute('aria-pressed', 'false')
})
