import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  screen,
  session,
  systemPreferences,
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
import {
  SetStore,
  findFilesByName,
  locateClip,
  readSetFile,
  withRelativePaths,
  writeAtomic,
} from './sets'
import { SET_EXTENSION, type SetClip, type VeejusSet } from '@shared/set'
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
// Never show Electron's error dialog on stage: log the error and keep running.
process.on('uncaughtException', (err) => console.error('[veejus] uncaught exception:', err))
process.on('unhandledRejection', (err) => console.error('[veejus] unhandled rejection:', err))
// Tests run each launch in a fresh profile so window storage never leaks between runs (or
// into a performer's own settings).
if (process.env['VEEJUS_USER_DATA']) app.setPath('userData', process.env['VEEJUS_USER_DATA'])

const library = new Library()
const sets = new SetStore(app.getPath('userData'))
const link = new LinkManager(
  linkModulePath(__dirname, app.isPackaged, process.resourcesPath),
  (sample) => outputWin?.webContents.send(Channel.link, sample),
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
  // A crashed control UI reloads and restores the autosaved set; the output keeps playing.
  recoverOnCrash(win, 'control')
  loadPage(win, 'control')
  return win
}

/** Reload a window whose renderer died (never leave a dead window or an error dialog). */
function recoverOnCrash(win: BrowserWindow, page: 'control' | 'output'): void {
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[veejus] ${page} renderer gone: ${details.reason} (${details.exitCode})`)
    crashLog.push({ page, reason: details.reason, at: Date.now() })
    if (quitting || win.isDestroyed() || details.reason === 'clean-exit') return
    // Back off if it keeps dying, so a crash loop can't spin the CPU.
    const recent = crashLog.filter((c) => c.page === page && Date.now() - c.at < 60_000)
    setTimeout(() => !win.isDestroyed() && loadPage(win, page), recent.length > 3 ? 5000 : 200)
  })
  win.webContents.on('unresponsive', () => console.warn(`[veejus] ${page} window unresponsive`))
}

const crashLog: { page: string; reason: string; at: number }[] = []

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
  // A crashed output reloads in place (same display, still fullscreen); the black window
  // background shows meanwhile, never the desktop.
  recoverOnCrash(win, 'output')
  win.on('enter-full-screen', broadcastOutputState)
  win.on('leave-full-screen', broadcastOutputState)
  win.on('show', broadcastOutputState)
  win.on('hide', broadcastOutputState)
  win.on('moved', broadcastOutputState)

  // Esc leaves fullscreen, F11 (or ⌃⌘F, the macOS convention) toggles it. Handled here so it
  // works whatever the page does; the page also forwards these keys as output commands for
  // input that bypasses this hook.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'Escape' && win.isFullScreen()) {
      e.preventDefault()
      win.setFullScreen(false)
    } else if (input.key === 'F11' || (input.meta && input.control && input.code === 'KeyF')) {
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

const SET_FILTERS = [{ name: 'Veejus set', extensions: [SET_EXTENSION] }]

/** Replace the library with a set's clips, finding moved media. */
async function loadSet(
  set: VeejusSet,
  setPath: string | null,
  dirty: boolean,
): Promise<MainResponse> {
  library.clear()
  const found: { clip: SetClip; path: string }[] = []
  const missing: SetClip[] = []
  for (const clip of set.clips) {
    const path = locateClip(clip, setPath)
    if (path) found.push({ clip, path })
    else missing.push(clip)
  }
  const ids = await library.load(
    found.map(({ clip, path }) => ({ path, tags: clip.tags, favorite: clip.favorite })),
  )
  const idMap: Record<string, string> = {}
  for (const { clip, path } of found) {
    const id = ids.get(path)
    if (id && id !== clip.id) idMap[clip.id] = id
  }
  broadcastLibrary()
  return { type: 'setLoaded', set, path: setPath, dirty, idMap, missing }
}

async function saveSet(
  set: VeejusSet,
  path: string | null,
  saveAs: boolean,
): Promise<MainResponse> {
  let target = path
  if (!target || saveAs) {
    const options: Electron.SaveDialogOptions = {
      title: 'Save set',
      defaultPath: target ?? join(app.getPath('documents'), `My set.${SET_EXTENSION}`),
      filters: SET_FILTERS,
    }
    const r = controlWin
      ? await dialog.showSaveDialog(controlWin, options)
      : await dialog.showSaveDialog(options)
    if (r.canceled || !r.filePath) return { type: 'canceled' }
    target = r.filePath
  }
  await writeAtomic(target, JSON.stringify(withRelativePaths(set, target), null, 2))
  await sets.addRecent(target)
  return { type: 'setSaved', path: target }
}

async function openSet(path: string | null): Promise<MainResponse> {
  let target = path
  if (!target) {
    const options: Electron.OpenDialogOptions = {
      title: 'Open set',
      properties: ['openFile'],
      filters: SET_FILTERS,
    }
    const r = controlWin
      ? await dialog.showOpenDialog(controlWin, options)
      : await dialog.showOpenDialog(options)
    if (r.canceled || !r.filePaths[0]) return { type: 'canceled' }
    target = r.filePaths[0]
  }
  const read = await readSetFile(target)
  if (!read.ok) return { type: 'error', message: read.reason }
  await sets.addRecent(target)
  return loadSet(read.set, target, false)
}

async function relink(
  folder: string | null,
  clips: { id: string; name: string }[],
): Promise<MainResponse> {
  let dir = folder
  if (!dir) {
    const options: Electron.OpenDialogOptions = {
      title: 'Find missing clips in…',
      properties: ['openDirectory'],
    }
    const r = controlWin
      ? await dialog.showOpenDialog(controlWin, options)
      : await dialog.showOpenDialog(options)
    if (r.canceled || !r.filePaths[0]) return { type: 'canceled' }
    dir = r.filePaths[0]
  }
  const found = await findFilesByName(
    dir,
    clips.map((c) => c.name),
  )
  const idMap: Record<string, string> = {}
  const missing: string[] = []
  for (const c of clips) {
    const path = found.get(c.name.toLowerCase())
    if (!path) {
      missing.push(c.id)
      continue
    }
    const ids = await library.load([{ path, tags: [], favorite: false }])
    const id = ids.get(path)
    if (id) idMap[c.id] = id
  }
  if (Object.keys(idMap).length > 0) broadcastLibrary()
  return { type: 'relinked', idMap, missing }
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
    case 'setClipMeta':
      if (library.setMeta(req.id, req)) broadcastLibrary()
      return { type: 'library', clips: library.list() }
    case 'saveSet':
      return saveSet(req.set, req.path, req.saveAs)
    case 'openSet':
      return openSet(req.path)
    case 'newSet':
      library.clear()
      broadcastLibrary()
      return { type: 'ok' }
    case 'autosave':
      await sets.writeAutosave({ set: req.set, path: req.path, dirty: req.dirty })
      return { type: 'ok' }
    case 'restoreSession': {
      const saved = await sets.readAutosave()
      return saved ? loadSet(saved.set, saved.path, saved.dirty) : { type: 'noSession' }
    }
    case 'listRecentSets':
      return { type: 'recentSets', sets: await sets.recent() }
    case 'relink':
      return relink(req.folder, req.clips)
  }
}

const OUTPUT_REQUESTS = new Set<MainRequest['type']>([
  'moveOutputToDisplay',
  'setOutputFullscreen',
  'showOutput',
])

/**
 * Media permissions: only the output window may capture, and only audio. System-audio
 * loopback (Windows only; Electron has no macOS loopback) arrives through getDisplayMedia; main answers with the primary screen
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
      if (!types.every((t) => t === 'audio')) {
        callback(false)
      } else if (process.platform === 'darwin') {
        // macOS asks the user once for microphone access (Info.plist carries the reason).
        systemPreferences
          .askForMediaAccess('microphone')
          .then(callback)
          .catch(() => callback(false))
      } else {
        callback(true)
      }
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
