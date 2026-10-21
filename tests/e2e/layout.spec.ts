import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import {
  FIXTURES,
  closeSetup,
  importPaths,
  launchApp,
  openSetup,
  pad,
  type AppHandles,
} from './helpers'

// UX-2: perform screen (pads, mixer, library | preview, beat, context panel) + Setup drawer.

let h: AppHandles

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  h = await launchApp()
  await importPaths(h.control, [join(FIXTURES, 'media')])
  await expect(pad(h.control, 'bounce.png')).toHaveAttribute('data-state', 'ready', {
    timeout: 15_000,
  })
  await h.control.getByRole('button', { name: 'Auto-fill' }).click()
})

test.afterAll(async () => {
  await h?.app.close()
})

const context = () => h.control.getByTestId('context-panel')

test('the context panel starts empty with a hint', async () => {
  await expect(context()).toContainText('Nothing selected')
  await expect(context().getByRole('button', { name: 'Close panel' })).toHaveCount(0)
})

test('right-click or ✎ on a pad edits it in the context panel; ✕ closes it', async () => {
  await h.control.locator('[data-pad="A2"]').click({ button: 'right' })
  await expect(context().getByTestId('pad-editor')).toContainText('Pad A2')
  await h.control.locator('[data-pad="A3"]').hover()
  await h.control.getByRole('button', { name: 'Edit pad A3', exact: true }).click()
  await expect(context().getByTestId('pad-editor')).toContainText('Pad A3')
  // ✎ doesn't fire the pad.
  await expect(h.control.locator('[data-pad="A3"]')).toHaveAttribute('data-state', 'idle')
  await context().getByRole('button', { name: 'Close panel' }).click()
  await expect(context()).toContainText('Nothing selected')
  await expect(h.control.locator('[data-pad="A3"]')).not.toHaveClass(/selected/)
})

test('FX on a mixer strip opens that layer’s effects, and a dot shows when active', async () => {
  const fxA = h.control.getByRole('button', { name: 'Overlay A effects' })
  await fxA.click()
  await expect(fxA).toHaveAttribute('aria-pressed', 'true')
  await expect(context()).toContainText('Effects · Overlay A')
  await expect(h.control.getByTestId('fx-dot-overlayA')).toHaveCount(0)
  await context().getByRole('button', { name: 'Kick Bump' }).click()
  await expect(h.control.getByTestId('fx-dot-overlayA')).toBeVisible()
  // Another strip's FX switches the panel; pressing it again closes it.
  const fxMaster = h.control.getByRole('button', { name: 'Master effects' })
  await fxMaster.click()
  await expect(context()).toContainText('Effects · Master')
  await fxMaster.click()
  await expect(context()).toContainText('Nothing selected')
})

test('selecting a library clip shows it in the context panel', async () => {
  await pad(h.control, 'wave.webp').click()
  await expect(context().getByTestId('clip-inspector')).toContainText('wave.webp')
  await expect(context().getByRole('button', { name: '▶ Play on Background' })).toBeEnabled()
  // Selecting a pad takes the panel over.
  await h.control.locator('[data-pad="A1"]').click({ button: 'right' })
  await expect(context().getByTestId('pad-editor')).toBeVisible()
})

test('Setup holds audio, output, clock and diagnostics, out of the way', async () => {
  await expect(h.control.getByTestId('setup-drawer')).toBeHidden()
  await openSetup(h.control, 'Audio')
  await expect(h.control.getByTestId('audio-source')).toBeVisible()
  await openSetup(h.control, 'Output')
  await expect(h.control.getByTestId('display-list')).toBeVisible()
  await expect(h.control.getByLabel('Background color')).toBeVisible()
  await openSetup(h.control, 'Clock')
  await expect(h.control.getByLabel('Latency offset')).toBeVisible()
  await openSetup(h.control, 'Diagnostics')
  await expect(h.control.getByLabel('Debug overlay')).toBeVisible()
  await closeSetup(h.control)
  await expect(h.control.getByTestId('setup-drawer')).toBeHidden()
  // The audio pill opens Setup at Audio.
  await h.control.getByTestId('audio-status').click()
  await expect(h.control.getByRole('tab', { name: 'Audio', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await closeSetup(h.control)
})

test('pads, mixer, preview, beat and context all fit a 1366×768 laptop screen', async () => {
  await h.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'Veejus Output')!
    w.setContentSize(1366, 768)
  })
  await expect
    .poll(() =>
      h.control.evaluate(() => (globalThis as unknown as { innerHeight: number }).innerHeight),
    )
    .toBe(768)
  const inView = async (sel: string) =>
    h.control
      .locator(sel)
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect()
        const vh = (globalThis as unknown as { innerHeight: number }).innerHeight
        return r.top >= 0 && r.bottom <= vh + 1 && r.height > 20
      })
  for (const sel of [
    '.pad-panel',
    '.mixer',
    '.preview-panel',
    '.beat-panel',
    '[data-testid=context-panel]',
  ]) {
    expect(await inView(sel), sel).toBe(true)
  }
  // The library keeps at least one full row of clips visible.
  const libH = await h.control.locator('.library').evaluate((el) => el.clientHeight)
  expect(libH).toBeGreaterThanOrEqual(150)
})
