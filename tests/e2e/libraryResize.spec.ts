import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { FIXTURES, importPaths, launchApp, type AppHandles } from './helpers'

/** The library can be made taller: drag its grip up, use the arrow keys, or Expand. */

let h: AppHandles

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  h = await launchApp()
  await importPaths(h.control, [join(FIXTURES, 'media')])
})

test.afterAll(async () => {
  await h?.app.close()
})

/** Library and column geometry: heights, and where the library's bottom sits in the column. */
function geometry() {
  return h.control.getByTestId('library').evaluate((lib) => {
    type Box = { top: number; bottom: number; height: number }
    type El = {
      getBoundingClientRect(): Box
      parentElement: El
      clientHeight: number
      scrollTop: number
    }
    const l = lib as unknown as El
    const col = l.parentElement
    const a = l.getBoundingClientRect()
    const c = col.getBoundingClientRect()
    return {
      lib: a.height,
      col: col.clientHeight,
      scrollTop: col.scrollTop,
      bottomGap: c.bottom - a.bottom,
      topVisible: a.top >= c.top - 1,
    }
  })
}

test('dragging the grip up makes the library taller and keeps it in view', async () => {
  const before = await geometry()
  const grip = h.control.getByRole('separator', { name: 'Resize library' })
  const box = (await grip.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await h.control.mouse.move(x, y)
  await h.control.mouse.down()
  await h.control.mouse.move(x, y - 100, { steps: 5 })
  await h.control.mouse.move(x, y - 200, { steps: 5 })
  await h.control.mouse.up()
  await expect.poll(async () => (await geometry()).lib).toBeGreaterThan(before.lib + 150)
  const after = await geometry()
  // The column scrolled so the library's bottom stays at the bottom and its top is visible.
  expect(Math.abs(after.bottomGap)).toBeLessThan(30)
  expect(after.topVisible).toBe(true)
})

test('Expand fills the column; Shrink goes back to filling what the pads leave', async () => {
  await h.control.getByRole('button', { name: '⤢ Expand' }).click()
  await expect
    .poll(async () => {
      const g = await geometry()
      return Math.abs(g.lib - g.col)
    })
    .toBeLessThan(2)
  expect((await geometry()).topVisible).toBe(true)
  await expect(h.control.getByRole('button', { name: '⤡ Shrink' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await h.control.getByRole('button', { name: '⤡ Shrink' }).click()
  await expect.poll(async () => (await geometry()).scrollTop).toBe(0)
  const g = await geometry()
  expect(g.lib).toBeLessThan(g.col)
  expect(await h.control.evaluate(() => localStorage.getItem('veejus.libraryHeight'))).toBe('null')
})

test('the grip works from the keyboard, and the size is remembered', async () => {
  const before = (await geometry()).lib
  const grip = h.control.getByRole('separator', { name: 'Resize library' })
  await grip.focus()
  await grip.press('ArrowUp')
  await grip.press('ArrowUp')
  await expect.poll(async () => (await geometry()).lib).toBeGreaterThanOrEqual(before + 79)
  const saved = Number(await h.control.evaluate(() => localStorage.getItem('veejus.libraryHeight')))
  expect(saved).toBeGreaterThanOrEqual(before + 79)
  // Double-click resets.
  await grip.dblclick()
  await expect
    .poll(() => h.control.evaluate(() => localStorage.getItem('veejus.libraryHeight')))
    .toBe('null')
})
