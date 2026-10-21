import { expect, test, type Page } from '@playwright/test'
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

// MIDI controllers: learn, mapping, templates, LEDs and persistence. There's no MIDI hardware
// on the test machine, so messages are injected as if they came from a device.

let h: AppHandles
const profile = newProfile()

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  h = await launchApp([], profile)
  await importPaths(h.control, [join(FIXTURES, 'media')])
  await expect(pad(h.control, 'bounce.png')).toHaveAttribute('data-state', 'ready', {
    timeout: 15_000,
  })
  await h.control.getByRole('button', { name: 'Auto-fill' }).click()
  await h.control.getByLabel('Global quantize').selectOption('off')
})

test.afterAll(async () => {
  await h?.app.close()
})

type Binding = { device: string | null; type: string; number: number; target: { kind: string } }
const midi = (page: Page) => ({
  inject: (device: string, bytes: number[]) =>
    page.evaluate(
      ([d, b]) =>
        (
          globalThis as unknown as {
            __veejusMidi: { inject(d: string, b: number[]): void }
          }
        ).__veejusMidi.inject(d as string, b as number[]),
      [device, bytes] as const,
    ),
  bindings: () =>
    page.evaluate(() =>
      (
        globalThis as unknown as { __veejusMidi: { bindings(): Binding[] } }
      ).__veejusMidi.bindings(),
    ),
  leds: () =>
    page.evaluate(() =>
      (
        globalThis as unknown as {
          __veejusMidi: { leds(): { bytes: [number, number, number] }[] }
        }
      ).__veejusMidi.leds(),
    ),
})

const gridPad = (id: string) => h.control.locator(`[data-pad="${id}"]`)
const learnButton = () => h.control.getByRole('banner').getByRole('button', { name: 'MIDI learn' })

test('MIDI learn maps a pad in a few seconds; the pad then fires with velocity', async () => {
  const m = midi(h.control)
  const t0 = Date.now()
  await learnButton().click()
  await expect(h.control.getByTestId('learn-banner')).toBeVisible()
  await gridPad('A1').click() // picks it, doesn't fire it
  await expect(gridPad('A1')).toHaveClass(/learn-target/)
  await m.inject('Test Pad', [0x90, 36, 100])
  await expect(h.control.getByTestId('learn-banner')).toContainText('Mapped: Pad A1')
  const elapsed = Date.now() - t0
  test
    .info()
    .annotations.push({ type: 'measurements', description: `pad learned in ${elapsed} ms` })
  expect(elapsed).toBeLessThan(5000)
  await expect(gridPad('A1')).toHaveAttribute('data-state', 'idle') // learning didn't fire it
  await learnButton().click()

  // Now the note plays the pad, and its velocity sets the clip's opacity.
  await m.inject('Test Pad', [0x90, 36, 64])
  await expect(gridPad('A1')).toHaveAttribute('data-state', 'playing')
  await expect
    .poll(async () => (await readOutput(h.output)).layers.overlayA.opacity)
    .toBeCloseTo(64 / 127, 2)
  await m.inject('Test Pad', [0x80, 36, 0])
  // Another device's note 36 isn't mapped.
  expect((await m.bindings()).filter((b) => b.device === 'Test Pad')).toHaveLength(1)
})

test('MIDI learn maps a fader to a layer opacity and an encoder to an effect knob', async () => {
  const m = midi(h.control)
  const t0 = Date.now()
  await learnButton().click()
  await h.control.locator('[data-testid=layer-overlayB] .smart-slider').click()
  await m.inject('Test Pad', [0xb0, 21, 10])
  await expect(h.control.getByTestId('learn-banner')).toContainText('Overlay B opacity')
  expect(Date.now() - t0).toBeLessThan(5000)

  // An effect slider: add Pixelate to Overlay B and learn its block size.
  await h.control.getByRole('button', { name: 'Overlay B effects' }).click()
  await h.control.getByRole('button', { name: '+ Add effect' }).click()
  await learnButton().click() // stop learning to use the panel normally
  await h.control.getByRole('button', { name: 'Add Pixelate' }).click()
  await learnButton().click()
  await h.control.getByTestId('effect-pixelate').locator('.smart-slider').first().click()
  await m.inject('Test Pad', [0xb0, 22, 1])
  await expect(h.control.getByTestId('learn-banner')).toContainText('Pixelate')
  await learnButton().click()

  // The fader moves the opacity...
  await m.inject('Test Pad', [0xb0, 21, 64])
  await expect
    .poll(async () => (await readOutput(h.output)).layersConfig.layers.overlayB.opacity)
    .toBeCloseTo(64 / 127, 3)
  // ...and with the CC mode set to relative, the encoder steps the effect parameter.
  await openSetup(h.control, 'MIDI')
  await h.control.getByLabel(/Pixelate.* CC mode/).selectOption('relative')
  await closeSetup(h.control)
  const pix = async () => {
    const st = (await h.output.evaluate(
      () =>
        (
          globalThis as unknown as { __veejusOutput: { getState(): { fx: unknown } } }
        ).__veejusOutput.getState().fx,
    )) as { config: { overlayB: { effects: { params: { amount: number } }[] } } }
    return st.config.overlayB.effects[0]!.params.amount
  }
  const before = await pix()
  for (let i = 0; i < 5; i++) await m.inject('Test Pad', [0xb0, 22, 1]) // +1 step each
  await expect.poll(pix).toBeGreaterThan(before)
  const step = (128 - 1) / 127
  expect((await pix()) - before).toBeCloseTo(5 * step, 1)
})

test('the APC mini template maps pads, faders and buttons and lights the pad LEDs', async () => {
  const m = midi(h.control)
  await openSetup(h.control, 'MIDI')
  await h.control.getByLabel('Controller template').selectOption('apcMini')
  await h.control.getByRole('button', { name: 'Apply template' }).click()
  await closeSetup(h.control)
  const bindings = await m.bindings()
  expect(bindings.filter((b) => b.target.kind === 'pad').length).toBeGreaterThanOrEqual(32)

  // Pads with clips start yellow (5); pad 2 is note 57 on the APC grid.
  await expect
    .poll(async () => (await m.leds()).some((l) => l.bytes[1] === 57 && l.bytes[2] === 5))
    .toBe(true)
  await m.inject('APC MINI', [0x90, 57, 127])
  await expect(gridPad('A2')).toHaveAttribute('data-state', 'playing')
  await expect
    .poll(async () => (await m.leds()).filter((l) => l.bytes[1] === 57).at(-1)?.bytes[2])
    .toBe(1) // green = playing
  await m.inject('APC MINI', [0x80, 57, 0])

  // Shift (note 98) held + a pad arms it; track button 8 (note 71) fires the drop on the next beat.
  await m.inject('APC MINI', [0x90, 98, 127])
  await m.inject('APC MINI', [0x90, 58, 127]) // pad 3
  await m.inject('APC MINI', [0x80, 98, 0])
  await expect(gridPad('A3')).toHaveAttribute('data-state', 'armed')
  await expect
    .poll(async () => (await m.leds()).filter((l) => l.bytes[1] === 58).at(-1)?.bytes[2])
    .toBe(4) // red blinking = armed
  await m.inject('APC MINI', [0x90, 71, 127])
  await expect(gridPad('A3')).toHaveAttribute('data-state', 'playing', { timeout: 3000 })

  // Fader 1 (CC 48) is the Background opacity; scene button 2 (note 83) is bank B.
  await m.inject('APC MINI', [0xb0, 48, 0])
  await expect
    .poll(async () => (await readOutput(h.output)).layersConfig.layers.background.opacity)
    .toBe(0)
  await m.inject('APC MINI', [0xb0, 48, 127])
  await m.inject('APC MINI', [0x90, 83, 127])
  await expect(h.control.getByTestId('bank-B')).toHaveAttribute('aria-selected', 'true')
  await m.inject('APC MINI', [0x90, 82, 127])
  await expect(h.control.getByTestId('bank-A')).toHaveAttribute('aria-selected', 'true')
  await m.inject('APC MINI', [0x90, 88, 127]) // stop all
  await expect(gridPad('A2')).toHaveAttribute('data-state', 'idle')
})

test('the tempo source is picked in Setup → Clock', async () => {
  await openSetup(h.control, 'Clock')
  await h.control.getByRole('button', { name: /^MIDI clock/ }).click()
  await expect(h.control.getByTestId('tempo-mode')).toHaveText('MIDI')
  await expect(h.control.getByTestId('clock-source-status')).toContainText('MIDI clock')
  await expect(h.control.getByTestId('tap-button')).toBeDisabled()
  await h.control.getByRole('button', { name: /^Audio detection/ }).click()
  await expect(h.control.getByTestId('tempo-mode')).toHaveText('AUTO')
  await h.control.getByRole('button', { name: /^Tap \/ manual/ }).click()
  await expect(h.control.getByTestId('tempo-mode')).toHaveText('LOCKED')
  await closeSetup(h.control)
})

test('mappings persist across restarts', async () => {
  const count = (await midi(h.control).bindings()).length
  expect(count).toBeGreaterThan(30)
  await h.app.close()
  h = await launchApp([], profile)
  await expect.poll(async () => (await midi(h.control).bindings()).length).toBe(count)
  await openSetup(h.control, 'MIDI')
  await expect(h.control.getByTestId('midi-bindings')).toContainText('Pad 1')
  await expect(h.control.getByTestId('midi-bindings')).toContainText('Overlay B opacity')
})
