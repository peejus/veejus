import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { FIXTURES, importPaths, launchApp, pad, type AppHandles } from './helpers'

/** The ? sheet lists which keys fire which pads, by bank; loaded pads' keys stand out. */

let h: AppHandles

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  h = await launchApp()
  await importPaths(h.control, [join(FIXTURES, 'media')])
  await expect(h.control.locator('[data-testid=pad][data-state=ready]')).toHaveCount(7, {
    timeout: 15_000,
  })
})

test.afterAll(async () => {
  await h?.app.close()
})

const sheet = () => h.control.getByRole('dialog', { name: 'Keyboard shortcuts' })
const yourPads = () => sheet().getByTestId('your-pads')

test('with no pads loaded, the sheet says how to load some', async () => {
  await h.control.getByRole('button', { name: 'All shortcuts (?)' }).click()
  await expect(yourPads()).toContainText('No pads loaded yet')
  await h.control.keyboard.press('Escape')
  await expect(sheet()).toHaveCount(0)
})

test('loaded pads are listed with their keys, current bank first', async () => {
  // Bank A: two clips on 1 and Q. Bank B: one on A.
  await pad(h.control, 'countdown.mp4').dragTo(h.control.locator('[data-pad="A1"]'))
  await pad(h.control, 'photo.jpg').dragTo(h.control.locator('[data-pad="A9"]'))
  await h.control.getByRole('tab', { name: 'B' }).click()
  await pad(h.control, 'wave.webp').dragTo(h.control.locator('[data-pad="B17"]'))
  await h.control.getByRole('tab', { name: 'A' }).click()

  await h.control.getByRole('button', { name: 'All shortcuts (?)' }).click()
  const banks = yourPads().locator('.your-pads-bank')
  await expect(banks).toHaveCount(2)
  await expect(banks.nth(0).locator('h4')).toContainText('Bank A')
  await expect(banks.nth(0).locator('h4')).toContainText('showing now')
  await expect(banks.nth(1).locator('h4')).toContainText('Bank B')
  await expect(banks.nth(1).locator('h4')).toContainText('F2')

  const a1 = yourPads().locator('[data-pad-row="A1"]')
  await expect(a1.locator('kbd')).toHaveText('1')
  await expect(a1).toContainText('countdown.mp4')
  await expect(yourPads().locator('[data-pad-row="A9"] kbd')).toHaveText('Q')
  await expect(yourPads().locator('[data-pad-row="B17"] kbd')).toHaveText('A')
  await expect(yourPads().locator('[data-pad-row="B17"]')).toContainText('wave.webp')
  // Only loaded pads.
  await expect(yourPads().locator('[data-pad-row]')).toHaveCount(3)
})

test('clicking a pad in the list switches bank and opens its editor', async () => {
  await yourPads().locator('[data-pad-row="B17"]').click()
  await expect(sheet()).toHaveCount(0)
  await expect(h.control.getByRole('tab', { name: 'B' })).toHaveAttribute('aria-selected', 'true')
  await expect(h.control.getByTestId('pad-editor')).toContainText('Pad B17')
})

test("a loaded pad's key is drawn as a key; empty slots stay dim", async () => {
  const style = (id: string) =>
    h.control.locator(`[data-pad="${id}"] .pad-key`).evaluate((el) => {
      const cs = (
        globalThis as unknown as {
          getComputedStyle(e: unknown): { borderTopWidth: string; opacity: string }
        }
      ).getComputedStyle(el)
      return { border: cs.borderTopWidth, opacity: cs.opacity }
    })
  expect((await style('B17')).border).toBe('1px')
  expect(await style('B1')).toEqual({ border: '0px', opacity: '0.6' })
})
