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

test('effect sliders: double-click resets, click the value to type, Shift-drag fine-tunes', async () => {
  await h.control.getByRole('button', { name: 'Overlay B effects' }).click()
  await context().getByRole('button', { name: '+ Add effect' }).click()
  await context().getByRole('button', { name: 'Add Pixelate' }).click()
  const card = context().getByTestId('effect-pixelate')
  const slider = card.getByLabel('Pixelate Block size (px)', { exact: true })
  const value = card.locator('button.slider-value')
  await expect(value).toHaveText('16')
  await slider.fill('64')
  await expect(value).toHaveText('64')
  await slider.dblclick()
  await expect(value).toHaveText('16') // the default
  await value.click()
  await card.getByLabel('Exact value').fill('40')
  await card.getByLabel('Exact value').press('Enter')
  await expect(value).toHaveText('40')

  // Shift-drag moves at a tenth of the speed: 100 px is a small, fractional change.
  const fxAmount = () =>
    h.output.evaluate(() => {
      const st = (
        globalThis as unknown as {
          __veejusOutput: {
            getState(): {
              fx: { config: { overlayB: { effects: { params: { amount: number } }[] } } }
            }
          }
        }
      ).__veejusOutput.getState()
      return st.fx.config.overlayB.effects[0]!.params.amount
    })
  await expect.poll(fxAmount).toBe(40)
  const box = (await slider.boundingBox())!
  const thumbX = box.x + 8 + ((40 - 1) / 127) * (box.width - 16)
  await h.control.mouse.move(thumbX, box.y + box.height / 2)
  await h.control.keyboard.down('Shift')
  await h.control.mouse.down()
  await h.control.mouse.move(thumbX + 100, box.y + box.height / 2, { steps: 5 })
  await h.control.mouse.up()
  await h.control.keyboard.up('Shift')
  const normal = (100 / box.width) * 127 // what a plain drag would have moved
  await expect.poll(fxAmount).toBeGreaterThan(40)
  const fine = (await fxAmount()) - 40
  expect(fine).toBeLessThan(normal / 5)
  expect(fine).toBeCloseTo(normal / 10, 0)
})

test('~ attaches a modulator in place, and the mixer fader shows a moving ghost', async () => {
  await h.control.getByRole('button', { name: 'Overlay A effects' }).click()
  const motion = context().locator('details.fx-motion')
  if ((await motion.getAttribute('open')) === null) await motion.locator('summary').click()
  const tilde = context().getByRole('button', { name: 'Modulate Opacity' })
  await expect(tilde).toHaveAttribute('aria-pressed', 'false')
  await tilde.click()
  await expect(tilde).toHaveAttribute('aria-pressed', 'true')
  // Its editor opens right under the parameter (a 1-bar sine by default).
  const editor = context().locator('.fx-param-mods .mod-item')
  await expect(editor).toHaveCount(1)
  await expect(editor.getByLabel(/Modulator \d+ period/)).toHaveValue('4')

  const ghost = h.control.locator('[data-testid=layer-overlayA] .ghost-thumb')
  await expect(ghost).toBeVisible()
  const read = async () => Number(await ghost.getAttribute('data-value'))
  const a = await read()
  await h.control.waitForTimeout(400)
  const b = await read()
  expect(a).not.toBe(b) // it moves with the music
  for (const v of [a, b]) {
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThanOrEqual(1)
  }
  // Removing the modulator removes the ghost.
  await editor.getByRole('button', { name: /Remove Modulator/ }).click()
  await expect(ghost).toBeHidden()
})

const filter = (name: RegExp) =>
  h.control.getByRole('group', { name: 'Clip filter' }).getByRole('button', { name })
const tiles = () => h.control.getByTestId('pad')

test('library search and type filters narrow the clips', async () => {
  const total = await tiles().count()
  await h.control.getByLabel('Search clips').fill('wave')
  await expect(tiles()).toHaveCount(1)
  await expect(tiles().first()).toHaveAttribute('data-clip-name', 'wave.webp')
  await h.control.getByLabel('Search clips').fill('zzz-nothing')
  await expect(h.control.getByText('No clips match.')).toBeVisible()
  await h.control.getByRole('button', { name: 'Show all' }).click()
  await expect(tiles()).toHaveCount(total)
  await filter(/^Video/).click()
  for (const name of await tiles().evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-clip-name')),
  )) {
    expect(name).toMatch(/\.(mp4|webm|mov)$/)
  }
  await filter(/^All/).click()
  await expect(tiles()).toHaveCount(total)
})

test('clip names sit on the thumbnail; tiles show how many pads use them', async () => {
  const bounce = pad(h.control, 'bounce.png')
  await expect(bounce.locator('.pad-media .pad-name')).toHaveText('bounce.png')
  // Auto-fill put bounce.png on one pad.
  await expect(bounce.getByTestId('assigned')).toHaveText('▣ 1')
  await expect(bounce).toHaveAttribute('title', /On 1 pad/)
  // Removing a clip that a pad uses asks first.
  await bounce.hover()
  await h.control.getByRole('button', { name: 'Remove bounce.png' }).click()
  const confirm = h.control.getByRole('alertdialog', { name: 'Confirm removing clips' })
  await expect(confirm).toContainText('is on 1 pad')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(bounce).toBeVisible()
})

test('broken clips are grouped and can be removed together, with Undo', async () => {
  await expect
    .poll(async () => (await filter(/^Broken/).textContent()) ?? '')
    .toMatch(/Broken\s*\d/)
  await filter(/^Broken/).click()
  const broken = await tiles().count()
  expect(broken).toBeGreaterThanOrEqual(2) // corrupt.gif, corrupt.mp4 (+ prores.mov once tried)
  for (const t of await tiles().all()) await expect(t).toHaveAttribute('data-state', 'error')
  await h.control.getByRole('button', { name: `Remove ${broken} broken` }).click()
  await expect(filter(/^Broken/)).toHaveCount(0)
  // The emptied filter falls back to All.
  await expect(filter(/^All/)).toHaveAttribute('aria-pressed', 'true')
  await h.control.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(async () => (await filter(/^Broken/).count()) > 0).toBe(true)
  await filter(/^All/).click()
})

test('a first-run checklist guides setup until it is done or hidden', async () => {
  const strip = h.control.getByTestId('first-run')
  await expect(strip).toBeVisible()
  await expect(strip.locator('li.done')).toContainText('Clips added')
  await strip.getByRole('button', { name: 'Choose the audio input' }).click()
  await expect(h.control.getByRole('tab', { name: 'Audio', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await closeSetup(h.control)
  await strip.getByRole('button', { name: 'Hide' }).click()
  await expect(strip).toHaveCount(0)
})

test('below 1100 px wide, the library becomes a single scrolling row', async () => {
  await h.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() !== 'Veejus Output')!
    w.setContentSize(1024, 700)
  })
  await expect
    .poll(() =>
      h.control.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth),
    )
    .toBe(1024)
  const flow = await h.control.locator('.library .pad-grid').evaluate(
    (el) =>
      (
        globalThis as unknown as {
          getComputedStyle(e: unknown): { gridAutoFlow: string }
        }
      ).getComputedStyle(el).gridAutoFlow,
  )
  expect(flow).toBe('column')
  // The mixer keeps its five strips in one row.
  const tops = await h.control
    .locator('.mixer .strip')
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
  expect(new Set(tops).size).toBe(1)
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
