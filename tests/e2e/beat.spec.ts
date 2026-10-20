import { expect, test } from '@playwright/test'
import { launchApp, readOutput, type AppHandles } from './helpers'

let h: AppHandles

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  h = await launchApp()
})

test.afterAll(async () => {
  await h?.app.close()
})

const bpmValue = async () => Number(await h.control.getByTestId('bpm-value').textContent())
const beatState = async () => (await readOutput(h.output)).beat

/** Collect beat events arriving in the control window for `ms`. */
async function collectBeats(ms: number) {
  return h.control.evaluate(async (duration) => {
    const g = globalThis as unknown as {
      veejus: { onOutputMessage(fn: (m: { type: string; event?: unknown }) => void): () => void }
    }
    const events: { beatInBar: number; atMs: number; rx: number }[] = []
    const off = g.veejus.onOutputMessage((m) => {
      if (m.type === 'beat')
        events.push({ ...(m.event as { beatInBar: number; atMs: number }), rx: performance.now() })
    })
    await new Promise((r) => setTimeout(r, duration))
    off()
    return events
  }, ms)
}

test('detects the test beat tempo and locks phase within 10 seconds', async () => {
  await h.control.getByTestId('audio-source').selectOption('test')
  await expect.poll(bpmValue, { timeout: 10_000 }).toBeGreaterThan(119.5)
  expect(await bpmValue()).toBeLessThan(120.5)
  await expect(h.control.getByTestId('tempo-mode')).toHaveText('AUTO')
  await expect(h.control.getByTestId('phase-state')).toHaveText('in phase', { timeout: 10_000 })
})

test('beats arrive steadily and cycle through the bar', async () => {
  // Let the clock finish converging onto the newly locked phase.
  await h.output.waitForTimeout(3000)
  const events = await collectBeats(4200)
  expect(events.length).toBeGreaterThanOrEqual(7)
  const gaps = events.slice(1).map((e, i) => e.atMs - events[i]!.atMs)
  for (const g of gaps) expect(Math.abs(g - 500)).toBeLessThan(10)
  expect(new Set(events.map((e) => e.beatInBar))).toEqual(new Set([1, 2, 3, 4]))
  for (let i = 1; i < events.length; i++) {
    expect(events[i]!.beatInBar).toBe((events[i - 1]!.beatInBar % 4) + 1)
  }
  await expect(h.control.getByTestId('bar-counter')).toContainText(/Bar \d+ · Phrase \d+/)
})

test('detects a different tempo (128 BPM)', async () => {
  await h.control.evaluate(() =>
    (globalThis as unknown as { veejus: { sendToOutput(m: unknown): void } }).veejus.sendToOutput({
      type: 'setAudioSource',
      source: { kind: 'test', bpm: 128 },
    }),
  )
  await expect.poll(bpmValue, { timeout: 12_000 }).toBeGreaterThan(127.5)
  expect(await bpmValue()).toBeLessThan(128.5)
})

test('tap tempo with the Space key locks the tapped tempo', async () => {
  await h.control.locator('body').click({ position: { x: 5, y: 5 } })
  const start = Date.now()
  for (let i = 0; i < 4; i++) {
    const due = start + i * 600
    await h.control.waitForTimeout(Math.max(0, due - Date.now()))
    await h.control.keyboard.press('Space')
  }
  await expect(h.control.getByTestId('tempo-mode')).toHaveText('LOCKED')
  await expect(h.control.getByTestId('tap-button')).toHaveText('TAP 4')
  const bpm = await bpmValue()
  expect(bpm).toBeGreaterThan(97)
  expect(bpm).toBeLessThan(103)
})

test('typed BPM, x2 and ÷2', async () => {
  await h.control.getByLabel('Type BPM').fill('140')
  await h.control.getByLabel('Type BPM').press('Enter')
  await expect(h.control.getByTestId('bpm-value')).toHaveText('140.0')
  await h.control.getByRole('button', { name: 'Double tempo' }).click()
  await expect(h.control.getByTestId('bpm-value')).toHaveText('280.0')
  await h.control.getByRole('button', { name: 'Halve tempo' }).click()
  await expect(h.control.getByTestId('bpm-value')).toHaveText('140.0')
  await expect(h.control.getByTestId('tempo-mode')).toHaveText('LOCKED')
})

test('typing in the BPM box does not trigger tempo shortcuts', async () => {
  const taps = (await beatState()).taps
  await h.control.getByLabel('Type BPM').click()
  await h.control.keyboard.type('1 2')
  expect((await beatState()).taps).toBe(taps)
  await h.control.getByLabel('Type BPM').fill('')
  await h.control.locator('body').click({ position: { x: 5, y: 5 } })
})

test('unlocking returns to the detected tempo', async () => {
  await h.control.getByTestId('lock-toggle').click()
  await expect(h.control.getByTestId('tempo-mode')).toHaveText('AUTO')
  await expect.poll(bpmValue, { timeout: 10_000 }).toBeGreaterThan(127.5)
  expect(await bpmValue()).toBeLessThan(128.5)
})

test('Enter resyncs the downbeat to now', async () => {
  await h.control.locator('body').click({ position: { x: 5, y: 5 } })
  await h.control.keyboard.press('Enter')
  const s = await beatState()
  expect(s.beatInBar).toBe(1)
  const events = await collectBeats(1500)
  expect(events[0]!.beatInBar).toBe(2)
})

test('clock settings: latency offset, phrase length, phase correction', async () => {
  await h.control.locator('.beat-settings summary').click()
  await h.control.getByLabel('Latency offset').fill('40')
  await expect.poll(async () => (await beatState()).settings.latencyOffsetMs).toBe(40)
  await h.control.getByLabel('Phrase length').selectOption('16')
  await expect.poll(async () => (await beatState()).settings.phraseBars).toBe(16)
  await expect(h.control.getByTestId('bar-counter')).toContainText('/16)')
  await h.control.getByLabel('Phase correction').uncheck()
  await expect.poll(async () => (await beatState()).settings.phaseCorrection).toBe(false)
  await h.control.getByLabel('Phase correction').check()
  await h.control.getByLabel('Latency offset').fill('0')
})

test('the beat clock keeps running (freewheels) when audio is turned off', async () => {
  await h.control.getByTestId('audio-source').selectOption('off')
  const events = await collectBeats(2000)
  expect(events.length).toBeGreaterThanOrEqual(3)
  const gaps = events.slice(1).map((e, i) => e.atMs - events[i]!.atMs)
  for (const g of gaps) expect(Math.abs(g - 60000 / 128)).toBeLessThan(10)
})

test('the output keeps 60 fps with beat tracking running', async () => {
  await h.control.getByTestId('audio-source').selectOption('test')
  await h.output.waitForTimeout(1500)
  const { frameStats } = await readOutput(h.output)
  expect(frameStats.fps).toBeGreaterThan(58)
  expect(frameStats.droppedFrames).toBe(0)
})
