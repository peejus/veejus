import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { FIXTURES, importPaths, launchApp, pad, readOutput, type AppHandles } from './helpers'

/**
 * Beat-synced triggering, with the clock locked at 120 BPM (audio off) so timing is exact.
 * Fixture order on bank A after Auto-fill (broken files skipped):
 *   1 alpha-ball.webm  2 bounce.png  3 countdown.mp4  4 half-alpha-still.png
 *   5 half-alpha.gif   6 photo.jpg   7 wave.webp
 */

let h: AppHandles
const FRAME = 1000 / 60
const BEAT_MS = 500

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  h = await launchApp()
  await importPaths(h.control, [join(FIXTURES, 'media')])
  await expect(h.control.getByTestId('pad').first()).toBeVisible()
  // Wait for thumbnails so Auto-fill can skip unreadable files.
  await expect(h.control.locator('[data-testid=pad][data-state=ready]')).toHaveCount(7, {
    timeout: 15_000,
  })
  await h.control.getByLabel('Type BPM').fill('120')
  await h.control.getByLabel('Type BPM').press('Enter')
  await expect(h.control.getByTestId('bpm-value')).toHaveText('120.0')
})

test.afterAll(async () => {
  await h?.app.close()
})

const gridPad = (id: string) => h.control.locator(`[data-pad="${id}"]`)
const actions = async () => (await readOutput(h.output)).trigger.recentActions

/** Click empty space so key presses go to the window, not a form field. */
const focusBody = (page: Page) => page.locator('body').click({ position: { x: 5, y: 5 } })

async function setQuantize(q: string) {
  await h.control.getByLabel('Global quantize').selectOption(q)
}

async function editPad(id: string) {
  await gridPad(id).click({ button: 'right' })
  await expect(h.control.getByTestId('pad-editor')).toContainText(`Pad ${id}`)
}

/** Wait for the next action matching `match` after `count` previous actions. */
async function nextAction(
  count: number,
  match: (a: Awaited<ReturnType<typeof actions>>[number]) => boolean,
) {
  let found: Awaited<ReturnType<typeof actions>>[number] | undefined
  await expect
    .poll(
      async () => {
        found = (await actions()).slice(count).find(match)
        return !!found
      },
      { timeout: 20_000 },
    )
    .toBe(true)
  return found!
}

test('a library clip dragged onto a pad is assigned to it', async () => {
  await pad(h.control, 'wave.webp').dragTo(gridPad('A8'))
  await expect(gridPad('A8')).toContainText('wave.webp')
  await expect(h.control.getByTestId('pad-editor')).toContainText('Pad A8')
  await h.control.getByRole('button', { name: 'Clear' }).last().click()
  await expect(gridPad('A8')).not.toContainText('wave.webp')
})

test('Auto-fill puts the readable clips on the bank in order', async () => {
  await h.control.getByRole('button', { name: 'Auto-fill' }).click()
  await expect(gridPad('A1')).toContainText('alpha-ball.webm')
  await expect(gridPad('A3')).toContainText('countdown.mp4')
  await expect(gridPad('A7')).toContainText('wave.webp')
  await expect(gridPad('A8')).toHaveClass(/empty/)
})

test('bar quantize: a key press fires on the next bar, within one frame', async () => {
  await setQuantize('bar')
  await focusBody(h.control)
  const before = (await actions()).length
  await h.output.waitForTimeout(BEAT_MS * 1.5) // be well clear of a boundary's grace window
  await h.control.keyboard.press('Digit3')
  await expect(gridPad('A3')).toHaveAttribute('data-state', /queued|playing/)
  const start = await nextAction(before, (a) => a.type === 'start' && a.padId === 'A3')
  const { beatsPerMs } = (await readOutput(h.output)).trigger
  expect(Math.abs((start.posAtFire - start.startPos!) / beatsPerMs)).toBeLessThanOrEqual(FRAME)
  // On a bar line, or (if the press landed just after one) inside the 80 ms grace window.
  const pastBar = start.startPos! % 4
  expect(pastBar === 0 || pastBar / beatsPerMs <= 80 + FRAME).toBe(true)
  await expect(gridPad('A3')).toHaveAttribute('data-state', 'playing')
})

test('beat and off quantize', async () => {
  await setQuantize('beat')
  let before = (await actions()).length
  await h.output.waitForTimeout(250)
  await h.control.keyboard.press('Digit1')
  let start = await nextAction(before, (a) => a.type === 'start' && a.padId === 'A1')
  // On the next beat, or immediately if pressed within the grace window just after one.
  const pastBeat = start.startPos! % 1
  const { beatsPerMs } = (await readOutput(h.output)).trigger
  expect(pastBeat === 0 || pastBeat / beatsPerMs <= 80 + FRAME).toBe(true)

  await setQuantize('off')
  await focusBody(h.control)
  before = (await actions()).length
  const pressedPos = (await readOutput(h.output)).beat
  await h.control.keyboard.press('Digit2')
  start = await nextAction(before, (a) => a.type === 'start' && a.padId === 'A2')
  // Immediate: well under a beat after the press.
  expect(start.startPos! - (pressedPos.beatIndex + pressedPos.beatPhase)).toBeLessThan(0.25)
})

test("'For N beats' shows the clip for exactly 2 beats (+-1 frame)", async () => {
  await editPad('A4')
  await h.control.getByLabel('Pad mode').selectOption('beats')
  await h.control.getByLabel('Pad length').selectOption('2')
  await h.control.getByLabel('Pad quantize').selectOption('beat')
  await focusBody(h.control)
  const before = (await actions()).length
  await h.control.keyboard.press('Digit4')
  const start = await nextAction(before, (a) => a.type === 'start' && a.padId === 'A4')
  const stop = await nextAction(before, (a) => a.type === 'stop' && a.padId === 'A4')
  expect(Math.abs(stop.atMs - start.atMs - 2 * BEAT_MS)).toBeLessThanOrEqual(FRAME)
})

test("'While held' plays while the key is down", async () => {
  await editPad('A5')
  await h.control.getByLabel('Pad mode').selectOption('hold')
  await h.control.getByLabel('Pad quantize').selectOption('off')
  await focusBody(h.control)
  const before = (await actions()).length
  await h.control.keyboard.down('Digit5')
  await nextAction(before, (a) => a.type === 'start' && a.padId === 'A5')
  await h.output.waitForTimeout(700)
  await expect(gridPad('A5')).toHaveAttribute('data-state', 'playing')
  await h.control.keyboard.up('Digit5')
  await nextAction(before, (a) => a.type === 'stop' && a.padId === 'A5')
  await expect(gridPad('A5')).toHaveAttribute('data-state', 'idle')
})

test("'Toggle loop' starts on one press and stops on the next (quantized)", async () => {
  await editPad('A6')
  await h.control.getByLabel('Pad mode').selectOption('toggle')
  await h.control.getByLabel('Pad quantize').selectOption('beat')
  await focusBody(h.control)
  const before = (await actions()).length
  await h.control.keyboard.press('Digit6')
  await nextAction(before, (a) => a.type === 'start' && a.padId === 'A6')
  await h.output.waitForTimeout(1200)
  await expect(gridPad('A6')).toHaveAttribute('data-state', 'playing')
  await h.control.keyboard.press('Digit6')
  const stop = await nextAction(before, (a) => a.type === 'stop' && a.padId === 'A6')
  const { beatsPerMs } = (await readOutput(h.output)).trigger
  // Stopped on a beat.
  const off = stop.posAtFire - Math.round(stop.posAtFire)
  expect(Math.abs(off / beatsPerMs)).toBeLessThanOrEqual(FRAME * 1.5)
})

test("'Retrigger' restarts the clip on every beat", async () => {
  await editPad('A7')
  await h.control.getByLabel('Pad mode').selectOption('retrigger')
  await h.control.getByLabel('Pad quantize').selectOption('beat')
  await focusBody(h.control)
  const before = (await actions()).length
  await h.control.keyboard.press('Digit7')
  await nextAction(before, (a) => a.type === 'start' && a.padId === 'A7')
  await h.output.waitForTimeout(2100)
  await h.control.keyboard.press('Digit7')
  await nextAction(before, (a) => a.type === 'stop' && a.padId === 'A7')
  const restarts = (await actions())
    .slice(before)
    .filter((a) => a.type === 'restart' && a.padId === 'A7')
  expect(restarts.length).toBeGreaterThanOrEqual(4)
  for (let i = 1; i < restarts.length; i++) {
    expect(Math.abs(restarts[i]!.atMs - restarts[i - 1]!.atMs - BEAT_MS)).toBeLessThanOrEqual(
      FRAME * 1.5,
    )
  }
})

test('Shift+key arms a drop: countdown, then it fires on the bar', async () => {
  await h.control.getByLabel('Drop timing').selectOption('2')
  await focusBody(h.control)
  const before = (await actions()).length
  await h.control.keyboard.down('Shift')
  await h.control.keyboard.press('Digit1')
  await h.control.keyboard.up('Shift')
  await expect(h.control.getByTestId('drop-banner')).toContainText(
    /DROP in [12] bars?|DROP in \d beats?/,
  )
  await expect(gridPad('A1')).toHaveAttribute('data-state', 'armed')
  const start = await nextAction(before, (a) => a.type === 'start' && a.padId === 'A1')
  expect(start.startPos! % 4).toBe(0)
  await expect(h.control.getByTestId('drop-banner')).toBeHidden()
})

test('arming again cancels the drop', async () => {
  await focusBody(h.control)
  await h.control.keyboard.down('Shift')
  await h.control.keyboard.press('Digit2')
  await expect(h.control.getByTestId('drop-banner')).toBeVisible()
  await h.control.keyboard.press('Digit2')
  await h.control.keyboard.up('Shift')
  await expect(h.control.getByTestId('drop-banner')).toBeHidden()
})

test('a random pad never plays the same clip twice in a row', async () => {
  await h.control.getByTestId('bank-B').click()
  await editPad('B1')
  await h.control.getByLabel('Pad source').selectOption({ label: 'Random from all clips' })
  await h.control.getByLabel('Pad quantize').selectOption('off')
  await focusBody(h.control)
  const before = (await actions()).length
  for (let i = 0; i < 6; i++) {
    await h.control.keyboard.press('Digit1')
    await h.output.waitForTimeout(120)
  }
  const clips = (await actions())
    .slice(before)
    .filter((a) => a.type === 'start' && a.padId === 'B1')
    .map((a) => a.clipId)
  expect(clips.length).toBe(6)
  for (let i = 1; i < clips.length; i++) expect(clips[i]).not.toBe(clips[i - 1])
  const broken = await Promise.all(
    ['corrupt.gif', 'corrupt.mp4', 'prores.mov'].map((n) =>
      pad(h.control, n).getAttribute('data-clip-id'),
    ),
  )
  for (const c of clips) expect(broken).not.toContain(c)
})

test('F1 / F2 switch banks', async () => {
  await h.control.keyboard.press('F1')
  await expect(h.control.getByTestId('bank-A')).toHaveAttribute('aria-selected', 'true')
  await h.control.keyboard.press('F2')
  await expect(h.control.getByTestId('bank-B')).toHaveAttribute('aria-selected', 'true')
  await h.control.keyboard.press('F1')
})

test('tempo sync stretches a clip to N beats', async () => {
  // countdown.mp4 is 2 s; stretched to 8 beats at 120 BPM (4 s) it plays at half speed.
  await editPad('A3')
  await h.control.getByLabel('Pad mode').selectOption('toggle')
  await h.control.getByLabel('Pad quantize').selectOption('off')
  await h.control.getByLabel('Tempo sync').selectOption('8')
  await focusBody(h.control)
  await h.control.keyboard.press('Digit3')
  await expect
    .poll(async () => (await readOutput(h.output)).trigger.speedOverride ?? 0)
    .toBeCloseTo(0.5, 2)
})

test('Esc stops everything', async () => {
  await h.control.keyboard.press('Escape')
  await expect.poll(async () => (await readOutput(h.output)).current).toBeNull()
  await expect(h.control.locator('[data-testid=grid-pad][data-state=playing]')).toHaveCount(0)
})

test('the output keeps 60 fps while pads fire', async () => {
  await setQuantize('beat')
  await focusBody(h.control)
  for (const key of ['Digit1', 'Digit2', 'Digit3', 'Digit4']) {
    await h.control.keyboard.press(key)
    await h.output.waitForTimeout(300)
  }
  await h.output.waitForTimeout(800)
  const { frameStats } = await readOutput(h.output)
  expect(frameStats.fps).toBeGreaterThan(58)
})
