import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import {
  FIXTURES,
  closeSetup,
  importPaths,
  launchApp,
  newProfile,
  openSetup,
  pad,
  readOutput,
  type AppHandles,
} from './helpers'

/**
 * HEVC needs hardware video decoding, which is off by default: the clip says so, and the
 * Diagnostics switch turns it on from the next start.
 */

const HEVC = 'hevc-audio.mov'
const profile = newProfile()
let h: AppHandles | undefined

test.describe.configure({ mode: 'serial' })

// The saved setting decides, not the shell this runs from.
const envBefore = process.env['VEEJUS_HW_VIDEO_DECODE']
test.beforeAll(() => {
  delete process.env['VEEJUS_HW_VIDEO_DECODE']
})
test.afterAll(async () => {
  await h?.app.close()
  if (envBefore === undefined) delete process.env['VEEJUS_HW_VIDEO_DECODE']
  else process.env['VEEJUS_HW_VIDEO_DECODE'] = envBefore
})

const decodeBox = () => h!.control.getByTestId('video-decode')
const decodeCheck = () => decodeBox().getByRole('checkbox', { name: 'Hardware video decoding' })

test('by default an HEVC video says it needs hardware decoding; ProRes says convert', async () => {
  h = await launchApp([], profile)
  await importPaths(h.control, [join(FIXTURES, 'codecs', HEVC), join(FIXTURES, 'media/prores.mov')])
  await expect(pad(h.control, HEVC)).toHaveAttribute('data-state', 'error', { timeout: 15_000 })
  await expect(pad(h.control, HEVC).locator('.pad-error')).toContainText('HEVC (H.265)')
  await pad(h.control, HEVC).click()
  await expect(h.control.getByTestId('clip-error')).toContainText(
    'needs hardware decoding: turn it on in Setup → Diagnostics',
  )
  await expect(pad(h.control, 'prores.mov').locator('.pad-error')).toContainText('ProRes', {
    timeout: 15_000,
  })
})

test('turning hardware decoding on applies after a restart', async () => {
  await openSetup(h!.control, 'Diagnostics')
  await expect(decodeCheck()).not.toBeChecked()
  await expect(h!.control.getByTestId('video-decode-pending')).toHaveCount(0)
  await decodeCheck().check()
  await expect(h!.control.getByTestId('video-decode-pending')).toContainText(
    'Turns on when Veejus restarts',
  )
  await expect(decodeBox().getByRole('button', { name: 'Restart now' })).toBeVisible()
  // Turning it back off before restarting leaves nothing pending.
  await decodeCheck().uncheck()
  await expect(h!.control.getByTestId('video-decode-pending')).toHaveCount(0)
  await decodeCheck().check()
  await h!.app.close()

  h = await launchApp([], profile)
  await openSetup(h.control, 'Diagnostics')
  await expect(decodeCheck()).toBeChecked()
  await expect(h.control.getByTestId('video-decode-pending')).toHaveCount(0)
  await closeSetup(h.control)
})

test('with it on, the HEVC video loads and plays', async () => {
  const c = h!.control
  await importPaths(c, [join(FIXTURES, 'codecs', HEVC)])
  await expect(pad(c, HEVC)).toHaveAttribute('data-state', 'ready', { timeout: 15_000 })
  await pad(c, HEVC).click()
  await c.getByRole('button', { name: `Play ${HEVC} on Background` }).click()
  const id = await pad(c, HEVC).getAttribute('data-clip-id')
  await expect.poll(async () => (await readOutput(h!.output)).layers.background.clipId).toBe(id)
  await expect
    .poll(async () => (await readOutput(h!.output)).layers.background.videoTime ?? 0)
    .toBeGreaterThan(0.2)
})

test('VEEJUS_HW_VIDEO_DECODE overrides the switch for that run', async () => {
  await h!.app.close()
  process.env['VEEJUS_HW_VIDEO_DECODE'] = '0'
  try {
    h = await launchApp([], profile)
  } finally {
    delete process.env['VEEJUS_HW_VIDEO_DECODE']
  }
  await openSetup(h.control, 'Diagnostics')
  await expect(decodeCheck()).toBeDisabled()
  await expect(decodeCheck()).not.toBeChecked()
  await expect(h.control.getByTestId('video-decode-forced')).toContainText('for this run (off)')
})
