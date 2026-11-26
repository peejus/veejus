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

test('Slice slides neighbouring strips apart on the beat, swapping sides each time', async () => {
  const layer = await showRed()
  await setEffect(layer, 'slice', { amount: 0.3, beats: 1, slices: 2, snap: 1 })
  // Near the left edge of the bottom strip: uncovered while that strip slides right.
  await checkAgainstModel(0.1, 0.75, (beat) => {
    const flip = Math.floor(beat) % 2 === 0 ? 1 : -1
    const off = 0.3 * (1 - frac(beat)) * flip
    return off > 0.12 ? 'black' : off < 0.08 ? 'red' : null
  })
})

/** Output width over height (the warps work in aspect-corrected space). */
async function canvasAspect() {
  const { width, height } = (await readOutput(h.output)).canvas
  return width / height
}

test('Twirl twists the middle on the beat, alternating direction, and unwinds', async () => {
  const layer = await showRed({ anchor: 'leftHalf' })
  await setEffect(layer, 'twirl', { amount: 0.5, beats: 2, radius: 1.5, snap: 1 })
  const aspect = await canvasAspect()
  const u = { x: 0.55, y: 0.7 } // uv, GL y-up; fy = 1 - y
  await checkAgainstModel(u.x, 1 - u.y, (beat) => {
    const env = 1 - frac(beat / 2)
    const dirn = Math.floor(beat / 2) % 2 === 0 ? 1 : -1
    const px = (u.x - 0.5) * aspect
    const py = u.y - 0.5
    const k = Math.max(0, 1 - Math.hypot(px, py) / 1.5)
    const a = 2 * Math.PI * 0.5 * env * k * k * dirn
    const qx = Math.cos(a) * px - Math.sin(a) * py
    return qx < -0.02 ? 'red' : qx > 0.02 ? 'black' : null
  })
})

test('Wave sends a ripple out from the middle on the beat', async () => {
  const layer = await showRed({ anchor: 'leftHalf' })
  await setEffect(layer, 'wave', { amount: 0.1, beats: 1, rings: 6, snap: 1 })
  const aspect = await canvasAspect()
  const x = 0.505
  await checkAgainstModel(x, 0.5, (beat) => {
    const f = frac(beat)
    const r = (x - 0.5) * aspect
    const d = 0.1 * (1 - f) * Math.sin(2 * Math.PI * (r * 6 - f * 2))
    const src = x + d / aspect
    return src < 0.497 ? 'red' : src > 0.503 ? 'black' : null
  })
})

// Mirrors MY_P0, MY_V and bounceIn in effectShader.ts.
const MY_P0 = [
  [0.15, 0.2],
  [0.8, 0.1],
  [0.9, 0.75],
  [0.2, 0.9],
  [0.4, 0.3],
  [0.7, 0.35],
  [0.6, 0.8],
  [0.3, 0.65],
]
const MY_V = [
  [0.9, 0.55],
  [-0.6, 0.8],
  [-0.75, -0.5],
  [0.55, -0.9],
  [-0.85, 0.6],
  [0.7, 0.75],
  [0.6, -0.8],
  [-0.5, -0.7],
]
const bounceIn = (a: number) => 0.03 + 0.94 * (1 - Math.abs((((a % 2) + 2) % 2) - 1))

test('Mystify draws bouncing lines over the picture, moving with the beat', async () => {
  await sendToOutput(h.control, { type: 'stopAll' })
  await sendToOutput(h.control, { type: 'setBackground', color: [0, 0, 0] })
  const speed = 0.02
  const config = emptyFxConfig()
  config.master.effects.push({
    id: 'm1',
    type: 'mystify',
    enabled: true,
    params: { ...defaultParams('mystify'), amount: 1, trails: 1, speed, punch: 0 },
  })
  await sendToOutput(h.control, { type: 'setFx', config })
  const { width: W, height: H } = (await readOutput(h.output)).canvas
  const halfW = Math.max(1.5, H / 400)
  /** The two shapes' corners at `beat`, in GL pixels. */
  const corners = (beat: number) =>
    MY_P0.map(([x, y], j) => [
      bounceIn(x! + MY_V[j]![0]! * speed * beat) * W,
      bounceIn(y! + MY_V[j]![1]! * speed * beat) * H,
    ])
  const segDist = (p: number[], a: number[], b: number[]) => {
    const abx = b[0]! - a[0]!
    const aby = b[1]! - a[1]!
    const t = Math.min(
      1,
      Math.max(0, ((p[0]! - a[0]!) * abx + (p[1]! - a[1]!) * aby) / (abx * abx + aby * aby)),
    )
    return Math.hypot(p[0]! - a[0]! - abx * t, p[1]! - a[1]! - aby * t)
  }
  const nearest = (p: number[], beat: number) => {
    const c = corners(beat)
    let d = Infinity
    for (let s = 0; s < 2; s++)
      for (let i = 0; i < 4; i++)
        d = Math.min(d, segDist(p, c[s * 4 + i]!, c[s * 4 + ((i + 1) % 4)]!))
    return d
  }
  // Pixel (column, GL row) → the fractional position samplePixel reads, and its center.
  const at = (col: number, row: number) => ({
    fx: (col + 0.25) / (W - 1),
    fy: (H - 1 - row + 0.25) / (H - 1),
    center: [col + 0.5, row + 0.5],
  })
  let lit = 0
  let dark = 0
  const wrong: string[] = []
  let beat = (await sample(0.5, 0.5)).beat
  for (let i = 0; i < 60; i++) {
    // Aim at the middle of one edge where it will be next frame, or 25 px to the side of it.
    const c = corners(beat + 1 / 30)
    const e = i % 8
    const a = c[e]!
    const b = c[e % 4 === 3 ? e - 3 : e + 1]!
    const side = i % 2 === 0 ? 0 : 25
    const len = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!)
    const nx = -(b[1]! - a[1]!) / len
    const ny = (b[0]! - a[0]!) / len
    const col = Math.floor((a[0]! + b[0]!) / 2 + nx * side)
    const row = Math.floor((a[1]! + b[1]!) / 2 + ny * side)
    if (col < 0 || row < 0 || col >= W || row >= H) continue
    const spot = at(col, row)
    const r = await sample(spot.fx, spot.fy)
    beat = r.beat
    const d = nearest(spot.center, r.beat)
    const bright = Math.max(r.px[0]!, r.px[1]!, r.px[2]!)
    if (d < 0.5 * halfW) {
      if (bright > 60) lit++
      else
        wrong.push(
          `beat ${r.beat.toFixed(3)} d=${d.toFixed(2)}: wanted a line, got ${r.px.join(',')}`,
        )
    } else if (d > 1.2 * halfW) {
      if (bright < 20) dark++
      else
        wrong.push(
          `beat ${r.beat.toFixed(3)} d=${d.toFixed(2)}: wanted dark, got ${r.px.join(',')}`,
        )
    }
  }
  expect(wrong).toEqual([])
  expect(lit).toBeGreaterThan(5)
  expect(dark).toBeGreaterThan(5)
  await sendToOutput(h.control, { type: 'setFx', config: emptyFxConfig() })
})

test('the effects are offered as one-click presets', async () => {
  await sendToOutput(h.control, { type: 'setFx', config: emptyFxConfig() })
  await h.control.getByRole('button', { name: 'Background effects' }).click()
  const panel = h.control.getByTestId('fx-panel-background')
  for (const name of [
    'Photo Pulse',
    'Photo Fold',
    'Photo Bounce',
    'Pixel Spin',
    'Photo Wave',
    'Photo Slice',
    'Photo Twirl',
    'Mystify',
  ])
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
