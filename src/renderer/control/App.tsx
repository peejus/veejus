import { useCallback, useEffect, useState } from 'react'
import type { DisplayInfo, LayerSettings } from '@shared/protocol'
import { hexToRgb } from '@shared/color'
import { AudioPanel } from './AudioPanel'
import { BeatPanel } from './BeatPanel'
import { LayersPanel, PreviewMonitor } from './LayersPanel'
import { PadEditor } from './PadEditor'
import { FxPanel } from './FxPanel'
import { useFx } from './useFx'
import { useBlackoutShortcut, useLayers } from './useLayers'
import { PadGrid } from './PadGrid'
import { usePads, usePadShortcuts } from './usePads'
import { bridge, request } from './bridge'
import { LibraryPanel } from './LibraryPanel'
import { PlaybackPanel } from './PlaybackPanel'
import { useAudio } from './useAudio'
import { useBeat, useBeatShortcuts } from './useBeat'
import { NUDGE_MS } from '@shared/beat'
import { useLibrary } from './useLibrary'
import { useOutputLink } from './useOutputLink'

const SWATCHES = [
  { name: 'Black', hex: '#000000' },
  { name: 'Hot pink', hex: '#ff2bd6' },
  { name: 'Acid green', hex: '#7dff1a' },
  { name: 'Electric blue', hex: '#1a6bff' },
  { name: 'Sunset', hex: '#ff7a1a' },
  { name: 'White', hex: '#ffffff' },
]

const MB = 1024 * 1024

export function App() {
  const link = useOutputLink()
  const library = useLibrary()
  const audio = useAudio()
  const beat = useBeat()
  useBeatShortcuts(beat.command, NUDGE_MS)
  const pads = usePads()
  usePadShortcuts(pads)
  const layers = useLayers()
  const fx = useFx()
  useBlackoutShortcut(layers)
  const { setBackground, send } = link
  const [color, setColor] = useState('#000000')
  const [overlay, setOverlay] = useState(true)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [layerSettings, setLayerSettings] = useState<LayerSettings>({
    loop: true,
    speed: 1,
    fit: 'contain',
  })

  const refreshDisplays = useCallback(() => {
    request({ type: 'listDisplays' }, 'displays')
      .then((res) => setDisplays(res.displays))
      .catch((e: Error) => setError(e.message))
  }, [])

  // Displays can be plugged in or removed at any time; main re-broadcasts state when they are.
  useEffect(refreshDisplays, [refreshDisplays, link.state])

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

  const { stats, mediaStats } = link
  return (
    <div className="app">
      <header className="topbar">
        <h1>Veejus</h1>
        <span className={`status ${link.connected ? 'ok' : 'bad'}`} data-testid="output-status">
          {link.connected ? 'Output connected' : 'Waiting for output…'}
        </span>
        <span className="metric" data-testid="output-fps">
          {stats ? `${stats.fps.toFixed(0)} fps` : '-- fps'}
        </span>
        <span className="metric" data-testid="ping-ms">
          IPC {link.pingMs !== null ? `${link.pingMs.toFixed(1)} ms` : '--'}
        </span>
        {mediaStats && (
          <span className="metric" data-testid="media-stats">
            {mediaStats.readyClips} ready · {(mediaStats.imageBytes / MB).toFixed(0)} MB images ·{' '}
            {mediaStats.warmVideos}/{mediaStats.warmVideoLimit} videos
          </span>
        )}
      </header>

      <div className="workspace">
        <main className="main-area">
          <PadGrid pads={pads} beat={beat} clips={library.clips} probes={library.probes} />
          <LibraryPanel library={library} onPlay={playClip} />
        </main>

        <aside className="sidebar">
          <PreviewMonitor layers={layers} />

          <BeatPanel beat={beat} />

          <PadEditor pads={pads} clips={library.clips} />

          <LayersPanel layers={layers} clips={library.clips} />

          <FxPanel fx={fx} />

          <PlaybackPanel
            settings={layerSettings}
            onChange={changeLayerSettings}
            library={library}
            onStop={() => send({ type: 'stopClip' })}
          />

          <AudioPanel audio={audio} />

          <section className="panel">
            <h2>Background</h2>
            <div className="row">
              <input
                type="color"
                aria-label="Background color"
                value={color}
                onChange={(e) => applyColor(e.target.value)}
              />
              <code data-testid="current-color">{color}</code>
            </div>
            <div className="swatches">
              {SWATCHES.map((s) => (
                <button
                  key={s.hex}
                  className="swatch"
                  title={s.name}
                  aria-label={s.name}
                  data-testid={`swatch-${s.hex.slice(1)}`}
                  style={{ background: s.hex }}
                  onClick={() => applyColor(s.hex)}
                />
              ))}
            </div>
            <p className="hint" data-testid="bg-latency">
              Last change drawn in{' '}
              {link.backgroundLatencyMs !== null
                ? `${link.backgroundLatencyMs.toFixed(1)} ms`
                : '--'}{' '}
              (one frame at 60 fps is 16.7 ms)
            </p>
          </section>

          <section className="panel">
            <h2>Output window</h2>
            <dl className="facts">
              <dt>Visible</dt>
              <dd>{link.state.visible ? 'yes' : 'no'}</dd>
              <dt>Fullscreen</dt>
              <dd data-testid="output-fullscreen">{link.state.fullscreen ? 'yes' : 'no'}</dd>
            </dl>
            <div className="row">
              <button
                onClick={() =>
                  run(
                    request(
                      { type: 'setOutputFullscreen', fullscreen: !link.state.fullscreen },
                      'outputState',
                    ),
                  )
                }
              >
                {link.state.fullscreen ? 'Exit fullscreen' : 'Go fullscreen'}
              </button>
              {!link.state.visible && (
                <button onClick={() => run(request({ type: 'showOutput' }, 'outputState'))}>
                  Show output
                </button>
              )}
              <label className="check">
                <input type="checkbox" checked={overlay} onChange={toggleOverlay} /> Debug overlay
              </label>
            </div>
            <p className="hint">In the output window: Esc exits fullscreen, F11 toggles it.</p>

            <h3>Displays</h3>
            <ul className="displays" data-testid="display-list">
              {displays.map((d) => {
                const here = d.id === link.state.displayId
                return (
                  <li key={d.id} className={here ? 'current' : ''}>
                    <span>
                      {d.label}
                      {d.primary ? ' (primary)' : ''} · {d.width}×{d.height} @{d.scaleFactor}x
                    </span>
                    {here ? (
                      <span className="tag">output here</span>
                    ) : (
                      <button
                        onClick={() =>
                          run(
                            request(
                              { type: 'moveOutputToDisplay', displayId: d.id },
                              'outputState',
                            ),
                          )
                        }
                      >
                        Send output here
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>

          <section className="panel">
            <h2>Output frame timing</h2>
            {stats ? (
              <dl className="facts">
                <dt>FPS</dt>
                <dd>{stats.fps.toFixed(1)}</dd>
                <dt>Frame avg</dt>
                <dd>{stats.frameTimeAvgMs.toFixed(2)} ms</dd>
                <dt>Frame max</dt>
                <dd>{stats.frameTimeMaxMs.toFixed(2)} ms</dd>
                <dt>Dropped (1s)</dt>
                <dd>{stats.droppedFrames}</dd>
              </dl>
            ) : (
              <p className="hint">No stats yet.</p>
            )}
          </section>
        </aside>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
