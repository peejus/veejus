import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { resolve } from 'node:path'
import { closeSetup, openSetup } from './helpers'

let app: ElectronApplication
let control: Page
let output: Page

interface OutputTestState {
  background: [number, number, number]
  frameCount: number
  overlayVisible: boolean
}

const readOutput = (page: Page) =>
  page.evaluate(() =>
    (
      globalThis as unknown as { __veejusOutput: { getState(): OutputTestState } }
    ).__veejusOutput.getState(),
  )

async function windowWithTitle(title: string): Promise<Page> {
  await expect
    .poll(async () => {
      for (const w of app.windows()) if ((await w.title()) === title) return true
      return false
    })
    .toBe(true)
  for (const w of app.windows()) if ((await w.title()) === title) return w
  throw new Error(`No window titled ${title}`)
}

test.beforeAll(async () => {
  app = await electron.launch({ args: [resolve(__dirname, '../../out/main/index.js')] })
  control = await windowWithTitle('Veejus Control')
  output = await windowWithTitle('Veejus Output')
})

test.afterAll(async () => {
  await app?.close()
})

test('opens a control window and an output window', async () => {
  expect(app.windows()).toHaveLength(2)
  await expect(control.getByRole('heading', { name: 'Veejus' })).toBeVisible()
  await expect(control.getByTestId('output-status')).toHaveAttribute('data-state', 'connected')
})

test('output render loop is running', async () => {
  const first = (await readOutput(output)).frameCount
  await expect.poll(async () => (await readOutput(output)).frameCount).toBeGreaterThan(first + 10)
  await expect(control.getByTestId('output-fps')).not.toHaveText('-- fps')
})

test('IPC ping/pong round trip is measured', async () => {
  await openSetup(control, 'Diagnostics')
  await expect(control.getByTestId('ping-ms')).toHaveText(/IPC \d+(\.\d+)? ms/)
})

test('changing the background in control changes the output', async () => {
  await openSetup(control, 'Output')
  await control.getByTestId('swatch-ff2bd6').click()
  await expect
    .poll(async () => (await readOutput(output)).background)
    .toEqual([1, 0x2b / 255, 0xd6 / 255])
  await expect(control.getByTestId('bg-latency')).toHaveText(/drawn in \d+(\.\d+)? ms/)

  await control.getByLabel('Background color').fill('#1a6bff')
  await expect
    .poll(async () => (await readOutput(output)).background)
    .toEqual([0x1a / 255, 0x6b / 255, 1])
})

test('debug overlay starts hidden (the audience sees it) and can be toggled', async () => {
  await expect(output.getByTestId('debug-overlay')).toBeHidden()
  await expect(output.getByTestId('metronome')).toBeHidden()
  await openSetup(control, 'Diagnostics')
  await control.getByLabel('Debug overlay').click()
  await expect(output.getByTestId('debug-overlay')).toBeVisible()
  await expect(output.getByTestId('metronome')).toBeVisible()
  await control.getByLabel('Debug overlay').click()
  await expect(output.getByTestId('debug-overlay')).toBeHidden()
})

test('the tempo panel says when there is no audio input', async () => {
  await closeSetup(control)
  await expect(control.getByTestId('no-audio')).toHaveText('No audio input: choose one')
  await control.getByTestId('no-audio').click()
  // It opens Setup at the audio input, ready to pick one.
  await expect(control.getByRole('tab', { name: 'Audio', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(control.locator('#audio-panel select').first()).toBeFocused()
  await expect(control.getByTestId('audio-status')).toHaveText('Audio: off')
})

test('output can go fullscreen and back', async () => {
  await openSetup(control, 'Output')
  await control.getByTestId('setup-drawer').getByRole('button', { name: 'Go fullscreen' }).click()
  await expect(control.getByTestId('output-fullscreen')).toHaveText('yes')
  await control.getByTestId('setup-drawer').getByRole('button', { name: 'Exit fullscreen' }).click()
  await expect(control.getByTestId('output-fullscreen')).toHaveText('no')
})

test('the status bar names the output display and toggles fullscreen', async () => {
  await closeSetup(control)
  await expect(control.getByTestId('output-status')).toHaveText(/^Output: /)
  await control.getByRole('banner').getByRole('button', { name: 'Fullscreen' }).click()
  await expect(control.getByTestId('output-fullscreen')).toHaveText('yes')
  await expect(control.getByTestId('output-status')).toHaveText(/· fullscreen$/)
  await control.getByRole('banner').getByRole('button', { name: 'Exit fullscreen' }).click()
  await expect(control.getByTestId('output-fullscreen')).toHaveText('no')
  await openSetup(control, 'Output')
})

test('Esc in the output window exits fullscreen', async () => {
  await control.getByTestId('setup-drawer').getByRole('button', { name: 'Go fullscreen' }).click()
  await expect(control.getByTestId('output-fullscreen')).toHaveText('yes')
  await output.keyboard.press('Escape')
  await expect(control.getByTestId('output-fullscreen')).toHaveText('no')
})

test('lists at least one display', async () => {
  await openSetup(control, 'Output')
  await expect(control.getByTestId('display-list').locator('li')).not.toHaveCount(0)
})

test('output can be sent to another display and back', async () => {
  const rows = control.getByTestId('display-list').locator('li')
  test.skip((await rows.count()) < 2, 'needs at least two displays')

  const home = control.getByTestId('display-list').locator('li.current')
  const homeLabel = (await home.innerText()).split(' · ')[0]!
  await rows.getByRole('button', { name: 'Send output here' }).first().click()
  await expect(rows.filter({ hasText: homeLabel }).getByRole('button')).toBeVisible()

  // Fullscreen on the new display, then come back home; fullscreen should be kept.
  await control.getByTestId('setup-drawer').getByRole('button', { name: 'Go fullscreen' }).click()
  await expect(control.getByTestId('output-fullscreen')).toHaveText('yes')
  await rows
    .filter({ hasText: homeLabel })
    .getByRole('button', { name: 'Send output here' })
    .click()
  await expect(rows.filter({ hasText: homeLabel })).toHaveClass('current')
  await expect(control.getByTestId('output-fullscreen')).toHaveText('yes')
  await control.getByTestId('setup-drawer').getByRole('button', { name: 'Exit fullscreen' }).click()
  await expect(control.getByTestId('output-fullscreen')).toHaveText('no')
})
