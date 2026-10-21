import {
  FIT_MODES,
  SPEED_MAX,
  SPEED_MIN,
  type ClipInfo,
  type FitMode,
  type LayerSettings,
} from '@shared/protocol'
import type { LibraryState } from './useLibrary'

const FIT_LABELS: Record<FitMode, string> = {
  contain: 'Contain (whole clip)',
  cover: 'Cover (fill, crop)',
  stretch: 'Stretch',
  original: 'Original size',
}

interface Props {
  clip: ClipInfo
  settings: LayerSettings
  onChange(settings: LayerSettings): void
  library: LibraryState
  onPlay(id: string): void
  onStop(): void
}

/** The selected library clip: play it on the Background now, and how library plays look. */
export function ClipInspector({ clip, settings, onChange, library, onPlay, onStop }: Props) {
  const probe = library.probes[clip.id]
  const playing = library.clips.find((c) => c.id === library.playingId)
  const last = library.lastStart
  const broken =
    library.outputStates[clip.id]?.state === 'error' || (probe !== undefined && !probe.ok)
  return (
    <div className="clip-inspector" data-testid="clip-inspector">
      <h2 className="clip-title" title={clip.path}>
        {clip.name}
      </h2>
      {probe?.ok && (
        <div className="clip-thumb">
          <img src={probe.meta.thumbUrl} alt="" />
        </div>
      )}
      <div className="row">
        <button
          className="primary"
          disabled={broken}
          onClick={() => onPlay(clip.id)}
          title="Show it now on the Background layer, unquantized"
        >
          ▶ Play on Background
        </button>
      </div>
      <p className="hint">To play it on the beat, drag it onto a pad.</p>

      <div className="now-playing">
        <span className="label">Now playing</span>
        <span data-testid="now-playing">{playing ? playing.name : 'Nothing'}</span>
        <button onClick={onStop} disabled={!playing}>
          Stop
        </button>
      </div>
      {last && (
        <p className="hint" data-testid="start-latency">
          Last start: {last.waitFrames} frame{last.waitFrames === 1 ? '' : 's'} after the request
          {last.latencyMs !== null ? `, ${last.latencyMs.toFixed(1)} ms round trip` : ''}
        </p>
      )}

      <h3>Library plays</h3>
      <div className="field">
        <span className="label">Playback</span>
        <div className="segmented" role="group" aria-label="Playback mode">
          <button
            className={settings.loop ? 'on' : ''}
            aria-pressed={settings.loop}
            onClick={() => onChange({ ...settings, loop: true })}
          >
            Loop
          </button>
          <button
            className={!settings.loop ? 'on' : ''}
            aria-pressed={!settings.loop}
            onClick={() => onChange({ ...settings, loop: false })}
          >
            One-shot
          </button>
        </div>
      </div>

      <label className="field">
        <span className="label">Speed</span>
        <input
          type="range"
          aria-label="Speed"
          min={Math.log2(SPEED_MIN)}
          max={Math.log2(SPEED_MAX)}
          step={0.25}
          value={Math.log2(settings.speed)}
          onChange={(e) => onChange({ ...settings, speed: 2 ** Number(e.target.value) })}
        />
        <code className="speed-value" data-testid="speed-value">
          {settings.speed.toFixed(2)}×
        </code>
        <button className="subtle" onClick={() => onChange({ ...settings, speed: 1 })}>
          1×
        </button>
      </label>

      <label className="field">
        <span className="label">Fit</span>
        <select
          aria-label="Fit"
          value={settings.fit}
          onChange={(e) => onChange({ ...settings, fit: e.target.value as FitMode })}
        >
          {FIT_MODES.map((m) => (
            <option key={m} value={m}>
              {FIT_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">These apply to clips played from the library. Clips are muted.</p>
    </div>
  )
}
