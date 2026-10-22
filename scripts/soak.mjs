// Soak test: runs Veejus for a long time with music playing and random triggering, and reports
// memory, frame rate and crashes.
//
//   npm run build
//   npm run soak                 60 minutes (the Phase 8 acceptance run)
//   npm run soak -- --minutes 5  a quick check
//
// Music: the built-in test beat drives the analyzer and beat clock. Every 2-5 s a random pad
// fires a random clip on a random layer (one-shots, N-beat pads, toggles, drops); every minute
// effects and the mix change. Memory (all processes) and output frame rate are sampled
// throughout. Results go to tmp/soak/soak-<time>.json and .md.

import { _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : def
}
const MINUTES = arg('minutes', 60)
// Diagnostics: --no-preview turns the preview monitor off; --videos N keeps at most N videos.
const NO_PREVIEW = process.argv.includes('--no-preview')
const MAX_VIDEOS = arg('videos', Infinity)
const TAG = process.argv.includes('--tag') ? process.argv[process.argv.indexOf('--tag') + 1] : ''
const SAMPLE_MS = 30_000
const FPS_SAMPLE_MS = 2_000
// Memory climbs while Chromium's media and GPU caches fill (about the first 20-30 minutes in
// 60-minute runs), then levels off. The trend is judged over the second half of the run.
const WARMUP_MS = Math.max(5 * 60_000, (MINUTES * 60_000) / 2)

const outDir = join(root, 'tmp', 'soak')
mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + (TAG ? `-${TAG}` : '')
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// Deterministic pseudo-random, so runs are comparable.
let seed = 12345
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const pick = (a) => a[Math.floor(rand() * a.length)]

const app = await electron.launch({
  // Precise heap numbers, and gc() so the live heap can be told apart from garbage.
  args: [
    join(root, 'out', 'main', 'index.js'),
    '--enable-precise-memory-info',
    '--js-flags=--expose-gc',
  ],
  env: { ...process.env, VEEJUS_USER_DATA: mkdtempSync(join(tmpdir(), 'veejus-soak-')) },
})
let crashed = null
app.on('close', () => (crashed ??= 'app closed unexpectedly'))

const windowNamed = async (title) => {
  for (let i = 0; i < 100; i++) {
    for (const w of app.windows()) if ((await w.title()) === title) return w
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no window ${title}`)
}
const control = await windowNamed('Veejus Control')
const output = await windowNamed('Veejus Output')
for (const [name, page] of [
  ['control', control],
  ['output', output],
])
  page.on('crash', () => (crashed ??= `${name} renderer crashed`))

const send = (msg) => control.evaluate((m) => globalThis.veejus.sendToOutput(m), msg)
const outState = () => output.evaluate(() => globalThis.__veejusOutput.getState())

// Output at 1080p if the screen allows, then media.
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Veejus Output')
  w.setContentSize(1920, 1080)
})
const folders = ['media', 'keying', 'perf', 'stress']
  .map((f) => join(root, 'fixtures', f))
  .filter((f) => existsSync(f))
await control.evaluate(
  (paths) => globalThis.veejus.request({ type: 'importPaths', paths }),
  folders,
)
log(`imported ${folders.length} fixture folders`)
await new Promise((r) => setTimeout(r, 5000))
const clips = (
  await control.evaluate(() => globalThis.veejus.request({ type: 'getLibrary' }))
).clips.filter((c) => !/corrupt|prores/.test(c.name))
{
  let videos = 0
  for (let i = clips.length - 1; i >= 0; i--) {
    if (clips[i].kind !== 'video') continue
    if (++videos > MAX_VIDEOS) clips.splice(i, 1)
  }
}
log(`${clips.length} playable clips`)
if (NO_PREVIEW) {
  await control.evaluate(() => {
    const box = [...globalThis.document.querySelectorAll('input[aria-label="Show preview"]')][0]
    if (box && box.checked) box.click()
  })
}

await send({ type: 'setAudioSource', source: { kind: 'test', bpm: 126 } })
await send({
  type: 'setLayers',
  config: {
    layers: Object.fromEntries(
      ['background', 'overlayA', 'overlayB', 'takeover'].map((l) => [
        l,
        { opacity: 1, blend: 'normal', muted: false, solo: false },
      ]),
    ),
    takeoverMode: 'dim',
    takeoverDim: 0.6,
  },
})

const LAYERS = ['background', 'overlayA', 'overlayB', 'takeover']
const MODES = ['oneShot', 'oneShot', 'beats', 'beats', 'toggle', 'retrigger']
const QUANT = ['off', 'beat', 'beat', 'bar']
const placement = (anchor) => ({
  anchor,
  fit: 'cover',
  size: 0.35 + rand() * 0.3,
  offsetX: 0,
  offsetY: 0,
  rotationDeg: Math.round((rand() - 0.5) * 30),
  entrance: pick(['none', 'pop', 'slideLeft', 'slideUp']),
  entranceBeats: 0.5,
})
const key = {
  mode: 'none',
  color: [0, 1, 0],
  similarity: 0.3,
  smoothness: 0.1,
  spill: 0.5,
  threshold: 0.15,
  softness: 0.1,
  invert: false,
}
const spec = () => {
  const layer = pick(LAYERS)
  return {
    source: { kind: 'clip', clipId: pick(clips).id },
    mode: pick(MODES),
    quantize: pick(QUANT),
    lengthBeats: pick([1, 2, 4, 8]),
    retriggerEvery: 'beat',
    fadeInBeats: pick([0, 0, 0.5]),
    fadeOutBeats: pick([0, 0, 0.5]),
    syncBeats: null,
    layer,
    placement: placement(
      layer === 'background'
        ? 'full'
        : pick(['center', 'topLeft', 'bottomRight', 'random', 'lowerThird']),
    ),
    key,
  }
}
const fx = (id, type, params) => ({ id, type, enabled: true, params })
const FX_SETS = [
  {
    background: { effects: [], mods: [] },
    overlayA: { effects: [], mods: [] },
    overlayB: { effects: [], mods: [] },
    takeover: { effects: [], mods: [] },
    master: { effects: [], mods: [] },
  },
  {
    background: {
      effects: [fx('k', 'kaleidoscope', { amount: 1, segments: 6, angle: 0 })],
      mods: [
        {
          id: 'm1',
          enabled: true,
          target: 'k.angle',
          source: { kind: 'lfo', shape: 'saw', periodBeats: 8, phase: 0 },
          amount: 1,
          min: 0,
          max: 360,
          invert: false,
        },
      ],
    },
    overlayA: {
      effects: [
        fx('r', 'rgbSplit', { amount: 0.01, angle: 0 }),
        fx('f', 'feedback', { amount: 0.8, zoom: 0.01 }),
      ],
      mods: [
        {
          id: 'm2',
          enabled: true,
          target: 'scale',
          source: { kind: 'envelope', trigger: 'kick', attackBeats: 0, decayBeats: 0.5 },
          amount: 1,
          min: 0,
          max: 0.1,
          invert: false,
        },
      ],
    },
    overlayB: { effects: [fx('p', 'pixelate', { amount: 8 })], mods: [] },
    takeover: { effects: [fx('s', 'shake', { amount: 0.01, speed: 4 })], mods: [] },
    master: {
      effects: [
        fx('z', 'zoomBump', { amount: 0 }),
        fx('st', 'strobe', { amount: 0, rate: 0, duty: 0.5, black: 0 }),
      ],
      mods: [
        {
          id: 'm3',
          enabled: true,
          target: 'st.amount',
          source: { kind: 'envelope', trigger: 'phrase', attackBeats: 0, decayBeats: 1 },
          amount: 1,
          min: 0,
          max: 1,
          invert: false,
        },
      ],
    },
  },
]

const samples = []
const fpsSamples = []
let triggers = 0
let drops = 0
const start = Date.now()
const end = start + MINUTES * 60_000
let nextTrigger = start
let nextFx = start + 60_000
let nextSample = start
let nextFps = start
let fxIndex = 0

const sampleMemory = async () => {
  // Per process; the two windows by name (Control / Output).
  const metrics = await app.evaluate(({ app: a, BrowserWindow }) => {
    const names = new Map(
      BrowserWindow.getAllWindows().map((w) => [
        w.webContents.getOSProcessId(),
        w.getTitle().replace('Veejus ', ''),
      ]),
    )
    return a
      .getAppMetrics()
      .map((m) => ({ type: names.get(m.pid) ?? m.type, kb: m.memory.workingSetSize }))
  })
  const byType = {}
  for (const m of metrics) byType[m.type] = (byType[m.type] ?? 0) + m.kb / 1024
  const totalMB = metrics.reduce((n, m) => n + m.kb / 1024, 0)
  const st = await outState()
  const heaps = await Promise.all(
    [control, output].map((p) =>
      p.evaluate(() => {
        // Live heap: collect garbage first (exposed by --expose-gc).
        globalThis.gc?.()
        return (performance.memory?.usedJSHeapSize ?? 0) / 1048576
      }),
    ),
  )
  const s = {
    tMin: (Date.now() - start) / 60000,
    totalMB: Math.round(totalMB),
    byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Math.round(v)])),
    heapMB: { control: +heaps[0].toFixed(1), output: +heaps[1].toFixed(1) },
    media: st.media,
    gpuMB: st.gpuMB,
    degradeLevel: st.degradeLevel,
  }
  samples.push(s)
  log(
    `t=${s.tMin.toFixed(1)}m mem ${s.totalMB} MB (output heap ${s.heapMB.output} MB), triggers ${triggers}, fps avg so far ${avgFps().toFixed(1)}`,
  )
}
const avgFps = () =>
  fpsSamples.length ? fpsSamples.reduce((a, s) => a + s.fps, 0) / fpsSamples.length : 0

try {
  while (Date.now() < end && !crashed) {
    const now = Date.now()
    if (now >= nextTrigger) {
      if (rand() < 0.08) {
        await send({ type: 'padArm', padId: `D${1 + Math.floor(rand() * 8)}`, spec: spec() })
        drops++
      } else {
        await send({
          type: 'padPress',
          padId: `A${1 + Math.floor(rand() * 32)}`,
          spec: spec(),
          velocity: 0.5 + rand() * 0.5,
        })
      }
      triggers++
      if (rand() < 0.05) await send({ type: 'stopAll' })
      nextTrigger = now + 2000 + rand() * 3000
    }
    if (now >= nextFx) {
      fxIndex = (fxIndex + 1) % FX_SETS.length
      await send({ type: 'setFx', config: FX_SETS[fxIndex] })
      nextFx = now + 60_000
    }
    if (now >= nextFps) {
      const st = await outState()
      fpsSamples.push({
        tMin: (now - start) / 60000,
        fps: st.frameStats.fps,
        maxMs: st.frameStats.frameTimeMaxMs,
      })
      nextFps = now + FPS_SAMPLE_MS
    }
    if (now >= nextSample) {
      await sampleMemory()
      nextSample = now + SAMPLE_MS
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!crashed) await sampleMemory()
} catch (err) {
  crashed ??= `soak driver error: ${err.message}`
}

// ---- report -------------------------------------------------------------------------
/** Least-squares slope of y over x. */
const slope = (pts) => {
  const n = pts.length
  if (n < 2) return 0
  const mx = pts.reduce((a, p) => a + p[0], 0) / n
  const my = pts.reduce((a, p) => a + p[1], 0) / n
  const num = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0)
  const den = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0)
  return den ? num / den : 0
}
const settled = samples.filter((s) => s.tMin * 60000 >= WARMUP_MS)
const memSlope = slope(settled.map((s) => [s.tMin / 60, s.totalMB])) // MB per hour
const heapSlope = slope(settled.map((s) => [s.tMin / 60, s.heapMB.output]))
const fpsAll = fpsSamples.map((s) => s.fps)
const below58 = fpsAll.filter((f) => f < 58).length
const report = {
  minutes: MINUTES,
  ranMinutes: +((Date.now() - start) / 60000).toFixed(1),
  crashed,
  triggers,
  drops,
  clips: clips.length,
  fps: {
    average: +avgFps().toFixed(2),
    min1s: +Math.min(...fpsAll).toFixed(1),
    samples: fpsAll.length,
    samplesBelow58: below58,
  },
  memory: {
    startMB: samples[0]?.totalMB,
    afterWarmupMB: settled[0]?.totalMB,
    endMB: samples.at(-1)?.totalMB,
    peakMB: Math.max(...samples.map((s) => s.totalMB)),
    trendMBPerHour: +memSlope.toFixed(1),
    outputHeapTrendMBPerHour: +heapSlope.toFixed(2),
    warmupMinutes: WARMUP_MS / 60000,
  },
  samples,
  fpsSamples,
}
const base = join(outDir, `soak-${stamp}`)
writeFileSync(`${base}.json`, JSON.stringify(report, null, 2))
const pass = !crashed && report.fps.average >= 58 && Math.abs(report.memory.trendMBPerHour) < 50
writeFileSync(
  `${base}.md`,
  `# Soak test ${stamp}\n\n` +
    `- Duration: ${report.ranMinutes} of ${MINUTES} minutes${crashed ? ` — **stopped: ${crashed}**` : ''}\n` +
    `- Clips: ${clips.length}; triggers: ${triggers} (of which ${drops} drops)\n` +
    `- Frame rate: average **${report.fps.average} fps**, lowest 1 s sample ${report.fps.min1s} fps, ${below58} of ${fpsAll.length} samples below 58\n` +
    `- Memory (all processes): ${report.memory.startMB} MB at start, ${report.memory.afterWarmupMB} MB after ${report.memory.warmupMinutes} min warm-up, ${report.memory.endMB} MB at the end (peak ${report.memory.peakMB} MB)\n` +
    `- Trend after warm-up: **${report.memory.trendMBPerHour} MB/hour** (output JS heap ${report.memory.outputHeapTrendMBPerHour} MB/hour)\n` +
    `- Result: **${pass ? 'PASS' : 'CHECK'}** (no crash, ≥ 58 fps average, |trend| < 50 MB/hour)\n`,
)
log(`report: ${base}.md`)
log(JSON.stringify({ crashed, fps: report.fps, memory: report.memory }))
await app.close().catch(() => {})
process.exit(pass ? 0 : 1)
