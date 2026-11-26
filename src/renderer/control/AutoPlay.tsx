import { useState, type DragEvent } from 'react'
import {
  AUTO_STEPS,
  AUTO_STEP_LABELS,
  type AutoPlayStatus,
  type AutoSource,
  type AutoStep,
} from '@shared/autoplay'
import { LAYER_IDS, LAYER_NAMES, type LayerId } from '@shared/layers'
import type { ClipInfo, FitMode, ImportResult } from '@shared/protocol'
import { bridge } from './bridge'
import { autoClips, type AutoPlayLink } from './useAutoPlay'

const FIT_LABELS: Record<Exclude<FitMode, 'original'>, string> = {
  cover: 'Fill the screen (crop)',
  contain: 'Whole picture (bars)',
  stretch: 'Stretch',
}

const sourceKey = (s: AutoSource) => (s.kind === 'collection' ? `tag:${s.tag}` : s.kind)
const sourceFromKey = (k: string): AutoSource =>
  k.startsWith('tag:')
    ? { kind: 'collection', tag: k.slice(4) }
    : { kind: k as 'images' | 'all' | 'favorites' }

/** The one-button auto-play toggle in the top bar, with a way into its settings. */
export function AutoPlayButton(p: {
  auto: AutoPlayLink
  status: AutoPlayStatus | null
  onToggle(): void
  onSettings(): void
  settingsOpen: boolean
}) {
  const on = p.auto.settings.enabled
  const beats = p.status?.beatsToNext
  return (
    <div className={`auto-button-group${on ? ' on' : ''}`}>
      <button
        className="auto-button"
        aria-pressed={on}
        data-testid="auto-play-button"
        title={
          on
            ? 'Auto-play is stepping through your clips on the beat. Click (or P) to stop.'
            : 'Play your images and GIFs on the beat, one after another (P)'
        }
        onClick={p.onToggle}
      >
        <span aria-hidden="true">{on ? '■' : '▶'}</span> Auto-play
        {on && beats !== null && beats !== undefined && (
          <span className="auto-countdown" aria-hidden="true">
            {Math.max(1, Math.ceil(beats - 1e-6))}
          </span>
        )}
      </button>
      <button
        className={`auto-settings${p.settingsOpen ? ' on' : ''}`}
        aria-label="Auto-play settings"
        aria-pressed={p.settingsOpen}
        onClick={p.onSettings}
      >
        ▾
      </button>
    </div>
  )
}

/** Auto-play settings and what it's showing, in the context panel. */
export function AutoPlayPanel(p: {
  auto: AutoPlayLink
  status: AutoPlayStatus | null
  clips: ClipInfo[]
  bpm: number | null
  audioOn: boolean
  onToggle(): void
  onImport(mode: 'files' | 'folder'): void
}) {
  const { settings, set } = p.auto
  const names = new Map(p.clips.map((c) => [c.id, c.name]))
  const tags = [...new Set(p.clips.flatMap((c) => c.tags))].sort()
  const count = (s: AutoSource) => autoClips(p.clips, s).length
  const n = count(settings.source)
  const st = p.status
  const beats = st?.beatsToNext
  const beatsText =
    beats !== null && beats !== undefined
      ? ` in ${Math.max(1, Math.ceil(beats - 1e-6))} beat${Math.ceil(beats - 1e-6) > 1 ? 's' : ''}`
      : ''

  return (
    <div className="auto-panel" data-testid="auto-panel">
      <h2>Auto-play</h2>
      <p className="hint">
        Steps through your clips on the beat, one after another. No pads needed.
      </p>
      <button
        className={`auto-big${settings.enabled ? ' on' : ''}`}
        aria-pressed={settings.enabled}
        onClick={p.onToggle}
      >
        {settings.enabled ? '■ Stop auto-play' : '▶ Start auto-play'}
      </button>

      <dl className="facts auto-status" data-testid="auto-status">
        <dt>Now</dt>
        <dd data-testid="auto-now">
          {!settings.enabled
            ? 'Off'
            : st?.yielding
              ? `Waiting: a pad is playing on ${LAYER_NAMES[settings.layer]}`
              : st?.clipId
                ? (names.get(st.clipId) ?? '?')
                : n === 0
                  ? 'Nothing to play yet'
                  : 'Starting on the next beat…'}
        </dd>
        {settings.enabled && st?.nextClipId && (
          <>
            <dt>Next</dt>
            <dd data-testid="auto-next">
              {names.get(st.nextClipId) ?? '?'}
              {beatsText}
            </dd>
          </>
        )}
      </dl>

      <label className="field">
        <span className="label">Plays</span>
        <select
          aria-label="Auto-play source"
          value={sourceKey(settings.source)}
          onChange={(e) => set({ source: sourceFromKey(e.target.value) })}
        >
          <option value="images">Images & GIFs ({count({ kind: 'images' })})</option>
          <option value="all">Everything, videos too ({p.clips.length})</option>
          <option value="favorites">Favorites ({count({ kind: 'favorites' })})</option>
          {tags.map((t) => (
            <option key={t} value={`tag:${t}`}>
              Collection: {t} ({count({ kind: 'collection', tag: t })})
            </option>
          ))}
          {settings.source.kind === 'collection' && !tags.includes(settings.source.tag) && (
            <option value={sourceKey(settings.source)}>
              Collection: {settings.source.tag} (0)
            </option>
          )}
        </select>
      </label>
      <label className="field">
        <span className="label">Change</span>
        <select
          aria-label="Auto-play step"
          value={String(settings.step)}
          onChange={(e) =>
            set({
              step: (e.target.value === 'auto' ? 'auto' : Number(e.target.value)) as AutoStep,
            })
          }
        >
          {AUTO_STEPS.map((s) => (
            <option key={s} value={String(s)}>
              {AUTO_STEP_LABELS[String(s)]}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span className="label">Order</span>
        <div className="segmented" role="group" aria-label="Auto-play order">
          {(['inOrder', 'shuffle'] as const).map((o) => (
            <button
              key={o}
              className={settings.order === o ? 'on' : ''}
              aria-pressed={settings.order === o}
              onClick={() => set({ order: o })}
            >
              {o === 'inOrder' ? 'In order' : 'Shuffle'}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span className="label">Picture</span>
        <select
          aria-label="Auto-play fit"
          value={settings.fit}
          onChange={(e) => set({ fit: e.target.value as FitMode })}
        >
          {(Object.keys(FIT_LABELS) as (keyof typeof FIT_LABELS)[]).map((f) => (
            <option key={f} value={f}>
              {FIT_LABELS[f]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="label">Layer</span>
        <select
          aria-label="Auto-play layer"
          value={settings.layer}
          onChange={(e) => set({ layer: e.target.value as LayerId })}
        >
          {LAYER_IDS.map((l) => (
            <option key={l} value={l}>
              {LAYER_NAMES[l]}
            </option>
          ))}
        </select>
      </label>

      <div className="row">
        <button onClick={() => p.onImport('files')}>Add images & GIFs…</button>
        <button onClick={() => p.onImport('folder')}>Add a folder…</button>
      </div>
      <p className="hint">
        {p.bpm !== null ? `Following ${p.bpm.toFixed(0)} BPM. ` : ''}
        {p.audioOn
          ? 'The tempo follows the music.'
          : 'Tap Space on the beat to set the tempo, or turn on audio to follow the music.'}{' '}
        A pad fired on the same layer takes over until it ends. Esc stops everything, auto-play too.
      </p>
    </div>
  )
}

/**
 * Shown while the library is empty: load images and GIFs (pick or drop) and the show starts,
 * auto-playing them on the beat.
 */
export function QuickStart(p: {
  onImport(mode: 'files' | 'folder'): void
  onImportPaths(paths: string[]): void
}) {
  const [dragging, setDragging] = useState(false)
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(false)
    const paths = [...e.dataTransfer.files].map((f) => bridge.getPathForFile(f)).filter(Boolean)
    if (paths.length > 0) p.onImportPaths(paths)
  }
  return (
    <section
      className={`quick-start${dragging ? ' dragging' : ''}`}
      aria-label="Quick start"
      data-testid="quick-start"
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div>
        <h2>Start a show in one click</h2>
        <p>
          Pick some images and GIFs (or a folder of them) and Veejus plays them on the beat, one
          after another. You can drop files here too.
        </p>
      </div>
      <div className="row">
        <button className="primary" onClick={() => p.onImport('files')}>
          Choose images & GIFs…
        </button>
        <button onClick={() => p.onImport('folder')}>Choose a folder…</button>
      </div>
    </section>
  )
}

/** "Added 12 clips" style summary. */
export function importSummary(r: ImportResult): string {
  return (
    `Added ${r.added} clip${r.added === 1 ? '' : 's'}` +
    (r.skipped ? ` (${r.skipped} skipped: duplicates or unsupported)` : '')
  )
}
