import { expect, test } from '@playwright/test'
import { launchApp, openSetup, readOutput, type AppHandles } from './helpers'

// Chromium's fake capture devices stand in for real audio interfaces.
const FAKE_DEVICES = ['--use-fake-device-for-media-stream']

let h: AppHandles

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  h = await launchApp(FAKE_DEVICES)
  // Every test here works in Setup → Audio.
  await openSetup(h.control, 'Audio')
})

test.afterAll(async () => {
  await h?.app.close()
})

const source = () => h.control.getByTestId('audio-source')
const state = () => h.control.getByTestId('audio-state')
const bandLevel = async (i: number) =>
  Number((await h.control.getByTestId(`band-${i}`).getAttribute('data-level')) ?? 0)

test('audio starts off and lists the built-in sources and input devices', async () => {
  await expect(state()).toHaveText('Off')
  const options = source().locator('option')
  await expect(options.filter({ hasText: 'Off' })).toHaveCount(1)
  await expect(options.filter({ hasText: 'Test beat' })).toHaveCount(1)
  await expect(options.filter({ hasText: 'System audio' })).toHaveCount(1)
  await expect(options.filter({ hasText: 'Fake Default Audio Input' })).toHaveCount(1)
})

test('the test beat runs and its kicks are detected at the right rate', async () => {
  await source().selectOption('test')
  await expect(state()).toContainText('Running · Test beat 120 BPM')
  // Let the analyzer settle, then count over a measured window.
  await h.output.waitForTimeout(1000)
  const before = await readOutput(h.output)
  const t0 = Date.now()
  await h.output.waitForTimeout(5000)
  const after = await readOutput(h.output)
  const seconds = (Date.now() - t0) / 1000
  const kicksPerSecond = (after.audio.onsetCounts.low - before.audio.onsetCounts.low) / seconds
  const highsPerSecond = (after.audio.onsetCounts.high - before.audio.onsetCounts.high) / seconds
  // 120 BPM = 2 kicks per second; claps, hats and kick clicks give ~3-5 high hits per second.
  expect(kicksPerSecond).toBeGreaterThan(1.8)
  expect(kicksPerSecond).toBeLessThan(2.2)
  expect(highsPerSecond).toBeGreaterThan(2.5)
  expect(highsPerSecond).toBeLessThan(6)
  expect(after.audio.latencyMs).toBeGreaterThan(0)
  expect(after.audio.latencyMs).toBeLessThan(40)
})

test('meters, counters and blinkers update in the control window', async () => {
  await expect.poll(() => bandLevel(0)).toBeGreaterThan(0.4)
  await expect
    .poll(async () => Number(await h.control.getByTestId('kick-count').textContent()))
    .toBeGreaterThan(5)
  await expect
    .poll(async () => Number(await h.control.getByTestId('high-count').textContent()))
    .toBeGreaterThan(5)
  await expect(h.control.locator('.blinker.low .lamp.flash')).toHaveCount(1, { timeout: 2000 })
  await expect(h.control.locator('.audio-panel')).toContainText(/Analysis latency ~\d+ ms/)
})

test('input gain changes the analyzed level', async () => {
  const loud = await bandLevel(0)
  await h.control.getByLabel('Input gain').fill('-24')
  await expect.poll(() => bandLevel(0)).toBeLessThan(loud - 0.25)
  // The kicks are still found at -24 dB.
  const before = (await readOutput(h.output)).audio.onsetCounts.low
  await h.output.waitForTimeout(2000)
  expect((await readOutput(h.output)).audio.onsetCounts.low - before).toBeGreaterThanOrEqual(3)
  await h.control.getByLabel('Input gain').fill('0')
  await expect.poll(() => bandLevel(0)).toBeGreaterThan(loud - 0.1)
})

test('switching to an input device and back works without a restart', async () => {
  const fake = source().locator('option', { hasText: 'Fake Default Audio Input' })
  await source().selectOption((await fake.getAttribute('value'))!)
  await expect(state()).toContainText('Running · Fake Default Audio Input')

  await source().selectOption('test')
  await expect(state()).toContainText('Running · Test beat')
  const before = (await readOutput(h.output)).audio.onsetCounts.low
  await expect
    .poll(async () => (await readOutput(h.output)).audio.onsetCounts.low)
    .toBeGreaterThan(before + 2)
})

test('system audio loopback starts (Windows)', async () => {
  test.skip(process.platform !== 'win32', 'loopback capture is Windows-only')
  await source().selectOption('loopback')
  await expect(state()).toContainText('Running · System audio')
})

test('turning audio off stops analysis and zeroes the meters', async () => {
  await source().selectOption('off')
  await expect(state()).toHaveText('Off')
  await expect.poll(() => bandLevel(0)).toBe(0)
  const before = (await readOutput(h.output)).audio.onsetCounts
  await h.output.waitForTimeout(1000)
  expect((await readOutput(h.output)).audio.onsetCounts).toEqual(before)
})

test('the output keeps 60 fps while audio runs', async () => {
  await source().selectOption('test')
  await expect(state()).toContainText('Running')
  await h.output.waitForTimeout(1500)
  const { frameStats } = await readOutput(h.output)
  expect(frameStats.fps).toBeGreaterThan(58)
  expect(frameStats.droppedFrames).toBe(0)
})
