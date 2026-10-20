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
} from '../../src/shared/layers'
import type { PadSpec } from '../../src/shared/pads'

let h: AppHandles
const ids: Record<string, string> = {}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  h = await launchApp()
  await importPaths(h.control, [join(FIXTURES, 'keying')])
  for (const name of [
    'greenscreen.mp4',
    'greenscreen.png',
    'luma.png',
    'solid-red.png',
    'solid-gray.png',
  ]) {
    await expect(pad(h.control, name)).toHaveAttribute('data-state', 'ready', { timeout: 15_000 })
    ids[name] = (await pad(h.control, name).getAttribute('data-clip-id'))!
  }
  await h.control.getByLabel('Type BPM').fill('120')
  await h.control.getByLabel('Type BPM').press('Enter')
})

test.afterAll(async () => {
  await h?.app.close()
})

/** Fire a fully specified pad (quantize off) straight at the output. */
async function fire(padId: string, clip: string, layer: LayerId, over: Partial<PadSpec> = {}) {
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
    placement: { ...DEFAULT_PLACEMENT, anchor: 'full', fit: 'stretch' },
    key: DEFAULT_KEY,
    ...over,
  }
  await sendToOutput(h.control, { type: 'padPress', padId, spec })
  await expect.poll(async () => (await readOutput(h.output)).layers[layer].owner).toBe(padId)
  await expect.poll(async () => (await readOutput(h.output)).layers[layer].transform).not.toBeNull()
}

async function reset() {
  await sendToOutput(h.control, { type: 'stopAll' })
  await sendToOutput(h.control, { type: 'setLayers', config: DEFAULT_LAYERS_CONFIG })
  await sendToOutput(h.control, { type: 'setMaster', master: { brightness: 1, blackout: false } })
  await sendToOutput(h.control, { type: 'setBackground', color: [0, 0, 0] })
  await expect
    .poll(async () => Object.values((await readOutput(h.output)).layers).every((l) => !l.clipId))
    .toBe(true)
}

const px = (fx: number, fy: number) => samplePixel(h.output, fx, fy)

test('four layers composite bottom to top, with placement and keying', async () => {
  await reset()
  await fire('L1', 'solid-gray.png', 'background')
  await fire('L2', 'solid-red.png', 'overlayA', {
    placement: { ...DEFAULT_PLACEMENT, anchor: 'topLeft', size: 0.3 },
  })
  await fire('L3', 'luma.png', 'overlayB', {
    placement: { ...DEFAULT_PLACEMENT, anchor: 'center', size: 0.6 },
    key: { ...DEFAULT_KEY, mode: 'luma' },
  })
  await fire('L4', 'greenscreen.png', 'takeover', {
    placement: { ...DEFAULT_PLACEMENT, anchor: 'bottomRight', size: 0.5 },
    key: { ...DEFAULT_KEY, mode: 'chroma' },
  })
  await sendToOutput(h.control, {
    type: 'setLayers',
    config: { ...DEFAULT_LAYERS_CONFIG, takeoverMode: 'none' },
  })
  const gray = [128, 128, 128]
  expect(near(await px(0.08, 0.1), [255, 0, 0])).toBe(true) // red overlay, top left
  expect(near(await px(0.5, 0.5), [255, 255, 255])).toBe(true) // white square kept by luma key
  expect(near(await px(0.45, 0.3), gray)).toBe(true) // luma key removed the black around it
  const t = (await readOutput(h.output)).layers.takeover.transform!
  const { width, height } = (await readOutput(h.output)).canvas
  expect(near(await px(t.cx / width, t.cy / height), [255, 0, 0])).toBe(true) // red square kept
  const greenAreaX = (t.cx - t.w * 0.4) / width
  expect(near(await px(greenAreaX, t.cy / height), gray, 12)).toBe(true) // green keyed out
  await expect(h.control.getByTestId('layer-overlayA-clip')).toContainText('solid-red.png')
})

test('blend modes at 50% opacity give the expected colors', async () => {
  await reset()
  await fire('B1', 'solid-gray.png', 'background')
  await fire('B2', 'solid-red.png', 'overlayA')
  const expected: Record<string, number[]> = {
    normal: [191, 64, 64],
    add: [255, 128, 128],
    screen: [191, 128, 128],
    multiply: [128, 64, 64],
    difference: [128, 128, 128],
  }
  for (const [blend, color] of Object.entries(expected)) {
    await h.control.getByLabel('Overlay A blend').selectOption(blend)
    await h.control.getByLabel('Overlay A opacity').fill('0.5')
    await expect.poll(async () => near(await px(0.5, 0.5), color, 3), { message: blend }).toBe(true)
  }
  await h.control.getByLabel('Overlay A blend').selectOption('normal')
  await h.control.getByLabel('Overlay A opacity').fill('1')
})

test('mute and solo', async () => {
  // Gray background layer + red overlay A from the previous test.
  await h.control.getByRole('button', { name: 'Mute Overlay A' }).click()
  await expect.poll(async () => near(await px(0.5, 0.5), [128, 128, 128])).toBe(true)
  await h.control.getByRole('button', { name: 'Mute Overlay A' }).click()
  await h.control.getByRole('button', { name: 'Solo Background' }).click()
  await expect.poll(async () => near(await px(0.5, 0.5), [128, 128, 128])).toBe(true)
  await h.control.getByRole('button', { name: 'Solo Background' }).click()
  await expect.poll(async () => near(await px(0.5, 0.5), [255, 0, 0])).toBe(true)
})

test('a chroma-keyed video shows the background through the green', async () => {
  await reset()
  await fire('K1', 'solid-gray.png', 'background')
  await fire('K2', 'greenscreen.mp4', 'overlayA', { key: { ...DEFAULT_KEY, mode: 'chroma' } })
  // Corners are pure green in the clip: keyed out to the gray below.
  expect(near(await px(0.03, 0.05), [128, 128, 128], 12)).toBe(true)
  expect(near(await px(0.97, 0.95), [128, 128, 128], 12)).toBe(true)
})

test('pop entrance scales in over the entrance length', async () => {
  await reset()
  await fire('P1', 'solid-red.png', 'overlayA', {
    placement: {
      ...DEFAULT_PLACEMENT,
      anchor: 'center',
      size: 0.5,
      entrance: 'pop',
      entranceBeats: 2,
    },
  })
  const early = (await readOutput(h.output)).layers.overlayA.transform!.h
  await h.output.waitForTimeout(1300) // > 2 beats at 120 BPM
  const { height } = (await readOutput(h.output)).canvas
  const settled = (await readOutput(h.output)).layers.overlayA.transform!.h
  expect(early).toBeLessThan(settled)
  expect(settled).toBeCloseTo(height * 0.5, 0)
})

test('takeover dims, pauses or hides the layers below', async () => {
  await reset()
  await fire('T1', 'greenscreen.mp4', 'background')
  for (const [mode, check] of [
    [
      'dim',
      (s: Awaited<ReturnType<typeof readOutput>>) =>
        Math.abs(s.layers.background.opacity - 0.3) < 0.01,
    ],
    ['pause', (s: Awaited<ReturnType<typeof readOutput>>) => s.layers.background.paused],
    ['hide', (s: Awaited<ReturnType<typeof readOutput>>) => s.layers.background.opacity === 0],
  ] as const) {
    await h.control.getByLabel('Takeover behavior').selectOption(mode)
    await fire(`T-${mode}`, 'solid-red.png', 'takeover', {
      placement: { ...DEFAULT_PLACEMENT, anchor: 'center', size: 0.3 },
    })
    await expect.poll(async () => check(await readOutput(h.output)), { message: mode }).toBe(true)
    await h.control.getByRole('button', { name: 'Stop Takeover' }).click()
    await expect.poll(async () => (await readOutput(h.output)).takeoverActive).toBe(false)
    // Restored on the next frame.
    await expect
      .poll(async () => {
        const after = await readOutput(h.output)
        return !after.layers.background.paused && after.layers.background.opacity === 1
      })
      .toBe(true)
  }
})

test('master brightness and blackout (` key)', async () => {
  await reset()
  await fire('M1', 'solid-gray.png', 'background', {
    source: { kind: 'clip', clipId: ids['solid-red.png']! },
  })
  await h.control.getByLabel('Master brightness').fill('0.5')
  await expect.poll(async () => near(await px(0.5, 0.5), [128, 0, 0], 3)).toBe(true)
  await h.control.locator('body').click({ position: { x: 5, y: 5 } })
  await h.control.keyboard.press('Backquote')
  await expect(h.control.getByTestId('blackout')).toHaveText('BLACKOUT ON')
  await expect.poll(async () => near(await px(0.5, 0.5), [0, 0, 0], 1)).toBe(true)
  await h.control.keyboard.press('Backquote')
  await h.control.getByLabel('Master brightness').fill('1')
  await expect.poll(async () => near(await px(0.5, 0.5), [255, 0, 0], 3)).toBe(true)
})

test('the preview monitor mirrors the output', async () => {
  await reset()
  await fire('V1', 'solid-gray.png', 'background')
  await fire('V2', 'solid-red.png', 'overlayA', {
    placement: { ...DEFAULT_PLACEMENT, anchor: 'topLeft', size: 0.4 },
  })
  const previewAt = (fx: number, fy: number) =>
    h.control.getByTestId('preview-canvas').evaluate(
      (el, [x, y]) => {
        const c = el as unknown as {
          width: number
          height: number
          getContext(t: '2d'): {
            getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> }
          }
        }
        // Frames are stored bottom-up (the canvas is flipped with CSS).
        const d = c
          .getContext('2d')
          .getImageData(
            Math.floor(x! * (c.width - 1)),
            Math.floor((1 - y!) * (c.height - 1)),
            1,
            1,
          ).data
        return [d[0]!, d[1]!, d[2]!]
      },
      [fx, fy],
    )
  for (const [fx, fy] of [
    [0.1, 0.15],
    [0.7, 0.7],
  ] as const) {
    const out = await px(fx, fy)
    await expect.poll(async () => near(await previewAt(fx, fy), out!.slice(0, 3), 6)).toBe(true)
  }
})

test('the pad editor sets layer, placement and keying', async () => {
  await reset()
  await h.control.getByRole('button', { name: 'Auto-fill' }).click()
  const gridPad = h.control.locator('[data-pad="A4"]') // solid-gray.png? order: greenscreen.mp4, .png, luma, red, gray
  await gridPad.click({ button: 'right' })
  await h.control.getByLabel('Pad layer').selectOption('overlayB')
  await h.control.getByLabel('Pad quantize').selectOption('off')
  await h.control.getByLabel('Position').selectOption('topRight')
  await h.control.getByLabel('Size').fill('0.25')
  await h.control.locator('.pad-editor summary', { hasText: 'Keying' }).click()
  await h.control.getByLabel('Key', { exact: true }).selectOption('green')
  await h.control.locator('body').click({ position: { x: 5, y: 5 } })
  await h.control.keyboard.press('Digit4')
  await expect.poll(async () => (await readOutput(h.output)).layers.overlayB.owner).toBe('A4')
  const s = await readOutput(h.output)
  const t = s.layers.overlayB.transform!
  expect(t.cx).toBeGreaterThan(s.canvas.width / 2)
  expect(t.cy).toBeLessThan(s.canvas.height / 2)
  expect(t.h).toBeCloseTo(s.canvas.height * 0.25, 0)
  await expect(h.control.getByTestId('layer-overlayB-clip')).toContainText('A4')
})
