import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FIXTURES, newProfile, pad } from './helpers'

// The packaged app (npm run dist): it starts, connects its windows, plays a clip, and finds
// the bundled Ableton Link module. Skipped until the installer has been built.

const EXE = resolve(
  __dirname,
  process.platform === 'darwin'
    ? `../../dist/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Veejus.app/Contents/MacOS/Veejus`
    : '../../dist/win-unpacked/Veejus.exe',
)

test.skip(!existsSync(EXE), 'packaged app not built (npm run dist, or dist:mac on a Mac)')

test('the packaged app starts and plays', async () => {
  test.setTimeout(60_000)
  const app = await electron.launch({
    executablePath: EXE,
    env: { ...process.env, VEEJUS_USER_DATA: newProfile() },
  })
  try {
    const find = async (title: string) => {
      await expect
        .poll(async () => {
          for (const w of app.windows()) if ((await w.title()) === title) return true
          return false
        })
        .toBe(true)
      for (const w of app.windows()) if ((await w.title()) === title) return w
      throw new Error(title)
    }
    const control = await find('Veejus Control')
    const output = await find('Veejus Output')
    await expect(control.getByTestId('output-status')).toHaveAttribute('data-state', 'connected')
    expect(await app.evaluate(({ app: a }) => a.isPackaged)).toBe(true)

    await control.evaluate(
      (p) =>
        (
          globalThis as unknown as { veejus: { request(r: unknown): Promise<unknown> } }
        ).veejus.request({ type: 'importPaths', paths: [p] }),
      join(FIXTURES, 'media'),
    )
    await expect(pad(control, 'bounce.png')).toHaveAttribute('data-state', 'ready', {
      timeout: 15_000,
    })
    await pad(control, 'bounce.png').dblclick()
    await expect
      .poll(() =>
        output.evaluate(
          () =>
            (
              globalThis as unknown as {
                __veejusOutput: { getState(): { current: { started: boolean } | null } }
              }
            ).__veejusOutput.getState().current?.started ?? false,
        ),
      )
      .toBe(true)

    // Ableton Link loads from resources/native when it was built before packaging.
    const linkBundled = existsSync(
      resolve(__dirname, '../../dist/win-unpacked/resources/native/abletonlink.node'),
    )
    if (linkBundled) {
      await control.evaluate(() =>
        (
          globalThis as unknown as { veejus: { sendToOutput(m: unknown): void } }
        ).veejus.sendToOutput({
          type: 'beatCommand',
          command: { type: 'setClockSource', source: 'link' },
        }),
      )
      await expect(control.getByTestId('external-status')).toContainText(/Link: \d/, {
        timeout: 10_000,
      })
    }
  } finally {
    await app.close()
  }
})
