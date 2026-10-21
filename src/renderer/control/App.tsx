import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DisplayInfo, LayerSettings } from '@shared/protocol'
import type { FxScope } from '@shared/fx'
import { hexToRgb } from '@shared/color'
import { NUDGE_MS } from '@shared/beat'
import { BeatPanel } from './BeatPanel'
import { Mixer, PreviewMonitor } from './LayersPanel'
import { PadEditor } from './PadEditor'
import { FxPanel } from './FxPanel'
import { useFx } from './useFx'
import { useBlackoutShortcut, useLayers } from './useLayers'
import { PadGrid } from './PadGrid'
import { usePads, usePadShortcuts } from './usePads'
import { bridge, request } from './bridge'
import { LibraryPanel } from './LibraryPanel'
import { ClipInspector } from './PlaybackPanel'
import { SetupDrawer, type SetupTab } from './SetupDrawer'
import { ShortcutSheet, useShortcutSheet } from './ShortcutSheet'
import { FirstRun } from './FirstRun'
import { useAudio } from './useAudio'
import { useBeat, useBeatShortcuts } from './useBeat'
import { useLibrary } from './useLibrary'
import { useOutputLink } from './useOutputLink'

/** What the context panel (right column, under the beat strip) is showing. */
type Context =
  { kind: 'none' } | { kind: 'pad' } | { kind: 'fx'; scope: FxScope } | { kind: 'clip' }

export function App() {
  const link = useOutputLink()
  const library = useLibrary()
  const audio = useAudio()
  const beat = useBeat()
  // First, so Esc can close the sheet without reaching "Stop all".
  const keys = useShortcutSheet()
  useBeatShortcuts(beat.command, NUDGE_MS)
  const pads = usePads()
  usePadShortcuts(pads)
  const layers = useLayers()
  const fx = useFx()
  useBlackoutShortcut(layers)
  const { setBackground, send } = link
  const [color, setColor] = useState('#000000')
  // The overlay is visible to the audience, so it starts off.
  const [overlay, setOverlay] = useState(false)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [layerSettings, setLayerSettings] = useState<LayerSettings>({
    loop: true,
    speed: 1,
    fit: 'contain',
  })
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupTab, setSetupTab] = useState<SetupTab>('audio')
  const [context, setContext] = useState<Context>({ kind: 'none' })
  const [selectedClip, setSelectedClip] = useState<string | null>(null)

  const refreshDisplays = useCallback(() => {
    request({ type: 'listDisplays' }, 'displays')
      .then((res) => setDisplays(res.displays))
      .catch((e: Error) => setError(e.message))
  }, [])

  // Displays can be plugged in or removed at any time; main re-broadcasts state when they are.
  useEffect(refreshDisplays, [refreshDisplays, link.state])

  // Selecting a pad (right-click, ✎, or dropping a clip on it) shows it in the context panel.
  const { selected: selectedPad, select: selectPad } = pads
  const [seenPad, setSeenPad] = useState(selectedPad)
  if (selectedPad !== seenPad) {
    setSeenPad(selectedPad)
    if (selectedPad) setContext({ kind: 'pad' })
  }

  const showContext = (next: Context) => {
    if (next.kind !== 'pad') selectPad(null)
    setContext(next)
  }

  const selectClip = useCallback(
    (id: string | null) => {
      setSelectedClip(id)
      if (id) {
        selectPad(null)
        setContext({ kind: 'clip' })
      }
    },
    [selectPad],
  )

  const toggleFx = (scope: FxScope) =>
    showContext(
      context.kind === 'fx' && context.scope === scope ? { kind: 'none' } : { kind: 'fx', scope },
    )

  const openSetup = (tab: SetupTab) => {
    setSetupTab(tab)
    setSetupOpen(true)
    if (tab === 'audio') {
      // Put the input picker under the keyboard once the drawer has rendered.
      requestAnimationFrame(() =>
        document.querySelector<HTMLSelectElement>('#audio-panel select')?.focus(),
      )
    }
  }

  const { markPlayRequested } = library
  const playClip = useCallback(
    (id: string) => {
      markPlayRequested(id)
      bridge.sendToOutput({ type: 'playClip', id, settings: layerSettings })
    },
    [markPlayRequested, layerSettings],
  )

  const changeLayerSettings = (settings: LayerSettings) => {
    setLayerSettings(settings)
    send({ type: 'setLayerSettings', settings })
  }

  const applyColor = (hex: string) => {
    const rgb = hexToRgb(hex)
    if (!rgb) return
    setColor(hex)
    setBackground(rgb)
  }

  const run = (p: Promise<unknown>) => {
    setError(null)
    p.catch((e: Error) => setError(e.message))
  }

  const toggleOverlay = () => {
    const next = !overlay
    setOverlay(next)
    send({ type: 'setDebugOverlay', visible: next })
  }

  const setFullscreen = (fullscreen: boolean) =>
    run(request({ type: 'setOutputFullscreen', fullscreen }, 'outputState'))

  const { stats } = link
  const outputDisplay = displays.find((d) => d.id === link.state.displayId)
  const outputPill = !link.connected
    ? { state: 'bad', text: 'Output: waiting…' }
    : !link.state.visible
      ? { state: 'warn', text: 'Output hidden' }
      : {
          state: 'ok',
          text: `Output: ${outputDisplay?.label ?? 'window'}${link.state.fullscreen ? ' · fullscreen' : ''}`,
        }
  const a = audio.status
  const audioPill =
    a.state === 'running'
      ? { state: 'ok', text: `Audio: ${a.label ?? 'on'}` }
      : a.state === 'starting'
        ? { state: 'warn', text: 'Audio: starting…' }
        : a.state === 'error'
          ? { state: 'bad', text: 'Audio: error' }
          : { state: 'warn', text: 'Audio: off' }

  const clip = library.clips.find((c) => c.id === selectedClip)
  /** How many pads (all banks) play each clip. */
  const assigned = useMemo(() => {
    const n: Record<string, number> = {}
    for (const bank of pads.banks)
      for (const p of bank)
        if (p.source?.kind === 'clip') n[p.source.clipId] = (n[p.source.clipId] ?? 0) + 1
    return n
  }, [pads.banks])
  const sel = pads.selected

  return (
    <div className="app">
      <header className="topbar">
        <h1>Veejus</h1>
        <button
          className={`pill ${outputPill.state}`}
          data-testid="output-status"
          data-state={link.connected ? 'connected' : 'waiting'}
          title="Output window and display"
          onClick={() => openSetup('output')}
        >
          {outputPill.text}
        </button>
        <button
          className={`pill ${audioPill.state}`}
          data-testid="audio-status"
          title="Audio input for beat detection"
          onClick={() => openSetup('audio')}
        >
          {audioPill.text}
        </button>
        {link.connected && (
          <button
            className="subtle"
            onClick={() =>
              link.state.visible
                ? setFullscreen(!link.state.fullscreen)
                : run(request({ type: 'showOutput' }, 'outputState'))
            }
          >
            {!link.state.visible
              ? 'Show output'
              : link.state.fullscreen
                ? 'Exit fullscreen'
                : 'Fullscreen'}
          </button>
        )}
        <span className="spacer" />
        <span className="metric" data-testid="output-fps" title="Output frames per second">
          {stats ? `${stats.fps.toFixed(0)} fps` : '-- fps'}
        </span>
        <button
          className="subtle"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          onClick={() => keys.setOpen(!keys.open)}
        >
          ?
        </button>
        <button
          className={`setup-button${setupOpen ? ' on' : ''}`}
          aria-label="Setup"
          aria-pressed={setupOpen}
          title="Audio, output, clock and diagnostics"
          onClick={() => setSetupOpen(!setupOpen)}
        >
          ⚙ Setup
        </button>
      </header>

      <div className="workspace">
        <main className="main-area">
          <FirstRun
            steps={[
              {
                done: library.clips.length > 0,
                label: 'Clips added',
                action: 'Add a folder of clips',
                onAction: () => run(request({ type: 'pickAndImport', mode: 'folder' }, 'imported')),
              },
              {
                done: audio.status.state === 'running',
                label: 'Audio input on',
                action: 'Choose the audio input',
                onAction: () => openSetup('audio'),
              },
              {
                done: link.state.fullscreen || (!!outputDisplay && !outputDisplay.primary),
                label: 'Output screen set',
                action: 'Choose the output screen',
                onAction: () => openSetup('output'),
              },
            ]}
          />
          <PadGrid
            pads={pads}
            beat={beat}
            clips={library.clips}
            probes={library.probes}
            onShowKeys={() => keys.setOpen(true)}
          />
          <Mixer
            layers={layers}
            fx={fx}
            clips={library.clips}
            fxOpen={context.kind === 'fx' ? context.scope : null}
            onFx={toggleFx}
          />
          <LibraryPanel
            library={library}
            onPlay={playClip}
            selectedId={selectedClip}
            onSelect={selectClip}
            assigned={assigned}
          />
        </main>

        <aside className="right-column">
          <PreviewMonitor layers={layers} />
          <BeatPanel
            beat={beat}
            audioState={audio.status.state}
            onAudioSetup={() => openSetup('audio')}
          />
          <section className="panel context-panel" data-testid="context-panel">
            {context.kind !== 'none' && (
              <button
                className="close"
                aria-label="Close panel"
                onClick={() => showContext({ kind: 'none' })}
              >
                ✕
              </button>
            )}
            {context.kind === 'pad' && sel ? (
              <PadEditor pads={pads} clips={library.clips} />
            ) : context.kind === 'fx' ? (
              <FxPanel fx={fx} scope={context.scope} />
            ) : context.kind === 'clip' && clip ? (
              <ClipInspector
                clip={clip}
                settings={layerSettings}
                onChange={changeLayerSettings}
                library={library}
                onPlay={playClip}
                onStop={() => send({ type: 'stopClip' })}
              />
            ) : (
              <div className="context-empty">
                <h2>Nothing selected</h2>
                <p className="hint">
                  Right-click a pad (or ✎) to edit it, press <b>FX</b> on a mixer strip for effects,
                  or click a library clip to inspect and play it.
                </p>
              </div>
            )}
          </section>
        </aside>

        <SetupDrawer
          open={setupOpen}
          tab={setupTab}
          onTab={setSetupTab}
          onClose={() => setSetupOpen(false)}
          audio={audio}
          beat={beat}
          link={link}
          displays={displays}
          color={color}
          onColor={applyColor}
          overlay={overlay}
          onToggleOverlay={toggleOverlay}
          onFullscreen={setFullscreen}
          onShowOutput={() => run(request({ type: 'showOutput' }, 'outputState'))}
          onMoveOutput={(displayId) =>
            run(request({ type: 'moveOutputToDisplay', displayId }, 'outputState'))
          }
        />
      </div>

      {keys.open && <ShortcutSheet onClose={() => keys.setOpen(false)} />}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
