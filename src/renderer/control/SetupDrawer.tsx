import type { DisplayInfo, FrameStatsSnapshot, MediaStats } from '@shared/protocol'
import { AudioPanel } from './AudioPanel'
import { ClockSettings, ClockSourcePicker } from './BeatPanel'
import { MidiSetup } from './MidiSetup'
import { ShortcutList } from './ShortcutSheet'
import {
  ASPECTS,
  ASPECT_LABELS,
  RESOLUTIONS,
  RESOLUTION_LABELS,
  type Aspect,
  type OutputOptions,
  type Resolution,
} from '@shared/output'
import type { OutputHealth } from '@shared/protocol'
import { LEVEL_LABELS } from '@core/watchdog'
import type { MidiLink } from './useMidi'
import type { FxConfig } from '@shared/fx'
import type { AudioLink } from './useAudio'
import type { BeatLink } from './useBeat'
import type { OutputLink } from './useOutputLink'

export const SETUP_TABS = ['audio', 'output', 'clock', 'midi', 'keys', 'diagnostics'] as const
export type SetupTab = (typeof SETUP_TABS)[number]
const TAB_LABELS: Record<SetupTab, string> = {
  audio: 'Audio',
  output: 'Output',
  clock: 'Clock',
  midi: 'MIDI',
  keys: 'Keys',
  diagnostics: 'Diagnostics',
}

const SWATCHES = [
  { name: 'Black', hex: '#000000' },
  { name: 'Hot pink', hex: '#ff2bd6' },
  { name: 'Acid green', hex: '#7dff1a' },
  { name: 'Electric blue', hex: '#1a6bff' },
  { name: 'Sunset', hex: '#ff7a1a' },
  { name: 'White', hex: '#ffffff' },
]

const MB = 1024 * 1024

interface Props {
  open: boolean
  tab: SetupTab
  onTab(tab: SetupTab): void
  onClose(): void
  audio: AudioLink
  beat: BeatLink
  link: OutputLink
  displays: DisplayInfo[]
  color: string
  onColor(hex: string): void
  overlay: boolean
  onToggleOverlay(): void
  onFullscreen(fullscreen: boolean): void
  onShowOutput(): void
  onMoveOutput(displayId: number): void
  midi: MidiLink
  fx: FxConfig
  outputOptions: OutputOptions
  onOutputOptions(o: OutputOptions): void
  health: OutputHealth
}

/**
 * Everything you set up before the show, out of the way of the live controls. All tabs stay
 * mounted (hidden when not shown) so their live state, such as audio meters, keeps running.
 */
export function SetupDrawer(p: Props) {
  return (
    <aside
      className={`setup-drawer${p.open ? ' open' : ''}`}
      aria-label="Setup"
      aria-hidden={!p.open}
      hidden={!p.open}
      data-testid="setup-drawer"
    >
      <div className="setup-header">
        <h2>Setup</h2>
        <div className="segmented setup-tabs" role="tablist" aria-label="Setup sections">
          {SETUP_TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={p.tab === t}
              className={p.tab === t ? 'on' : ''}
              onClick={() => p.onTab(t)}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
        <button className="close" aria-label="Close setup" onClick={p.onClose}>
          ✕
        </button>
      </div>
      <div className="setup-body">
        <div role="tabpanel" hidden={p.tab !== 'audio'}>
          <AudioPanel audio={p.audio} />
        </div>
        <div role="tabpanel" hidden={p.tab !== 'output'}>
          <OutputSetup {...p} />
        </div>
        <div role="tabpanel" hidden={p.tab !== 'clock'}>
          <section className="panel">
            <h2>Tempo source</h2>
            <ClockSourcePicker beat={p.beat} />
          </section>
          <section className="panel">
            <h2>Clock</h2>
            <ClockSettings beat={p.beat} />
          </section>
        </div>
        <div role="tabpanel" hidden={p.tab !== 'midi'}>
          <MidiSetup midi={p.midi} fx={p.fx} />
        </div>
        <div role="tabpanel" hidden={p.tab !== 'keys'}>
          <section className="panel">
            <h2>Keyboard shortcuts</h2>
            <ShortcutList />
          </section>
        </div>
        <div role="tabpanel" hidden={p.tab !== 'diagnostics'}>
          <Diagnostics
            overlay={p.overlay}
            onToggleOverlay={p.onToggleOverlay}
            pingMs={p.link.pingMs}
            stats={p.link.stats}
            mediaStats={p.link.mediaStats}
            health={p.health}
          />
        </div>
      </div>
    </aside>
  )
}

function OutputSetup(p: Props) {
  const { link, displays } = p
  return (
    <>
      <section className="panel">
        <h2>Output window</h2>
        <dl className="facts">
          <dt>Visible</dt>
          <dd>{link.state.visible ? 'yes' : 'no'}</dd>
          <dt>Fullscreen</dt>
          <dd data-testid="output-fullscreen">{link.state.fullscreen ? 'yes' : 'no'}</dd>
        </dl>
        <div className="row">
          <button onClick={() => p.onFullscreen(!link.state.fullscreen)}>
            {link.state.fullscreen ? 'Exit fullscreen' : 'Go fullscreen'}
          </button>
          {!link.state.visible && <button onClick={p.onShowOutput}>Show output</button>}
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
                  <button onClick={() => p.onMoveOutput(d.id)}>Send output here</button>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <section className="panel">
        <h2>Picture</h2>
        <label className="field">
          <span className="label">Shape</span>
          <select
            aria-label="Output shape"
            value={p.outputOptions.aspect}
            onChange={(e) =>
              p.onOutputOptions({ ...p.outputOptions, aspect: e.target.value as Aspect })
            }
          >
            {ASPECTS.map((a) => (
              <option key={a} value={a}>
                {ASPECT_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Resolution</span>
          <select
            aria-label="Output resolution"
            value={p.outputOptions.resolution}
            onChange={(e) =>
              p.onOutputOptions({ ...p.outputOptions, resolution: e.target.value as Resolution })
            }
          >
            {RESOLUTIONS.map((r) => (
              <option key={r} value={r}>
                {RESOLUTION_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">
          A shape other than “Fill” adds black bars (for projectors, LED walls or vertical screens).
          A lower resolution eases the GPU; the picture is scaled up to fit.
        </p>
      </section>

      <section className="panel">
        <h2>Background</h2>
        <p className="hint">Shown wherever no clip covers the screen.</p>
        <div className="row">
          <input
            type="color"
            aria-label="Background color"
            value={p.color}
            onChange={(e) => p.onColor(e.target.value)}
          />
          <code data-testid="current-color">{p.color}</code>
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
              onClick={() => p.onColor(s.hex)}
            />
          ))}
        </div>
        <p className="hint" data-testid="bg-latency">
          Last change drawn in{' '}
          {link.backgroundLatencyMs !== null ? `${link.backgroundLatencyMs.toFixed(1)} ms` : '--'}{' '}
          (one frame at 60 fps is 16.7 ms)
        </p>
      </section>
    </>
  )
}

function Diagnostics(p: {
  health: OutputHealth
  overlay: boolean
  onToggleOverlay(): void
  pingMs: number | null
  stats: FrameStatsSnapshot | null
  mediaStats: MediaStats | null
}) {
  const { stats, mediaStats } = p
  return (
    <section className="panel">
      <h2>Diagnostics</h2>
      <label className="check">
        <input type="checkbox" checked={p.overlay} onChange={p.onToggleOverlay} /> Debug overlay on
        the output
      </label>
      <p className="hint">The overlay is drawn over the show, so the audience sees it.</p>
      <dl className="facts">
        <dt>IPC ping</dt>
        <dd data-testid="ping-ms">IPC {p.pingMs !== null ? `${p.pingMs.toFixed(1)} ms` : '--'}</dd>
        {mediaStats && (
          <>
            <dt>Media</dt>
            <dd data-testid="media-stats">
              {mediaStats.readyClips} ready · {(mediaStats.imageBytes / MB).toFixed(0)} MB images ·{' '}
              {mediaStats.warmVideos}/{mediaStats.warmVideoLimit} videos
            </dd>
          </>
        )}
        {stats && (
          <>
            <dt>FPS</dt>
            <dd>{stats.fps.toFixed(1)}</dd>
            <dt>Frame avg</dt>
            <dd>{stats.frameTimeAvgMs.toFixed(2)} ms</dd>
            <dt>Frame max</dt>
            <dd>{stats.frameTimeMaxMs.toFixed(2)} ms</dd>
            <dt>Dropped (1s)</dt>
            <dd>{stats.droppedFrames}</dd>
            <dt>Quality</dt>
            <dd data-testid="degrade-level">{LEVEL_LABELS[p.health.level]}</dd>
            <dt>GPU targets</dt>
            <dd>~{p.health.gpuMB} MB</dd>
          </>
        )}
      </dl>
    </section>
  )
}
