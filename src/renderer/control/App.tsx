import { useCallback, useEffect, useState } from 'react'
import type { DisplayInfo } from '@shared/protocol'
import { hexToRgb } from '@shared/color'
import { request } from './bridge'
import { useOutputLink } from './useOutputLink'

const SWATCHES = [
  { name: 'Black', hex: '#000000' },
  { name: 'Hot pink', hex: '#ff2bd6' },
  { name: 'Acid green', hex: '#7dff1a' },
  { name: 'Electric blue', hex: '#1a6bff' },
  { name: 'Sunset', hex: '#ff7a1a' },
  { name: 'White', hex: '#ffffff' },
]

export function App() {
  const link = useOutputLink()
  const { setBackground, send } = link
  const [color, setColor] = useState('#000000')
  const [overlay, setOverlay] = useState(true)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [error, setError] = useState<string | null>(null)

  const refreshDisplays = useCallback(() => {
    request({ type: 'listDisplays' }, 'displays')
      .then((res) => setDisplays(res.displays))
      .catch((e: Error) => setError(e.message))
  }, [])

  // Displays can be plugged in or removed at any time; main re-broadcasts state when they are.
  useEffect(refreshDisplays, [refreshDisplays, link.state])

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

  const { stats } = link
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
      </header>

      <main className="panels">
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
            {link.backgroundLatencyMs !== null ? `${link.backgroundLatencyMs.toFixed(1)} ms` : '--'}{' '}
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
                          request({ type: 'moveOutputToDisplay', displayId: d.id }, 'outputState'),
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
      </main>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
