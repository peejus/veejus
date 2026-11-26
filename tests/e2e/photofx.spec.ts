import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import {
  FIXTURES,
  importPaths,
  launchApp,
  pad,
  readOutput,
  sendToOutput,
  type AppHandles,
} from './helpers'
import { DEFAULT_KEY, DEFAULT_PLACEMENT, type Placement } from '../../src/shared/layers'
import type { PadSpec } from '../../src/shared/pads'
import { defaultParams, emptyFxConfig, type EffectType } from '../../src/shared/fx'
import { DEFAULT_AUTO_PLAY, PHOTO_FX_TYPES } from '../../src/shared/autoplay'

/**
 * Beat-locked photo effects: pulse, fold, bounce and pixel spin. Each pixel read comes with the
 * beat its frame was drawn at, so the test can check the picture against the effect's own
 * formula at that moment, on a red still over a black output.
 */

let h: AppHandles
const ids: Record<string, string> = {}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  h = await launchApp()
  await importPaths(h.control, [join(FIXTURES, 'keying')])
  for (const name of ['solid-red.png', 'solid-gray.png']) {
    await expect(pad(h.control, name)).toHaveAttribute('data-state', 'ready', { timeout: 15_000 })
    ids[name] = (await pad(h.control, name).getAttribute('data-clip-id'))!
  }
  await h.control.getByLabel('Type BPM').fill('120')
  await h.control.getByLabel('Type BPM').press('Enter')
  await expect(h.control.getByTestId('bpm-value')).toHaveText('120.0')
})

test.afterAll(async () => {
  await h?.app.close()
})

const frac = (v: number) => v - Math.floor(v)

async function showRed(placement: Partial<Placement> = {}) {
  await sendToOutput(h.control, { type: 'stopAll' })
  const layer = placement.anchor && placement.anchor !== 'full' ? 'overlayA' : 'background'
  const spec: PadSpec = {
    source: { kind: 'clip', clipId: ids['solid-red.png']! },
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
  await sendToOutput(h.control, { type: 'padPress', padId: 'R', spec })
  await expect.poll(async () => (await readOutput(h.output)).layers[layer].transform).not.toBeNull()
  return layer
}

async function setEffect(
  layer: 'background' | 'overlayA',
  type: EffectType,
  params: Record<string, number>,
) {
  const config = emptyFxConfig()
  config[layer].effects.push({
    id: 'e1',
    type,
    enabled: true,
    params: { ...defaultParams(type), ...params },
  })
  await sendToOutput(h.control, { type: 'setFx', config })
}

async function sample(fx: number, fy: number) {
  return h.output.evaluate(
    ([x, y]) =>
      (
        globalThis as unknown as {
          __veejusOutput: {
            samplePixelWithBeat(x: number, y: number): Promise<{ px: number[]; beat: number }>
          }
        }
      ).__veejusOutput.samplePixelWithBeat(x!, y!),
    [fx, fy],
  )
}

const isRed = (px: number[]) => px[0]! > 100 && px[1]! < 40 && px[2]! < 40
const isBlack = (px: number[]) => px[0]! < 30 && px[1]! < 30 && px[2]! < 30

/**
 * Sample one spot for `frames` frames. `expect(beat)` says what the effect's formula predicts:
 * 'red', 'black' or null (too close to the edge to call). Every clear call must match, and both
 * states must turn up, which shows the effect moves and is locked to the beat.
 */
async function checkAgainstModel(
  fx: number,
  fy: number,
  model: (beat: number) => 'red' | 'black' | null,
  frames = 90,
) {
  const seen = { red: 0, black: 0 }
  const wrong: string[] = []
  for (let i = 0; i < frames; i++) {
    const { px, beat } = await sample(fx, fy)
    const want = model(beat)
    if (!want) continue
    if (want === 'red' ? isRed(px) : isBlack(px)) seen[want]++
    else wrong.push(`beat ${beat.toFixed(3)}: wanted ${want}, got ${px.join(',')}`)
  }
  expect(wrong).toEqual([])
  expect(seen.red).toBeGreaterThan(2)
  expect(seen.black).toBeGreaterThan(2)
}

test('Pulse swells the picture on every beat', async () => {
  const layer = await showRed({ anchor: 'center', size: 0.3 })
  await setEffect(layer, 'pulse', { amount: 0.5, beats: 1, glow: 0, snap: 1 })
  // 0.17 of the height above the center; the square reaches 0.15 × the pulse scale.
  await checkAgainstModel(0.5, 0.5 - 0.17, (beat) => {
    const scale = 1 + 0.5 * (1 - frac(beat))
    return scale > 1.2 ? 'red' : scale < 1.07 ? 'black' : null
  })
})

test('Fold hinges the right half over the left, shut on the beat', async () => {
  const layer = await showRed()
  await setEffect(layer, 'fold', { amount: 1, beats: 2, direction: 0, panels: 1 })
  await checkAgainstModel(0.9, 0.5, (beat) => {
    const theta = Math.PI * (0.5 + 0.5 * Math.cos(2 * Math.PI * frac(beat / 2)))
    const ct = Math.cos(theta)
    return ct > 0.86 ? 'red' : ct < 0.75 ? 'black' : null
  })
  // The left half is always covered (by itself, or by the folded-over flap).
  for (let i = 0; i < 20; i++) expect(isRed((await sample(0.1, 0.5)).px)).toBe(true)
})

test('Bounce lifts the picture between beats and lands on them', async () => {
  const layer = await showRed()
  await setEffect(layer, 'bounce', { amount: 0.5, beats: 2, squash: 0 })
  // 15% up from the bottom: uncovered while the picture is higher than that.
  await checkAgainstModel(0.5, 0.85, (beat) => {
    const f = frac(beat / 2)
    const lift = 0.5 * 4 * f * (1 - f)
    return lift > 0.19 ? 'black' : lift < 0.11 ? 'red' : null
  })
})

test('Pixel spin sends a wave of spinning tiles back and forth', async () => {
  const layer = await showRed()
  const size = 32
  const width = 0.3
  await setEffect(layer, 'pixelSpin', { amount: 1, size, beats: 2, width })
  const { width: W, height: H } = (await readOutput(h.output)).canvas
  // The corner pixel of a tile near the middle: uncovered while that tile spins (it shrinks).
  const tx = Math.floor((0.5 * W) / size)
  const ty = Math.floor((0.5 * H) / size)
  const glRow = ty * size + 1
  const fx = (tx * size + 1) / (W - 1)
  const fy = (H - 1 - glRow) / (H - 1)
  const cx = ((tx + 0.5) * size) / W
  await checkAgainstModel(
    fx,
    fy,
    (beat) => {
      const front = 1 - Math.abs(2 * frac(beat / 4) - 1)
      const pos = -width + front * (1 + 2 * width)
      const k = Math.min(1, Math.max(0, 1 - Math.abs(cx - pos) / width))
      const s = k * k * (3 - 2 * k)
      return s > 0.5 ? 'black' : Math.abs(cx - pos) > width + 0.02 ? 'red' : null
    },
    150,
  )
})

test('the effects are offered as one-click presets', async () => {
  await sendToOutput(h.control, { type: 'setFx', config: emptyFxConfig() })
  await h.control.getByRole('button', { name: 'Background effects' }).click()
  const panel = h.control.getByTestId('fx-panel-background')
  for (const name of ['Photo Pulse', 'Photo Fold', 'Photo Bounce', 'Pixel Spin'])
    await expect(panel.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()
  await panel.getByRole('button', { name: /^Photo Bounce/ }).click()
  await expect
    .poll(async () => {
      const fx = (await h.output.evaluate(
        () =>
          (
            globalThis as unknown as { __veejusOutput: { getState(): { fx: unknown } } }
          ).__veejusOutput.getState().fx,
      )) as { config: { background: { effects: { type: string }[] } } }
      return fx.config.background.effects.map((e) => e.type)
    })
    .toEqual(['bounce'])
  await panel.getByRole('button', { name: /^Photo Bounce/ }).click()
})

test('auto-play can put a different photo effect on each still', async () => {
  await sendToOutput(h.control, { type: 'stopAll' })
  await sendToOutput(h.control, { type: 'setFx', config: emptyFxConfig() })
  const resolvedTypes = async () => {
    const st = (await h.output.evaluate(() =>
      (
        globalThis as unknown as { __veejusOutput: { getState(): unknown } }
      ).__veejusOutput.getState(),
    )) as {
      fx: { resolved: { background: { effects: { id: string; type: string }[] } } }
      layers: { background: { owner: string | null } }
    }
    return {
      owner: st.layers.background.owner,
      types: st.fx.resolved.background.effects
        .filter((e) => e.id === 'autoPhoto')
        .map((e) => e.type),
    }
  }
  await sendToOutput(h.control, {
    type: 'setAutoPlay',
    settings: { ...DEFAULT_AUTO_PLAY, enabled: true, step: 1, photoFx: 'mix' },
  })
  const seen = new Set<string>()
  await expect
    .poll(
      async () => {
        const r = await resolvedTypes()
        if (r.owner === 'auto') for (const t of r.types) seen.add(t)
        return seen.size
      },
      { timeout: 10_000, intervals: [100] },
    )
    .toBeGreaterThanOrEqual(3)
  for (const t of seen) expect(PHOTO_FX_TYPES as readonly string[]).toContain(t)

  // Off: no photo effect.
  await sendToOutput(h.control, {
    type: 'setAutoPlay',
    settings: { ...DEFAULT_AUTO_PLAY, enabled: true, step: 1, photoFx: 'none' },
  })
  await expect.poll(async () => (await resolvedTypes()).types).toEqual([])
  await sendToOutput(h.control, { type: 'setAutoPlay', settings: DEFAULT_AUTO_PLAY })

  // The option is in the auto-play panel.
  await h.control.getByRole('button', { name: 'Auto-play settings' }).click()
  await expect(h.control.getByLabel('Auto-play photo effect')).toContainText('Mix')
})
