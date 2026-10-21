import { expect, test } from '@playwright/test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURES, importPaths, launchApp, readOutput, type AppHandles } from './helpers'

// Generate with: node scripts/make-fixtures.mjs --stress
const STRESS = join(FIXTURES, 'stress')
const available = existsSync(STRESS) && readdirSync(STRESS).length >= 50

let h: AppHandles

test.describe.configure({ mode: 'serial' })
test.skip(!available, 'stress fixtures not generated (node scripts/make-fixtures.mjs --stress)')

test.beforeAll(async () => {
  h = await launchApp()
})

test.afterAll(async () => {
  await h?.app.close()
})

test('importing 50 clips keeps both windows responsive and fills in progressively', async () => {
  test.setTimeout(90_000)
  // Let start-up settle so the output's rolling frame stats only cover the import.
  await expect
    .poll(async () => {
      const f = (await readOutput(h.output)).frameStats
      return f.fps > 58 && f.droppedFrames === 0
    })
    .toBe(true)
  // Track the longest gap between control-window animation frames during the import.
  await h.control.evaluate(() => {
    const g = globalThis as unknown as {
      __maxGap: number
      __stop: boolean
      requestAnimationFrame(cb: (now: number) => void): number
    }
    g.__maxGap = 0
    g.__stop = false
    let last = performance.now()
    const tick = (now: number) => {
      g.__maxGap = Math.max(g.__maxGap, now - last)
      last = now
      if (!g.__stop) g.requestAnimationFrame(tick)
    }
    g.requestAnimationFrame(tick)
  })

  const t0 = Date.now()
  const res = await importPaths(h.control, [STRESS])
  expect(res).toEqual({ type: 'imported', result: { added: 50, skipped: 0 } })
  const pads = h.control.getByTestId('pad')
  await expect(pads).toHaveCount(50)
  const padsShownMs = Date.now() - t0

  const thumbs = h.control.locator('[data-testid=pad] .pad-media img[src^="blob:"]')
  await expect(thumbs.first()).toBeVisible({ timeout: 5_000 })
  const firstThumbMs = Date.now() - t0

  let minOutputFps = Infinity
  let maxOutputFrameMs = 0
  await expect
    .poll(
      async () => {
        const s = await readOutput(h.output)
        minOutputFps = Math.min(minOutputFps, s.frameStats.fps)
        maxOutputFrameMs = Math.max(maxOutputFrameMs, s.frameStats.frameTimeMaxMs)
        return thumbs.count()
      },
      { timeout: 60_000, intervals: [250] },
    )
    .toBe(50)
  const allThumbsMs = Date.now() - t0

  const maxGap = await h.control.evaluate(() => {
    const g = globalThis as unknown as { __maxGap: number; __stop: boolean }
    g.__stop = true
    return g.__maxGap
  })

  const summary =
    `pads ${padsShownMs} ms, first thumbnail ${firstThumbMs} ms, all thumbnails ${allThumbsMs} ms; ` +
    `control max frame gap ${maxGap.toFixed(0)} ms; ` +
    `output min fps ${minOutputFps.toFixed(1)}, max frame ${maxOutputFrameMs.toFixed(1)} ms`
  console.log(summary)
  test.info().annotations.push({ type: 'measurements', description: summary })

  expect(firstThumbMs).toBeLessThan(3_000)
  expect(maxGap).toBeLessThan(250)
  expect(minOutputFps).toBeGreaterThan(55)
})

test('output preloads within budget and ready pads start within one frame', async () => {
  test.setTimeout(60_000)
  // Wait for background preloading to settle (videos beyond the warm limit stay cold).
  await expect
    .poll(async () => (await readOutput(h.output)).media.loadingClips, { timeout: 30_000 })
    .toBe(0)
  const media = (await readOutput(h.output)).media
  expect(media.warmVideos).toBeLessThanOrEqual(16)
  console.log(`preloaded: ${JSON.stringify(media)}`)

  const ready = h.control.locator('[data-testid=pad][data-state=ready]')
  const n = await ready.count()
  expect(n).toBeGreaterThanOrEqual(35)
  for (let i = 0; i < 20; i++) {
    const p = ready.nth((i * 7) % n)
    const id = await p.getAttribute('data-clip-id')
    await p.click()
    const name = await p.getAttribute('data-clip-name')
    await h.control.getByRole('button', { name: `Play ${name} on Background` }).click()
    await expect(h.control.getByTestId('start-latency')).toContainText(/^Last start: [01] frame/)
    await expect.poll(async () => (await readOutput(h.output)).current?.id).toBe(id)
  }
})

test('a cold clip loads on demand and plays', async () => {
  const cold = h.control.locator('[data-testid=pad][data-state=cold]').first()
  test.skip((await cold.count()) === 0, 'everything fit in the budget')
  const id = await cold.getAttribute('data-clip-id')
  await cold.click()
  const name = await cold.getAttribute('data-clip-name')
  await h.control.getByRole('button', { name: `Play ${name} on Background` }).click()
  await expect
    .poll(async () => {
      const cur = (await readOutput(h.output)).current
      return cur?.started ? cur.id : null
    })
    .toBe(id)
  const media = (await readOutput(h.output)).media
  expect(media.warmVideos).toBeLessThanOrEqual(16)
})
