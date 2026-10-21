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

test('pad tiles show a mode icon, a layer stripe and a plain-words tooltip', async () => {
  const a1 = h.control.locator('[data-pad="A1"]')
  await expect(a1.locator('.pad-mode')).toHaveText('▶') // one-shot
  await expect(a1).toHaveAttribute('title', /One-shot on Overlay A \(auto\)/)
  await expect(a1).toHaveAttribute('title', /Shift to arm/)
  const stripe = await a1.evaluate(
    (el) =>
      (
        globalThis as unknown as {
          getComputedStyle(e: unknown, p: string): { backgroundColor: string }
        }
      ).getComputedStyle(el, '::before').backgroundColor,
  )
  expect(stripe).toBe('rgb(255, 159, 26)') // Overlay A orange, as on its mixer strip
  const empty = h.control.locator('[data-pad="A32"]')
  await expect(empty).toHaveAttribute('title', /Empty: drag a library clip here/)
})

test('the pad editor keeps the basics up front and the rest under More settings', async () => {
  await h.control.locator('[data-pad="A2"]').click({ button: 'right' })
  const editor = context().getByTestId('pad-editor')
  for (const label of ['Pad source', 'Pad mode', 'Pad layer', 'Position']) {
    await expect(editor.getByLabel(label, { exact: true })).toBeVisible()
  }
  await expect(editor.getByRole('button', { name: 'Fire' })).toBeVisible()
  const more = editor.getByTestId('pad-advanced')
  if ((await more.getAttribute('open')) !== null) await more.locator('summary').first().click()
  await expect(editor.getByLabel('Pad quantize')).toBeHidden()
  await more.locator('summary').first().click()
  await editor.getByLabel('Pad quantize').selectOption('bar')
  await expect(more.locator('summary').first()).toContainText('quantize Bar')
  // The open state is remembered for the next pad.
  await h.control.locator('[data-pad="A3"]').click({ button: 'right' })
  await expect(context().getByTestId('pad-advanced')).toHaveAttribute('open', '')
  await expect(context().getByLabel('Pad quantize')).toBeVisible()
})

test('? opens the shortcut sheet; Esc closes it without stopping the show', async () => {
  await h.control.locator('body').click({ position: { x: 5, y: 5 } })
  // A loop playing on the Background.
  await h.control.locator('[data-pad="A4"]').click({ button: 'right' })
  await context().getByLabel('Pad mode').selectOption('toggle')
  await h.control.locator('body').click({ position: { x: 5, y: 5 } })
  await h.control.keyboard.press('Digit4')
  await expect(h.control.locator('[data-pad="A4"]')).toHaveAttribute('data-state', 'playing')

  await h.control.keyboard.press('?')
  const sheet = h.control.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(sheet).toBeVisible()
  await expect(sheet).toContainText('Tap tempo')
  await h.control.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(h.control.locator('[data-pad="A4"]')).toHaveAttribute('data-state', 'playing')
  // With the sheet closed, Esc is Stop all again.
  await h.control.keyboard.press('Escape')
  await expect(h.control.locator('[data-pad="A4"]')).toHaveAttribute('data-state', 'idle')
  // The top-bar button and the link under the pads open it too.
  await h.control.getByRole('button', { name: 'Keyboard shortcuts' }).click()
  await expect(sheet).toBeVisible()
  await h.control.getByRole('button', { name: 'Close shortcuts' }).click()
  await h.control.getByRole('button', { name: 'All shortcuts (?)' }).click()
  await expect(sheet).toBeVisible()
  await h.control.keyboard.press('?')
  await expect(sheet).toBeHidden()
})

test('drop timing appears in the drop banner only while something is armed', async () => {
  await expect(h.control.getByLabel('Drop timing')).toHaveCount(0)
  await h.control.locator('[data-pad="A1"]').click({ modifiers: ['Shift'] })
  const banner = h.control.getByTestId('drop-banner')
  await expect(banner.getByLabel('Drop timing')).toHaveValue('phrase')
  await banner.getByLabel('Drop timing').selectOption('1')
  await expect(banner).toContainText(/DROP in (1 bar|\d beats?)/)
  await banner.getByRole('button', { name: 'Cancel' }).click()
  await expect(banner).toBeHidden()
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
