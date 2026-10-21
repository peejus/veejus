import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  screen,
  session,
  webContents,
  type Display,
  type IpcMainEvent,
} from 'electron'
import { join } from 'node:path'
import {
  Channel,
  isControlToOutput,
  isMainRequest,
  isOutputCommand,
  isOutputToControl,
  type DisplayInfo,
  type MainRequest,
  type MainResponse,
  type OutputWindowState,
} from '@shared/protocol'
import { Library } from './library'
import { LinkManager, linkModulePath } from './link'
import { handleMediaProtocol, registerMediaScheme } from './mediaProtocol'

// Keep paused, preloaded video players decoded so a trigger starts on the next frame,
// and let muted clips autoplay without a user gesture.
app.commandLine.appendSwitch('disable-media-suspend')
app.commandLine.appendSwitch('disable-background-media-suspend')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// Hardware video decoders stall the GPU process for a frame or more each time one starts,
// which shows as output hitches while clips preload. Short VJ clips decode cheaply on the
// CPU, so software decoding is the default. Set VEEJUS_HW_VIDEO_DECODE=1 to opt back in.
if (process.env['VEEJUS_HW_VIDEO_DECODE'] !== '1') {
  app.commandLine.appendSwitch('disable-accelerated-video-decode')
}
registerMediaScheme()
// Tests run each launch in a fresh profile so window storage never leaks between runs (or
// into a performer's own settings).
if (process.env['VEEJUS_USER_DATA']) app.setPath('userData', process.env['VEEJUS_USER_DATA'])

const library = new Library()
const link = new LinkManager(linkModulePath(__dirname), (sample) =>
  outputWin?.webContents.send(Channel.link, sample),
)
let controlWin: BrowserWindow | null = null
let outputWin: BrowserWindow | null = null
let quitting = false

function loadPage(win: BrowserWindow, page: 'control' | 'output'): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}/${page}/index.html`)
  else void win.loadFile(join(__dirname, `../renderer/${page}/index.html`))
}

function lockDown(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
}

function createControlWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Veejus Control',
    backgroundColor: '#14141a',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/control.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  lockDown(win)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    controlWin = null
    app.quit()
  })
  loadPage(win, 'control')
  return win
}

function createOutputWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 540,
    title: 'Veejus Output',
    backgroundColor: '#000000',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/output.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The output must keep rendering at full rate when it is not focused.
      backgroundThrottling: false,
    },
  })
  win.setMenu(null)
  lockDown(win)
  win.once('ready-to-show', () => {
    win.show()
    broadcastOutputState()
  })

  // Closing the output only hides it; the control window can show it again.
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    if (win.isFullScreen()) win.setFullScreen(false)
    win.hide()
  })
  win.on('closed', () => (outputWin = null))
  win.on('enter-full-screen', broadcastOutputState)
  win.on('leave-full-screen', broadcastOutputState)
  win.on('show', broadcastOutputState)
  win.on('hide', broadcastOutputState)
  win.on('moved', broadcastOutputState)

  // Esc leaves fullscreen, F11 toggles it. Handled here so it works whatever the page does;
  // the page also forwards these keys as output commands for input that bypasses this hook.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'Escape' && win.isFullScreen()) {
      e.preventDefault()
      win.setFullScreen(false)
    } else if (input.key === 'F11') {
      e.preventDefault()
      win.setFullScreen(!win.isFullScreen())
    }
  })

  loadPage(win, 'output')
  return win
}

function displayLabel(d: Display, index: number): string {
  return d.label && d.label.trim() ? d.label : `Display ${index + 1}`
}

function listDisplays(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: displayLabel(d, i),
    width: d.size.width,
    height: d.size.height,
    scaleFactor: d.scaleFactor,
    primary: d.id === primaryId,
  }))
}

function outputState(): OutputWindowState {
  if (!outputWin || outputWin.isDestroyed()) {
    return { displayId: null, fullscreen: false, visible: false }
  }
  return {
    displayId: screen.getDisplayMatching(outputWin.getBounds()).id,
    fullscreen: outputWin.isFullScreen(),
    visible: outputWin.isVisible(),
  }
}

function broadcastOutputState(): void {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send(Channel.outputState, outputState())
  }
}

function setFullscreenAndWait(win: BrowserWindow, target: boolean): Promise<void> {
  if (win.isFullScreen() === target) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      win.removeListener('enter-full-screen', done)
      win.removeListener('leave-full-screen', done)
      resolve()
    }, 1500)
    if (target) win.once('enter-full-screen', done)
    else win.once('leave-full-screen', done)
    win.setFullScreen(target)
  })
}

async function moveOutputToDisplay(displayId: number): Promise<void> {
  const win = outputWin
  if (!win) throw new Error('Output window is not available')
  const display = screen.getAllDisplays().find((d) => d.id === displayId)
  if (!display) throw new Error(`Unknown display ${displayId}`)

  const wasFullscreen = win.isFullScreen()
  await setFullscreenAndWait(win, false)
  const area = display.workArea
  const [w = 960, h = 540] = win.getSize()
  const width = Math.min(w, area.width)
  const height = Math.min(h, area.height)
  win.setBounds({
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  })
  if (!win.isVisible()) win.show()
  if (wasFullscreen) await setFullscreenAndWait(win, true)
}

function broadcastLibrary(): void {
  const clips = library.list()
  for (const win of [controlWin, outputWin]) {
    if (win && !win.isDestroyed()) win.webContents.send(Channel.library, clips)
  }
}

const MEDIA_EXTENSIONS = ['mp4', 'm4v', 'webm', 'mov', 'gif', 'webp', 'png', 'apng', 'jpg', 'jpeg']

async function pickPaths(mode: 'files' | 'folder'): Promise<string[]> {
  const options: Electron.OpenDialogOptions =
    mode === 'files'
      ? {
          title: 'Add clips',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Video and images', extensions: MEDIA_EXTENSIONS }],
        }
      : { title: 'Add a folder of clips', properties: ['openDirectory'] }
  const result = controlWin
    ? await dialog.showOpenDialog(controlWin, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
}

async function importAndBroadcast(paths: string[]): Promise<MainResponse> {
  const result = await library.importPaths(paths)
  if (result.added > 0) broadcastLibrary()
  return { type: 'imported', result }
}

async function handleMainRequest(req: MainRequest): Promise<MainResponse> {
  switch (req.type) {
    case 'listDisplays':
      return { type: 'displays', displays: listDisplays() }
    case 'getOutputState':
      return { type: 'outputState', state: outputState() }
    case 'moveOutputToDisplay':
      await moveOutputToDisplay(req.displayId)
      return { type: 'outputState', state: outputState() }
    case 'setOutputFullscreen':
      if (!outputWin) throw new Error('Output window is not available')
      if (!outputWin.isVisible()) outputWin.show()
      await setFullscreenAndWait(outputWin, req.fullscreen)
      return { type: 'outputState', state: outputState() }
    case 'showOutput':
      if (!outputWin) outputWin = createOutputWindow()
      outputWin.show()
      return { type: 'outputState', state: outputState() }
    case 'getLibrary':
      return { type: 'library', clips: library.list() }
    case 'importPaths':
      return importAndBroadcast(req.paths)
    case 'pickAndImport':
      return importAndBroadcast(await pickPaths(req.mode))
    case 'removeClips':
      if (library.remove(req.ids) > 0) broadcastLibrary()
      return { type: 'library', clips: library.list() }
  }
}

const OUTPUT_REQUESTS = new Set<MainRequest['type']>([
  'moveOutputToDisplay',
  'setOutputFullscreen',
  'showOutput',
])

/**
 * Media permissions: only the output window may capture, and only audio. System-audio
 * loopback (Windows) arrives through getDisplayMedia; main answers with the primary screen
 * plus loopback audio, and the output discards the video track.
 */
function registerMediaPermissions(): void {
  const isOutput = (wc: Electron.WebContents | null) =>
    !!wc && !!outputWin && !outputWin.isDestroyed() && wc === outputWin.webContents

  const isControl = (wc: Electron.WebContents | null) =>
    !!wc && !!controlWin && !controlWin.isDestroyed() && wc === controlWin.webContents
  // Web MIDI: controllers in the control window, MIDI clock in the output window. Chromium
  // asks for 'midiSysex' even when SysEx isn't requested, so both names are allowed (only for
  // our own two windows); Veejus never sends or reads SysEx.
  const midiOk = (wc: Electron.WebContents | null, permission: string) =>
    (permission === 'midi' || permission === 'midiSysex') && (isControl(wc) || isOutput(wc))

  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (midiOk(wc, permission)) {
      callback(true)
      return
    }
    if (permission === 'media' && isOutput(wc)) {
      const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : []
      callback(types.every((t) => t === 'audio'))
      return
    }
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(
    (wc, permission) => (permission === 'media' && isOutput(wc)) || midiOk(wc, permission),
  )
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const requester = request.frame ? (webContents.fromFrame(request.frame) ?? null) : null
    if (!isOutput(requester) || process.platform !== 'win32') {
      callback({})
      return
    }
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
      .catch(() => callback({}))
  })
}

function registerIpc(): void {
  const fromControl = (e: IpcMainEvent) => !!controlWin && e.sender === controlWin.webContents
  const fromOutput = (e: Pick<IpcMainEvent, 'sender'>) =>
    !!outputWin && e.sender === outputWin.webContents

  // Renderer-to-renderer messages are validated, then forwarded unchanged.
  ipcMain.on(Channel.toOutput, (e, msg: unknown) => {
    if (!fromControl(e) || !isControlToOutput(msg)) return
    outputWin?.webContents.send(Channel.toOutput, msg)
  })

  ipcMain.on(Channel.toControl, (e, msg: unknown) => {
    if (!fromOutput(e) || !isOutputToControl(msg)) return
    controlWin?.webContents.send(Channel.toControl, msg)
  })

  ipcMain.on(Channel.outputCommand, (e, cmd: unknown) => {
    if (!fromOutput(e) || !isOutputCommand(cmd) || !outputWin) return
    switch (cmd.type) {
      case 'exitFullscreen':
        outputWin.setFullScreen(false)
        break
      case 'toggleFullscreen':
        outputWin.setFullScreen(!outputWin.isFullScreen())
        break
      case 'link':
        link.setEnabled(cmd.enabled, cmd.bpm)
        break
      case 'linkTempo':
        link.setTempo(cmd.bpm)
        break
    }
  })

  ipcMain.handle(Channel.mainRequest, async (e, req: unknown): Promise<MainResponse> => {
    if (!controlWin || e.sender !== controlWin.webContents) {
      return { type: 'error', message: 'Requests are only accepted from the control window' }
    }
    if (!isMainRequest(req)) return { type: 'error', message: 'Malformed request' }
    try {
      return await handleMainRequest(req)
    } catch (err) {
      return { type: 'error', message: err instanceof Error ? err.message : String(err) }
    } finally {
      if (OUTPUT_REQUESTS.has(req.type)) broadcastOutputState()
    }
  })

  ipcMain.handle(Channel.getLibrary, (e) => (fromOutput(e) ? library.list() : []))
}

app.whenReady().then(() => {
  handleMediaProtocol(library)
  registerMediaPermissions()
  registerIpc()
  controlWin = createControlWindow()
  outputWin = createOutputWindow()
  screen.on('display-added', broadcastOutputState)
  screen.on('display-removed', broadcastOutputState)
  screen.on('display-metrics-changed', broadcastOutputState)
})

app.on('before-quit', () => {
  quitting = true
  link.dispose()
})

app.on('window-all-closed', () => app.quit())
