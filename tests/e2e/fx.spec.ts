import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import {
  FIXTURES,
  importPaths,
  launchApp,
  near,
  pad,
  readOutput,
  samplePixel,
  sendToOutput,
  type AppHandles,
} from './helpers'
import {
  DEFAULT_KEY,
  DEFAULT_LAYERS_CONFIG,
  DEFAULT_PLACEMENT,
  type LayerId,
  type Placement,
} from '../../src/shared/layers'
import type { PadSpec } from '../../src/shared/pads'
import {
  defaultParams,
  emptyFxConfig,
  type EffectType,
  type FxConfig,
  type Modulator,
} from '../../src/shared/fx'

let h: AppHandles
const ids: Record<string, string> = {}

test.describe.configure({ mode: 'serial' })

interface FxTestState {
  passes: number
  history: number
  framePos: number
  barOffset: number
  lastKickPos: number | null
}

const fxState = async () =>
  (await h.output.evaluate(
    () =>
      (
        globalThis as unknown as { __veejusOutput: { getState(): { fx: unknown } } }
      ).__veejusOutput.getState().fx,
  )) as FxTestState

test.beforeAll(async () => {
  h = await launchApp()
  await importPaths(h.control, [join(FIXTURES, 'keying')])
  for (const name of ['solid-red.png', 'solid-gray.png']) {
    await expect(pad(h.control, name)).toHaveAttribute('data-state', 'ready', { timeout: 15_000 })
    ids[name] = (await pad(h.control, name).getAttribute('data-clip-id'))!
  }
})

test.afterAll(async () => {
  await h?.app.close()
})

async function fire(padId: string, clip: string, layer: LayerId, placement: Partial<Placement>) {
  const spec: PadSpec = {
    source: { kind: 'clip', clipId: ids[clip]! },
    mode: 'toggle',
    quantize: 'off',
    lengthBeats: 2,
    retriggerEvery: 'beat',
    fadeInBeats: 0,
    fadeOutBeats: 0,
    syncBeats: null,
    layer,
    placement: { ...DEFAULT_PLACEMENT, fit: 'stretch', ...placement },
    key: DEFAULT_KEY,
  }
  await sendToOutput(h.control, { type: 'padPress', padId, spec })
  await expect.poll(async () => (await readOutput(h.output)).layers[layer].transform).not.toBeNull()
}

async function reset() {
  await sendToOutput(h.control, { type: 'stopAll' })
  await sendToOutput(h.control, { type: 'setFx', config: emptyFxConfig() })
  await sendToOutput(h.control, { type: 'setLayers', config: DEFAULT_LAYERS_CONFIG })
  await sendToOutput(h.control, { type: 'setBackground', color: [0, 0, 0] })
  await expect
    .poll(async () => Object.values((await readOutput(h.output)).layers).every((l) => !l.clipId))
    .toBe(true)
}

/** Gray full-screen background with a red square top-left (30% of the height). */
async function grayWithRedSquare() {
  await fire('G', 'solid-gray.png', 'background', { anchor: 'full' })
  await fire('R', 'solid-red.png', 'overlayA', { anchor: 'topLeft', size: 0.3 })
}

const effect = (id: string, type: EffectType, params: Record<string, number> = {}) => ({
  id,
  type,
  enabled: true,
  params: { ...defaultParams(type), ...params },
})

async function setFx(build: (c: FxConfig) => void) {
  const config = emptyFxConfig()
  build(config)
  await sendToOutput(h.control, { type: 'setFx', config })
}

const px = (fx: number, fy: number) => samplePixel(h.output, fx, fy)
const RED = [255, 0, 0]
const GRAY = [128, 128, 128]

test('layer and master effects change the picture', async () => {
  await reset()
  await grayWithRedSquare()
  expect(near(await px(0.05, 0.1), RED)).toBe(true)
  expect(near(await px(0.95, 0.1), GRAY)).toBe(true)

  // A steady flash on Overlay A whitens only that layer.
  await setFx((c) => c.overlayA.effects.push(effect('s', 'strobe', { amount: 1, rate: 0 })))
  await expect.poll(() => px(0.05, 0.1)).toEqual([255, 255, 255, 255])
  expect(near(await px(0.5, 0.6), GRAY)).toBe(true)
  expect((await fxState()).passes).toBe(1)

  // Master mirror (left half onto the right) puts the red square top-right too.
  await setFx((c) => c.master.effects.push(effect('m', 'mirror', { mode: 0 })))
  await expect.poll(async () => near(await px(0.95, 0.1), RED)).toBe(true)

  // Master invert: red becomes cyan, gray stays (nearly) gray.
  await setFx((c) => c.master.effects.push(effect('i', 'invert')))
  await expect.poll(async () => near(await px(0.05, 0.1), [0, 255, 255])).toBe(true)
  expect(near(await px(0.5, 0.6), [127, 127, 127])).toBe(true)

  // A disabled effect does nothing, and effects at zero strength cost no pass.
  await setFx((c) => {
    c.master.effects.push({ ...effect('i', 'invert'), enabled: false })
    c.overlayA.effects.push(effect('z', 'zoomBump', { amount: 0 }))
  })
  await expect.poll(async () => near(await px(0.05, 0.1), RED)).toBe(true)
  expect((await fxState()).passes).toBe(0)
})

test('feedback trails linger after the layer is gone, then fade out completely', async () => {
  await reset()
  await fire('R', 'solid-red.png', 'overlayA', { anchor: 'topLeft', size: 0.3 })
  await setFx((c) => c.master.effects.push(effect('f', 'feedback', { amount: 0.98, zoom: 0 })))
  await expect.poll(async () => (await fxState()).history).toBe(1)
  await sendToOutput(h.control, { type: 'stopLayer', layer: 'overlayA' })
  await expect.poll(async () => (await readOutput(h.output)).layers.overlayA.clipId).toBeNull()
  const soon = (await px(0.05, 0.1))!
  expect(soon[0]).toBeGreaterThan(40) // still glowing red
  await expect.poll(async () => (await px(0.05, 0.1))![0], { timeout: 8000 }).toBe(0)
})

test('a 1-bar sine on opacity completes exactly one cycle per bar', async () => {
  await reset()
  await h.control.getByLabel('Type BPM').fill('120')
  await h.control.getByLabel('Type BPM').press('Enter')
  await fire('R', 'solid-red.png', 'overlayA', { anchor: 'full' })
  const sine: Modulator = {
    id: 'lfo',
    enabled: true,
    target: 'opacity',
    source: { kind: 'lfo', shape: 'sine', periodBeats: 4, phase: 0 },
    amount: 1,
    // opacity 1 + (-1 .. 0) = 0 .. 1
    min: -1,
    max: 0,
    invert: false,
  }
  await setFx((c) => c.overlayA.mods.push(sine))
  await expect
    .poll(async () => ((await fxState()) as unknown as { config: FxConfig }).config.overlayA.mods)
    .toHaveLength(1)
  await h.output.waitForTimeout(100)

  // Sample for just over two bars (4 s at 120 BPM).
  const samples: { pos: number; barOffset: number; opacity: number; beatInBar: number }[] = []
  const t0 = Date.now()
  while (Date.now() - t0 < 4300) {
    const s = await h.output.evaluate(() => {
      const st = (
        globalThis as unknown as {
          __veejusOutput: {
            getState(): {
              fx: { framePos: number; barOffset: number }
              layers: { overlayA: { opacity: number } }
            }
          }
        }
      ).__veejusOutput.getState()
      return { fx: st.fx, opacity: st.layers.overlayA.opacity }
    })
    const barPos = (((s.fx.framePos + s.fx.barOffset) % 4) + 4) % 4
    samples.push({
      pos: s.fx.framePos,
      barOffset: s.fx.barOffset,
      opacity: s.opacity,
      beatInBar: Math.floor(barPos) + 1,
    })
    await h.output.waitForTimeout(15)
  }
  expect(samples.length).toBeGreaterThan(100)
  // Every sample sits on the bar-aligned sine (opacity 0 on each downbeat, 1 mid-bar).
  for (const s of samples) {
    const barPhase = ((((s.pos + s.barOffset) % 4) + 4) % 4) / 4
    expect(Math.abs(s.opacity - (0.5 - 0.5 * Math.cos(2 * Math.PI * barPhase)))).toBeLessThan(0.01)
  }
  // One peak per bar: count upward crossings of 0.5 against bars spanned.
  let crossings = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1]!.opacity < 0.5 && samples[i]!.opacity >= 0.5) crossings++
  }
  const bars = (samples.at(-1)!.pos - samples[0]!.pos) / 4
  expect(bars).toBeGreaterThan(2)
  expect(Math.abs(crossings - bars)).toBeLessThanOrEqual(1)
  // The minimum is on beat 1, the maximum on beat 3.
  const lows = samples.filter((s) => s.opacity < 0.05)
  const highs = samples.filter((s) => s.opacity > 0.95)
  expect(lows.length).toBeGreaterThan(0)
  expect(highs.length).toBeGreaterThan(0)
  for (const s of lows) expect([1, 4]).toContain(s.beatInBar)
  for (const s of highs) expect([2, 3]).toContain(s.beatInBar)
})

test('Kick Bump (from the panel) bumps the clip on each detected kick', async () => {
  await reset()
  await sendToOutput(h.control, { type: 'setAudioSource', source: { kind: 'test', bpm: 120 } })
  await expect
    .poll(async () => (await readOutput(h.output)).audio.status.state, { timeout: 10_000 })
    .toBe('running')
  await fire('R', 'solid-red.png', 'overlayA', { anchor: 'center', size: 0.4 })
  const baseH = (await readOutput(h.output)).layers.overlayA.transform!.h

  await h.control.getByRole('button', { name: 'Overlay A effects' }).click()
  await h.control.getByRole('button', { name: 'Kick Bump' }).click()
  await expect(h.control.getByRole('button', { name: 'Kick Bump' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(h.control.getByTestId('mod-1')).toBeVisible()
  await expect.poll(async () => (await fxState()).lastKickPos).not.toBeNull()

  const kicksBefore = (await readOutput(h.output)).audio.onsetCounts.low
  const heights: number[] = []
  const t0 = Date.now()
  while (Date.now() - t0 < 3000) {
    heights.push((await readOutput(h.output)).layers.overlayA.transform!.h)
    await h.output.waitForTimeout(10)
  }
  const kicks = (await readOutput(h.output)).audio.onsetCounts.low - kicksBefore
  const ratios = heights.map((x) => x / baseH)
  expect(Math.max(...ratios)).toBeGreaterThan(1.07)
  expect(Math.max(...ratios)).toBeLessThanOrEqual(1.1 + 1e-6)
  expect(Math.min(...ratios)).toBeCloseTo(1, 3)
  // Count bumps: rising through +5%.
  let bumps = 0
  for (let i = 1; i < ratios.length; i++) if (ratios[i - 1]! < 1.05 && ratios[i]! >= 1.05) bumps++
  expect(kicks).toBeGreaterThanOrEqual(5)
  expect(Math.abs(bumps - kicks)).toBeLessThanOrEqual(1)

  // Toggling the preset off removes it.
  await h.control.getByRole('button', { name: 'Kick Bump' }).click()
  await expect(h.control.getByTestId('mod-1')).toHaveCount(0)
  await expect
    .poll(async () => (await readOutput(h.output)).layers.overlayA.transform!.h / baseH)
    .toBeCloseTo(1, 3)
  await sendToOutput(h.control, { type: 'setAudioSource', source: null })
})

test('the panel adds effects and modulators that reach the output', async () => {
  await reset()
  await grayWithRedSquare()
  await h.control.getByRole('button', { name: 'Master effects' }).click()
  await h.control.getByLabel('Effect to add').selectOption('invert')
  await h.control.getByRole('button', { name: 'Add effect' }).click()
  await expect(h.control.getByTestId('effect-invert')).toBeVisible()
  await expect.poll(async () => near(await px(0.05, 0.1), [0, 255, 255])).toBe(true)

  // Modulate the invert mix with a square LFO, then turn the effect off from the panel.
  await h.control.getByRole('button', { name: 'Add modulator' }).click()
  await h.control.getByLabel('Modulator 1 target').selectOption({ label: 'Invert: Mix' })
  await h.control.getByLabel('Modulator 1 shape').selectOption('square')
  await h.control.getByLabel('Enable Invert').uncheck()
  await expect.poll(async () => near(await px(0.05, 0.1), RED)).toBe(true)
  await h.control.getByRole('button', { name: 'Remove Invert' }).click()
  // Its modulator goes with it.
  await expect(h.control.getByTestId('mod-1')).toHaveCount(0)
  await h.control.getByRole('button', { name: 'Overlay A effects' }).click()
})
