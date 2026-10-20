import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { resolve } from 'node:path'

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

export async function launchApp(): Promise<AppHandles> {
  const app = await electron.launch({ args: [MAIN] })
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
  await expect(control.getByTestId('output-status')).toHaveText('Output connected')
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
