import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_KEY,
  DEFAULT_LAYERS_CONFIG,
  DEFAULT_PLACEMENT,
  type LayerId,
} from '../../src/shared/layers'
import type { PadSpec } from '../../src/shared/pads'
import {
  defaultParams,
  emptyFxConfig,
  presetItems,
  type EffectType,
  type Modulator,
} from '../../src/shared/fx'
import {
  FIXTURES,
  importPaths,
  launchApp,
  pad,
  readOutput,
  sendToOutput,
  type AppHandles,
} from './helpers'

// Generate with: npm run fixtures:perf
const PERF = join(FIXTURES, 'perf')
const available = existsSync(join(PERF, 'bg-1080.mp4'))

let h: AppHandles

test.describe.configure({ mode: 'serial' })
test.skip(!available, 'performance fixtures not generated (npm run fixtures:perf)')

test.beforeAll(async () => {
  h = await launchApp()
})

test.afterAll(async () => {
  await h?.app.close()
})

/** Warm up, then sample the rolling frame stats every 500 ms for 6 s. */
async function measure(label: string) {
  await h.output.waitForTimeout(2000)
  const samples: { fps: number; frameTimeMaxMs: number; droppedFrames: number }[] = []
  for (let i = 0; i < 12; i++) {
    await h.output.waitForTimeout(500)
    samples.push((await readOutput(h.output)).frameStats)
  }
  const minFps = Math.min(...samples.map((s) => s.fps))
  const avgFps = samples.reduce((a, s) => a + s.fps, 0) / samples.length
  const maxFrame = Math.max(...samples.map((s) => s.frameTimeMaxMs))
  const drops = samples.reduce((a, s) => a + s.droppedFrames, 0)
  const cpu = (await h.output.evaluate(
    () =>
      (
        globalThis as unknown as { __veejusOutput: { getState(): { cpu: unknown } } }
      ).__veejusOutput.getState().cpu,
  )) as { avgMs: number; maxMs: number }
  const summary =
    `${label}: avg ${avgFps.toFixed(1)} fps, min ${minFps.toFixed(1)} fps, ` +
    `max frame ${maxFrame.toFixed(1)} ms, dropped-frame samples ${drops}; ` +
    `frame JS ${cpu.avgMs.toFixed(2)} ms avg / ${cpu.maxMs.toFixed(2)} ms max`
  console.log(summary)
  test.info().annotations.push({ type: 'measurements', description: summary })
  return { avgFps, minFps }
}

test('four layers at 1080p hold 60 fps (acceptance)', async () => {
  test.setTimeout(120_000)
  // Make the output exactly 1920x1080 (it fits on the 2560x1440 dev display).
  await h.app.evaluate(({ BrowserWindow }) => {
    const out = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Veejus Output')!
    out.setContentSize(1920, 1080)
  })
  await expect
    .poll(async () => (await readOutput(h.output)).canvas)
    .toEqual({ width: 1920, height: 1080 })

  await importPaths(h.control, [PERF])
  const id = async (name: string) => {
    await expect(pad(h.control, name)).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
    return (await pad(h.control, name).getAttribute('data-clip-id'))!
  }
  const fire = async (padId: string, name: string, layer: LayerId, over: Partial<PadSpec> = {}) => {
    const spec: PadSpec = {
      source: { kind: 'clip', clipId: await id(name) },
      mode: 'toggle',
      quantize: 'off',
      lengthBeats: 2,
      retriggerEvery: 'beat',
      fadeInBeats: 0,
      fadeOutBeats: 0,
      syncBeats: null,
      layer,
      placement: { ...DEFAULT_PLACEMENT, anchor: 'full', fit: 'cover' },
      key: DEFAULT_KEY,
      ...over,
    }
    await sendToOutput(h.control, { type: 'padPress', padId, spec })
    await expect
      .poll(async () => (await readOutput(h.output)).layers[layer].transform)
      .not.toBeNull()
  }

  // Everything visible at once: no dimming/hiding under the takeover.
  await sendToOutput(h.control, {
    type: 'setLayers',
    config: { ...DEFAULT_LAYERS_CONFIG, takeoverMode: 'none' },
  })
  await fire('P1', 'bg-1080.mp4', 'background')
  await fire('P2', 'dance.gif', 'overlayA', {
    placement: { ...DEFAULT_PLACEMENT, anchor: 'topLeft', size: 0.4, rotationDeg: -8 },
  })
  await fire('P3', 'green-1080.mp4', 'overlayB', { key: { ...DEFAULT_KEY, mode: 'chroma' } })
  await fire('P4', 'takeover-720.mp4', 'takeover', {
    placement: { ...DEFAULT_PLACEMENT, anchor: 'bottomRight', size: 0.45 },
  })
  const layers = (await readOutput(h.output)).layers
  for (const l of Object.values(layers)) expect(l.clipId).not.toBeNull()

  const r = await measure('1920x1080, 4 layers + preview')
  expect(r.avgFps).toBeGreaterThanOrEqual(59)
  expect(r.minFps).toBeGreaterThanOrEqual(57)
})

test('effects on every layer and the master hold 60 fps at 1080p (acceptance)', async () => {
  test.setTimeout(60_000)
  // Continues from the test above: four 1080p layers playing, no takeover dimming.
  const fx = (id: string, type: EffectType, params: Record<string, number> = {}) => ({
    id,
    type,
    enabled: true,
    params: { ...defaultParams(type), ...params },
  })
  const lfo = (id: string, target: string, max: number): Modulator => ({
    id,
    enabled: true,
    target,
    source: { kind: 'lfo', shape: 'sine', periodBeats: 4, phase: 0 },
    amount: 1,
    min: 0,
    max,
    invert: false,
  })
  const config = emptyFxConfig()
  config.background.effects.push(fx('bk', 'kaleidoscope'), fx('bh', 'hueRotate'))
  config.background.mods.push(lfo('bm', 'bk.angle', 90))
  config.overlayA.effects.push(fx('ar', 'rgbSplit'), fx('af', 'feedback'))
  config.overlayA.mods.push(...presetItems('kickBump', 'ka').mods, lfo('am', 'rotation', 20))
  config.overlayB.effects.push(fx('bp', 'pixelate'), fx('bm2', 'mirror', { mode: 2 }))
  config.overlayB.mods.push(lfo('bpm', 'bp.amount', 24))
  config.takeover.effects.push(fx('ts', 'shake'), fx('ti', 'invert', { amount: 0.5 }))
  config.master.effects.push(
    fx('mz', 'zoomBump', { amount: 0.05 }),
    fx('ms', 'strobe', { amount: 0.3, rate: 2 }),
    fx('mf', 'feedback', { amount: 0.6 }),
  )
  config.master.mods.push(lfo('mm', 'mz.amount', 0.1))
  await sendToOutput(h.control, { type: 'setFx', config })
  // 2 effect passes on each of the 4 layers and 3 on the master, every frame.
  await expect.poll(async () => (await readOutput(h.output)).fx.passes).toBe(11)
  const r = await measure('1920x1080, 4 layers + 11 effect passes + preview')
  expect(r.avgFps).toBeGreaterThanOrEqual(59)
  expect(r.minFps).toBeGreaterThanOrEqual(57)
})
