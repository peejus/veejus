import { expect, test, type Page } from '@playwright/test'
import { cpSync, mkdtempSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FIXTURES,
  closeSetup,
  importPaths,
  launchApp,
  newProfile,
  openSetup,
  pad,
  readOutput,
  type AppHandles,
} from './helpers'

// Phase 8: sets (save / open / autosave / relink), crash recovery, output options, degradation.

let h: AppHandles
const profile = newProfile()
const work = mkdtempSync(join(tmpdir(), 'veejus-sets-'))
const setPath = join(work, 'Friday night.veejus')

test.describe.configure({ mode: 'serial' })

test.afterAll(async () => {
  await h?.app.close()
})

type SetHook = {
  current(): Record<string, unknown>
  open(p: string): Promise<void>
  saveTo(p: string): Promise<void>
  relink(folder: string): Promise<void>
  missing(): string[]
  path(): string | null
  dirty(): boolean
  newSet(): Promise<void>
}
const hook = <T>(page: Page, fn: (s: SetHook, arg: string) => T | Promise<T>, arg = '') =>
  page.evaluate(
    ([src, a]) => {
      const s = (globalThis as unknown as { __veejusSet: SetHook }).__veejusSet
      return new Function('s', 'a', `return (${src})(s, a)`)(s, a) as T
    },
    [fn.toString(), arg] as const,
  )
/** The set as it would be saved, minus the save time. */
const snapshot = async (page: Page) => {
  const s = await hook(page, (x) => x.current())
  return JSON.stringify({ ...s, savedAt: '' })
}

test('save → quit → reopen restores the full set exactly', async () => {
  test.setTimeout(120_000)
  h = await launchApp([], profile)
  const c = h.control
  await importPaths(c, [join(FIXTURES, 'media')])
  await expect(pad(c, 'bounce.png')).toHaveAttribute('data-state', 'ready', { timeout: 15_000 })
  await c.getByRole('button', { name: 'Auto-fill' }).click()

  // Pads: a toggle loop on Overlay B, and a random pad fed by a collection.
  await c.locator('[data-pad="A2"]').click({ button: 'right' })
  await c.getByLabel('Pad mode').selectOption('toggle')
  await c.getByLabel('Pad layer').selectOption('overlayB')
  // Library: a favorite in the "Air Horns" collection.
  await pad(c, 'bounce.png').click()
  await c.getByLabel('Add to collection').fill('Air Horns')
  await c.getByLabel('Add to collection').press('Enter')
  await c.getByRole('button', { name: '☆ Add to favorites' }).click()
  await expect(pad(c, 'bounce.png').locator('.badge.fav')).toBeVisible()
  await c.locator('[data-pad="A5"]').click({ button: 'right' })
  await c.getByLabel('Pad source').selectOption('collection:Air Horns')
  // Mix and effects.
  await c.getByLabel('Overlay A opacity').fill('0.6')
  await c.getByLabel('Overlay A blend').selectOption('screen')
  await c.getByLabel('Master brightness').fill('0.8')
  await c.getByRole('button', { name: 'Overlay A effects' }).click()
  await c.getByRole('button', { name: 'Kick Bump' }).click()
  await c.getByRole('button', { name: 'Master effects' }).click()
  await c.getByRole('button', { name: '+ Add effect' }).click()
  await c.getByRole('button', { name: 'Add Invert' }).click()
  // Clock, MIDI, output, audio.
  await c.getByLabel('Type BPM').fill('128')
  await c.getByLabel('Type BPM').press('Enter')
  await openSetup(c, 'Clock')
  await c.getByLabel('Latency offset').fill('30')
  await c.getByLabel('Phrase length').selectOption('16')
  await openSetup(c, 'MIDI')
  await c.getByRole('button', { name: 'Apply template' }).click()
  await openSetup(c, 'Output')
  await c.getByTestId('swatch-ff2bd6').click()
  await c.getByLabel('Output shape').selectOption('4:3')
  await openSetup(c, 'Audio')
  await c.getByTestId('audio-source').selectOption('test')
  await closeSetup(c)
  await h.output.waitForTimeout(800)

  const before = await snapshot(c)
  expect(before).toContain('Air Horns')
  await hook(c, (s, p) => s.saveTo(p), setPath)
  await expect(c.getByTestId('set-name')).toHaveText('Friday night')
  await expect(c.getByTestId('set-dirty')).toHaveCount(0)
  await h.app.close()

  // A fresh profile (no autosave): only the set file can bring it back.
  h = await launchApp([], newProfile())
  await hook(h.control, (s, p) => s.open(p), setPath)
  await expect.poll(() => snapshot(h.control), { timeout: 10_000 }).toBe(before)
  await expect(h.control.getByTestId('set-name')).toHaveText('Friday night')
  await expect(h.control.locator('[data-pad="A5"]')).toContainText('Random: Air Horns')
  await expect(pad(h.control, 'bounce.png').locator('.badge.fav')).toBeVisible()
  // The output got it too.
  const out = await readOutput(h.output)
  expect(out.layersConfig.layers.overlayA).toMatchObject({ opacity: 0.6, blend: 'screen' })
  expect(out.beat.bpm).toBe(128)
  await expect(h.control.getByTestId('set-dirty')).toHaveCount(0)
  await h.app.close()
})

test('the last session comes back after a restart (autosave)', async () => {
  h = await launchApp([], profile)
  await expect(h.control.getByTestId('set-name')).toHaveText('Friday night', { timeout: 10_000 })
  await expect(pad(h.control, 'bounce.png')).toBeVisible()
  await expect(h.control.locator('[data-pad="A2"]')).toContainText('bounce.png')
  await expect.poll(async () => (await readOutput(h.output)).beat.bpm).toBe(128)
})

test('a crashed control window reloads and restores; the output keeps playing', async () => {
  test.setTimeout(60_000)
  // Something on screen, and give autosave a moment.
  await h.control.locator('[data-pad="A2"]').click()
  await expect(h.control.locator('[data-pad="A2"]')).toHaveAttribute('data-state', 'playing')
  await h.control.waitForTimeout(2000)
  const framesBefore = (await readOutput(h.output)).frameCount
  await h.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Veejus Control')!
    w.webContents.forcefullyCrashRenderer()
  })
  // The output never stops drawing, and the loop keeps playing on it.
  await h.output.waitForTimeout(1500)
  const out = await readOutput(h.output)
  expect(out.frameCount).toBeGreaterThan(framesBefore + 30)
  expect(out.layers.overlayB.clipId).not.toBeNull()
  // The control comes back by itself with the set restored. (Playwright's handle on a crashed
  // page goes stale, so look through the main process.)
  const inControl = (js: string) =>
    h.app.evaluate(async ({ BrowserWindow }, code) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Veejus Control')
      return w ? ((await w.webContents.executeJavaScript(code)) as string | null) : null
    }, js)
  await expect
    .poll(
      () => inControl(`document.querySelector('[data-testid=set-name]')?.textContent ?? null`),
      {
        timeout: 20_000,
      },
    )
    .toBe('Friday night')
  expect(await inControl(`document.querySelector('[data-pad="A2"]')?.textContent ?? ''`)).toContain(
    'bounce.png',
  )
  // Carry on with a fresh app for the remaining tests.
  await h.app.close()
  h = await launchApp([], profile)
  await expect(h.control.getByTestId('set-name')).toHaveText('Friday night', { timeout: 10_000 })
})

test('moved media: the relink dialog finds clips by name in a folder', async () => {
  test.setTimeout(60_000)
  const media = join(work, 'clips')
  cpSync(join(FIXTURES, 'media'), media, { recursive: true })
  await hook(h.control, (s) => s.newSet())
  await importPaths(h.control, [media])
  await expect(pad(h.control, 'wave.webp')).toHaveAttribute('data-state', 'ready', {
    timeout: 15_000,
  })
  await h.control.getByRole('button', { name: 'Auto-fill' }).click()
  // Save the set somewhere else, so relative paths can't find the clips after the move.
  const elsewhere = mkdtempSync(join(tmpdir(), 'veejus-set-only-'))
  const p = join(elsewhere, 'moved.veejus')
  await hook(h.control, (s, a) => s.saveTo(a), p)
  const before = await snapshot(h.control)
  renameSync(media, join(work, 'clips-moved'))

  await hook(h.control, (s, a) => s.open(a), p)
  const dialog = h.control.getByRole('dialog', { name: 'Missing clips' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('missing-list')).toContainText('bounce.png')
  await hook(h.control, (s, a) => s.relink(a), work)
  await expect(dialog).toBeHidden()
  await expect(pad(h.control, 'wave.webp')).toHaveAttribute('data-clip-name', 'wave.webp')
  await expect(h.control.locator('[data-pad="A1"]')).not.toContainText('missing')
  // Same pads, now pointing at the moved files.
  const after = JSON.parse(await snapshot(h.control)) as { clips: { path: string }[] }
  expect(after.clips.every((c) => c.path.includes('clips-moved'))).toBe(true)
  expect(JSON.parse(before).pads.banks[0].filter((x: { source: unknown }) => x.source).length).toBe(
    (after as unknown as { pads: { banks: { source: unknown }[][] } }).pads.banks[0]!.filter(
      (x) => x.source,
    ).length,
  )
})

test('output shape letterboxes the picture', async () => {
  await openSetup(h.control, 'Output')
  await h.control.getByLabel('Output shape').selectOption('1:1')
  await expect
    .poll(async () => {
      const s = (await h.output.evaluate(() =>
        (
          globalThis as unknown as {
            __veejusOutput: {
              getState(): {
                viewport: { width: number; height: number }
                windowSize: { width: number }
              }
            }
          }
        ).__veejusOutput.getState(),
      )) as { viewport: { width: number; height: number }; windowSize: { width: number } }
      return s.viewport.width === s.viewport.height && s.viewport.width < s.windowSize.width
    })
    .toBe(true)
  await h.control.getByLabel('Output shape').selectOption('fill')
  await closeSetup(h.control)
})

test('graceful degradation shows in the control and restores', async () => {
  const setLevel = (n: number | null) =>
    h.output.evaluate(
      (l) =>
        (
          globalThis as unknown as { __veejusOutput: { setDegradeLevel(l: number | null): void } }
        ).__veejusOutput.setDegradeLevel(l),
      n,
    )
  const size = async () => (await readOutput(h.output)).canvas
  const full = await size()
  await setLevel(3)
  await expect(h.control.getByTestId('health-banner')).toContainText('75%')
  await expect.poll(async () => (await size()).width).toBe(Math.round(full.width * 0.75))
  await setLevel(null)
  await expect(h.control.getByTestId('health-banner')).toHaveCount(0)
  await expect.poll(async () => (await size()).width).toBe(full.width)
})
