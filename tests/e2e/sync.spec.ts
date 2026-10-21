import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { launchApp, readOutput, sendToOutput, type AppHandles } from './helpers'

// External clock sources: MIDI clock (injected) and Ableton Link (a real peer in this process).

const LINK_MODULE = resolve(__dirname, '../../native/abletonlink.node')
const linkBuilt = existsSync(LINK_MODULE)

interface LinkPeer {
  enable(on: boolean): void
  setTempo(bpm: number): void
  getTempo(): number
  getPhase(q: number): number
  getNumPeers(): number
}

let h: AppHandles

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  h = await launchApp()
})

test.afterAll(async () => {
  await h?.app.close()
})

const beat = async () => (await readOutput(h.output)).beat
const setSource = (source: 'internal' | 'midi' | 'link') =>
  sendToOutput(h.control, { type: 'beatCommand', command: { type: 'setClockSource', source } })

type ClockNow = { pos: number; epochMs: number; latencyOffsetMs: number; barOffset: number }
const clockNow = () =>
  h.output.evaluate(() =>
    (
      globalThis as unknown as { __veejusOutput: { clockNow(): ClockNow } }
    ).__veejusOutput.clockNow(),
  )

test('MIDI clock: follows the tempo and lines bars up after Start', async () => {
  await setSource('midi')
  await expect.poll(async () => (await beat()).external?.text ?? '').toMatch(/MIDI/)
  // 126 BPM clock, Start, then ticks in real time for ~3 s (injected as if from a device).
  const result = await h.output.evaluate(async () => {
    const out = (
      globalThis as unknown as {
        __veejusOutput: { injectMidi(b: number[], t?: number): void; clockNow(): ClockNow }
      }
    ).__veejusOutput
    const tickMs = 60000 / 126 / 24
    const t0 = performance.now() + 20
    out.injectMidi([0xfa], t0 - 1)
    let n = 0
    await new Promise<void>((done) => {
      const step = () => {
        const now = performance.now()
        while (t0 + n * tickMs <= now) out.injectMidi([0xf8], t0 + n++ * tickMs)
        if (now - t0 < 3000) setTimeout(step, 4)
        else done()
      }
      step()
    })
    // Catch up to now, then read our clock.
    const now = performance.now()
    while (t0 + n * tickMs <= now) out.injectMidi([0xf8], t0 + n++ * tickMs)
    const c = out.clockNow()
    return { c, t0Epoch: performance.timeOrigin + t0, tickMs }
  })
  const st = await beat()
  expect(st.bpm).toBeGreaterThan(125.8)
  expect(st.bpm).toBeLessThan(126.2)
  expect(st.external).toMatchObject({ ok: true })
  // Where the source is: beats since Start at the moment we read our clock.
  const beatMs = result.tickMs * 24
  const srcBeats = (result.c.epochMs - result.t0Epoch) / beatMs
  const ours = result.c.pos + result.c.barOffset
  let diff = (((ours - srcBeats) % 4) + 4) % 4
  if (diff > 2) diff -= 4
  // Within one frame of the source's bar position.
  expect(Math.abs(diff)).toBeLessThan(1000 / 60 / beatMs)
})

test('switching sources at runtime keeps running and re-anchors', async () => {
  await setSource('internal')
  await expect.poll(async () => (await beat()).external).toBeNull()
  await setSource('midi') // no ticks: freewheels
  await expect.poll(async () => (await beat()).external?.ok).toBe(false)
  const before = (await readOutput(h.output)).frameCount
  await setSource('internal')
  await expect
    .poll(async () => (await readOutput(h.output)).frameCount)
    .toBeGreaterThan(before + 10)
})

test('Ableton Link: joins a session, follows its tempo, and beat 1 lines up within a frame', async () => {
  test.skip(!linkBuilt, 'Link module not built (npm run build:link)')
  test.setTimeout(60_000)
  const req = createRequire(__filename)
  const { AbletonLink } = req(LINK_MODULE) as { AbletonLink: new (bpm: number) => LinkPeer }
  const peer = new AbletonLink(133)
  peer.enable(true)
  try {
    await setSource('link')
    await expect
      .poll(async () => (await beat()).external?.text ?? '', { timeout: 15_000 })
      .toMatch(/1 other app/)
    peer.setTempo(133)
    await expect.poll(async () => (await beat()).bpm, { timeout: 10_000 }).toBeCloseTo(133, 1)
    expect(peer.getNumPeers()).toBe(1)
    // Let the clock converge, then compare bar positions at the same instant.
    await h.output.waitForTimeout(2000)
    const diffs: number[] = []
    for (let i = 0; i < 10; i++) {
      const c = await clockNow()
      const nowEpoch = performance.timeOrigin + performance.now()
      const peerPhase = peer.getPhase(4)
      const beatMs = 60000 / peer.getTempo()
      const peerAtApp = peerPhase - (nowEpoch - c.epochMs) / beatMs
      // Our visual timeline leads by the latency offset (0 here).
      const ours = c.pos + c.barOffset - c.latencyOffsetMs / beatMs
      let d = (((ours - peerAtApp) % 4) + 4) % 4
      if (d > 2) d -= 4
      diffs.push(d * beatMs)
      await h.output.waitForTimeout(150)
    }
    const worst = Math.max(...diffs.map(Math.abs))
    console.log(
      `Link alignment: ${diffs.map((d) => d.toFixed(2)).join(', ')} ms (worst ${worst.toFixed(2)} ms)`,
    )
    test.info().annotations.push({
      type: 'measurements',
      description: `Link beat-1 offset worst ${worst.toFixed(2)} ms`,
    })
    expect(worst).toBeLessThan(1000 / 60)
    // Changing tempo in Veejus proposes it to the session.
    await sendToOutput(h.control, { type: 'beatCommand', command: { type: 'setBpm', bpm: 140 } })
    await expect.poll(() => peer.getTempo(), { timeout: 5000 }).toBeCloseTo(140, 1)
  } finally {
    peer.enable(false)
    await setSource('internal')
  }
})
