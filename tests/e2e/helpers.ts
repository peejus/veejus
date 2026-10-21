import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const FIXTURES = resolve(__dirname, '../../fixtures')
const MAIN = resolve(__dirname, '../../out/main/index.js')

export interface OutputTestState {
  background: [number, number, number]
  frameCount: number
  overlayVisible: boolean
  canvas: { width: number; height: number }
  frameStats: { fps: number; frameTimeMaxMs: number; droppedFrames: number }
  settings: { loop: boolean; speed: number; fit: string }
  clipStates: Record<string, string>
  media: { readyClips: number; loadingClips: number; warmVideos: number; imageBytes: number }
  audio: {
    status: { state: string; label?: string; error?: string; sampleRate?: number }
    onsetCounts: { low: number; high: number }
    bands: number[]
    rms: number
    latencyMs: number
  }
  beat: import('../../src/shared/beat').BeatState
  trigger: {
    state: import('../../src/shared/pads').TriggerState
    recentActions: {
      type: 'start' | 'restart' | 'stop'
      padId: string
      clipId?: string
      atMs: number
      startPos?: number
      posAtFire: number
    }[]
    beatsPerMs: number
    owner: string | null
    opacity: number
    speedOverride: number | null
  }
  layers: Record<
    'background' | 'overlayA' | 'overlayB' | 'takeover',
    {
      clipId: string | null
      owner: string | null
      paused: boolean
      transform: { cx: number; cy: number; w: number; h: number; rotation: number } | null
      opacity: number
    }
  >
  takeoverActive: boolean
  fx: { passes: number; history: number }
  current: {
    id: string
    kind: 'video' | 'image'
    started: boolean
    width: number
    height: number
    imageFrame: number | null
    videoTime: number | null
  } | null
}

export interface AppHandles {
  app: ElectronApplication
  control: Page
  output: Page
}

export async function launchApp(extraArgs: string[] = []): Promise<AppHandles> {
  const app = await electron.launch({
    args: [MAIN, ...extraArgs],
    // A fresh profile per launch: first-run state, no leftovers from earlier runs.
    env: { ...process.env, VEEJUS_USER_DATA: mkdtempSync(join(tmpdir(), 'veejus-test-')) },
  })
  const find = async (title: string) => {
    await expect
      .poll(async () => {
        for (const w of app.windows()) if ((await w.title()) === title) return true
        return false
      })
      .toBe(true)
    for (const w of app.windows()) if ((await w.title()) === title) return w
    throw new Error(`No window titled ${title}`)
  }
  const control = await find('Veejus Control')
  const output = await find('Veejus Output')
  await expect(control.getByTestId('output-status')).toHaveAttribute('data-state', 'connected')
  return { app, control, output }
}

export function readOutput(output: Page): Promise<OutputTestState> {
  return output.evaluate(() =>
    (
      globalThis as unknown as { __veejusOutput: { getState(): OutputTestState } }
    ).__veejusOutput.getState(),
  )
}

/** RGBA at fractional canvas position, read right after the next drawn frame. */
export function samplePixel(output: Page, fx: number, fy: number): Promise<number[] | null> {
  return output.evaluate(
    ([x, y]) =>
      (
        globalThis as unknown as {
          __veejusOutput: { samplePixel(x: number, y: number): Promise<number[] | null> }
        }
      ).__veejusOutput.samplePixel(x!, y!),
    [fx, fy],
  )
}

/** Import paths through the same main-process request the UI uses (no OS dialog needed). */
export function importPaths(control: Page, paths: string[]) {
  return control.evaluate(
    (p) =>
      (
        globalThis as unknown as {
          veejus: { request(r: unknown): Promise<{ type: string; result?: unknown }> }
        }
      ).veejus.request({ type: 'importPaths', paths: p }),
    paths,
  )
}

export const pad = (control: Page, name: string) => control.locator(`[data-clip-name="${name}"]`)

/** True if two RGB(A) colors are within `tol` per channel. */
export function near(a: number[] | null, b: readonly number[], tol = 6): boolean {
  if (!a) return false
  return b.every((v, i) => Math.abs(a[i]! - v) <= tol)
}

/** Send a message to the output as the control window would. */
export function sendToOutput(control: Page, msg: unknown) {
  return control.evaluate(
    (m) =>
      (globalThis as unknown as { veejus: { sendToOutput(m: unknown): void } }).veejus.sendToOutput(
        m,
      ),
    msg,
  )
}

export type SetupTabName = 'Audio' | 'Output' | 'Clock' | 'Diagnostics'

/** Open the Setup drawer (if closed) at a tab. */
export async function openSetup(control: Page, tab: SetupTabName) {
  if (!(await control.getByTestId('setup-drawer').isVisible())) {
    await control.getByRole('button', { name: 'Setup', exact: true }).click()
  }
  await control.getByRole('tab', { name: tab, exact: true }).click()
}

export async function closeSetup(control: Page) {
  if (await control.getByTestId('setup-drawer').isVisible()) {
    await control.getByRole('button', { name: 'Close setup' }).click()
  }
}

/** Open the pad editor's "More settings" section if it is closed (it remembers its state). */
export async function showMoreSettings(control: Page) {
  const more = control.getByTestId('pad-advanced')
  if ((await more.getAttribute('open')) === null) await more.locator('summary').first().click()
  await expect(more).toHaveAttribute('open', '')
}
