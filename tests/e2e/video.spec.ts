import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { DEFAULT_KEY, DEFAULT_PLACEMENT } from '../../src/shared/layers'
import type { PadSpec } from '../../src/shared/pads'
import {
  FIXTURES,
  importPaths,
  launchApp,
  pad,
  readOutput,
  sendToOutput,
  showMoreSettings,
  type AppHandles,
} from './helpers'

/**
 * Video trim and pad video options. countdown.mp4 is 2 s long; it gets trimmed to 0.5–1.5 s.
 * The clock is set to 120 BPM (500 ms beats).
 */

let h: AppHandles
let clipId = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  h = await launchApp()
  await importPaths(h.control, [join(FIXTURES, 'media')])
  await h.control.getByLabel('Type BPM').fill('120')
  await h.control.getByLabel('Type BPM').press('Enter')
  await expect(h.control.getByTestId('bpm-value')).toHaveText('120.0')
  clipId = (await pad(h.control, 'countdown.mp4').getAttribute('data-clip-id'))!
})

test.afterAll(async () => {
  await h?.app.close()
})

async function libraryTrim(): Promise<unknown> {
  const lib = await h.control.evaluate(() =>
    (
      globalThis as unknown as {
        veejus: { request(r: unknown): Promise<{ clips: { id: string; trim: unknown }[] }> }
      }
    ).veejus.request({ type: 'getLibrary' }),
  )
  return lib.clips.find((c) => c.id === clipId)?.trim
}

/** Video time on the Background layer, sampled for `ms`. */
async function sampleVideoTimes(ms: number, layer: 'background' | 'overlayA' = 'background') {
  const times: number[] = []
  const end = Date.now() + ms
  while (Date.now() < end) {
    const t = (await readOutput(h.output)).layers[layer].videoTime
    if (t !== null) times.push(t)
    await h.output.waitForTimeout(30)
  }
  return times
}

test('a selected video shows a trim editor; the arrow keys set the in and out points', async () => {
  await pad(h.control, 'countdown.mp4').click()
  const editor = h.control.getByTestId('trim-editor')
  await expect(editor).toBeVisible()
  // A strip of frames across the clip.
  await expect(editor.locator('.trim-frames img')).toHaveCount(10, { timeout: 10_000 })

  const start = editor.getByRole('slider', { name: 'Trim start' })
  await start.focus()
  for (let i = 0; i < 5; i++) await start.press('ArrowRight')
  const end = editor.getByRole('slider', { name: 'Trim end' })
  await end.focus()
  await end.press('End')
  await end.press('Shift+ArrowLeft') // 1 s back
  await end.press('ArrowRight')
  await end.press('ArrowRight')
  await end.press('ArrowRight')
  await end.press('ArrowRight')
  await end.press('ArrowRight') // + 0.5 s
  await expect.poll(libraryTrim).toEqual({ inMs: 500, outMs: 1500 })
  await expect(editor.getByTestId('trim-readout')).toContainText('0:00.5 – 0:01.5')
  await expect(start).toHaveAttribute('aria-valuenow', '500')
})

test('playing it loops only the trimmed part', async () => {
  await h.control.getByRole('button', { name: 'Play countdown.mp4 on Background' }).click()
  await expect.poll(async () => (await readOutput(h.output)).layers.background.clipId).toBe(clipId)
  const times = await sampleVideoTimes(2600)
  expect(times.length).toBeGreaterThan(30)
  for (const t of times) {
    expect(t).toBeGreaterThanOrEqual(0.45)
    expect(t).toBeLessThanOrEqual(1.6)
  }
  // It went round: early and late parts of the window both turn up.
  expect(Math.min(...times)).toBeLessThan(0.75)
  expect(Math.max(...times)).toBeGreaterThan(1.25)
  // Auto-play and tempo sync see the trimmed length.
  expect(
    await h.output.evaluate(
      (id) =>
        (
          globalThis as unknown as {
            __veejusOutput: { clipDurationMs?(id: string): number | null }
          }
        ).__veejusOutput.clipDurationMs?.(id) ?? null,
      clipId,
    ),
  ).toBeCloseTo(1000, 0)
})

test('the trim is saved in the set', async () => {
  const saved = await h.control.evaluate(() =>
    (
      globalThis as unknown as {
        __veejusSet: { current(): { clips: { name: string; trim?: unknown }[] } }
      }
    ).__veejusSet.current(),
  )
  expect(saved.clips.find((c) => c.name === 'countdown.mp4')?.trim).toEqual({
    inMs: 500,
    outMs: 1500,
  })
  await h.control.getByRole('button', { name: 'Stop Background' }).click()
})

test('a pad beat loop from a random spot jumps back to the same spot every beat', async () => {
  const spec: PadSpec = {
    source: { kind: 'clip', clipId },
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
    startAt: 'random',
    loopBeats: 0.5,
  }
  const before = (await readOutput(h.output)).trigger.recentActions.length
  await sendToOutput(h.control, { type: 'padPress', padId: 'A1', spec })
  await expect
    .poll(
      async () =>
        (await readOutput(h.output)).trigger.recentActions
          .slice(before)
          .filter((a) => a.padId === 'A1' && a.type === 'restart').length,
      { timeout: 5000 },
    )
    .toBeGreaterThan(4)
  const acts = (await readOutput(h.output)).trigger.recentActions
    .slice(before)
    .filter((a) => a.padId === 'A1')
  const start = acts.find((a) => a.type === 'start')!
  const spot = start.startMs ?? 0
  // The trimmed clip is 1000 ms; a half-beat loop (250 ms) leaves 750 ms of room.
  expect(spot).toBeLessThanOrEqual(750)
  const restarts = acts.filter((a) => a.type === 'restart')
  for (let i = 1; i < restarts.length; i++)
    expect(Math.abs(restarts[i]!.atMs - restarts[i - 1]!.atMs - 250)).toBeLessThanOrEqual(25)

  // The picture stays within the loop: from the spot (after the in-point) to a beat-half later.
  const times = await sampleVideoTimes(1200, 'overlayA')
  const from = 0.5 + spot / 1000
  for (const t of times) {
    expect(t).toBeGreaterThanOrEqual(from - 0.05)
    expect(t).toBeLessThanOrEqual(from + 0.25 + 0.1)
  }
  await sendToOutput(h.control, { type: 'padPress', padId: 'A1', spec })
  await expect
    .poll(async () => (await readOutput(h.output)).layers.overlayA.clipId, { timeout: 3000 })
    .toBeNull()
})

test('the pad editor offers the start spot and beat loop', async () => {
  await pad(h.control, 'countdown.mp4').dragTo(h.control.locator('[data-pad="A2"]'))
  await h.control.locator('[data-pad="A2"]').click({ button: 'right' })
  const advanced = h.control.getByTestId('pad-advanced')
  await showMoreSettings(h.control)
  await h.control.getByLabel('Pad start').selectOption('random')
  // One-shot (the default mode) can't beat-loop.
  await expect(h.control.getByLabel('Beat loop')).toBeDisabled()
  await h.control.getByLabel('Pad mode').selectOption('toggle')
  await h.control.getByLabel('Beat loop').selectOption('1')
  const summary = advanced.locator('> summary')
  await expect(summary).toContainText('random start')
  await expect(summary).toContainText('beat loop 1 beat')
})

test('dragging a handle moves it, and Reset plays the whole clip again', async () => {
  // Back from the pad editor to the clip (selecting another clip first).
  await pad(h.control, 'photo.jpg').click()
  await pad(h.control, 'countdown.mp4').click()
  const editor = h.control.getByTestId('trim-editor')
  const strip = editor.getByTestId('trim-strip')
  await strip.scrollIntoViewIfNeeded()
  const box = (await strip.boundingBox())!
  const end = editor.getByRole('slider', { name: 'Trim end' })
  const handle = (await end.boundingBox())!
  // From the out handle (1.5 s) to the middle of the strip (1 s).
  await h.control.mouse.move(handle.x + handle.width / 2, box.y + box.height / 2)
  await h.control.mouse.down()
  await h.control.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 4 })
  await h.control.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 4 })
  await h.control.mouse.up()
  await expect
    .poll(async () => {
      const t = (await libraryTrim()) as { inMs: number; outMs: number } | null
      return t !== null && t.inMs === 500 && Math.abs(t.outMs - 1000) <= 40
    })
    .toBe(true)

  await editor.getByRole('button', { name: 'Reset' }).click()
  await expect.poll(libraryTrim).toBeNull()
  await expect(editor.getByTestId('trim-readout')).toContainText('0:00.0 – 0:02.0')
})
