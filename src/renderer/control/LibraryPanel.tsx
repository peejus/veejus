import { memo, useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import type { ClipInfo, ClipLoadState } from '@shared/protocol'
import type { ProbeResult } from './probe'
import { bridge, request } from './bridge'
import type { LibraryState } from './useLibrary'
import { CLIP_DRAG_TYPE } from './PadGrid'

const UNDO_MS = 10_000

function formatDuration(ms: number): string {
  const s = ms / 1000
  return s < 60
    ? `${s.toFixed(1)}s`
    : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
}

function metaLine(clip: ClipInfo, probe: ProbeResult | undefined): string {
  if (!probe) return 'Reading…'
  if (!probe.ok) return 'Unreadable'
  const m = probe.meta
  const parts: string[] = []
  if (m.durationMs !== undefined) parts.push(formatDuration(m.durationMs))
  else if (m.frameCount !== undefined) parts.push(m.frameCount > 1 ? `${m.frameCount} fr` : 'still')
  parts.push(`${m.width}×${m.height}`)
  parts.push(clip.name.split('.').pop()!.toUpperCase())
  return parts.join(' · ')
}

const STATE_LABEL: Record<ClipLoadState, string> = {
  cold: 'Not loaded (loads on play)',
  loading: 'Loading on output…',
  ready: 'Ready on output',
  error: 'Error',
}

interface PadProps {
  clip: ClipInfo
  probe: ProbeResult | undefined
  outputState: { state: ClipLoadState; error?: string } | undefined
  playing: boolean
  selected: boolean
  onSelect(id: string): void
  onPlay(id: string): void
  onRemove(id: string): void
}

const Pad = memo(function Pad({
  clip,
  probe,
  outputState,
  playing,
  selected,
  onSelect,
  onPlay,
  onRemove,
}: PadProps) {
  const [hover, setHover] = useState(false)
  const error =
    outputState?.state === 'error' ? outputState.error : probe && !probe.ok ? probe.error : null
  const state: ClipLoadState = error ? 'error' : (outputState?.state ?? 'cold')
  const thumb = probe?.ok ? probe.meta.thumbUrl : null

  return (
    <div
      className={`pad state-${state}${playing ? ' playing' : ''}${selected ? ' selected' : ''}`}
      data-testid="pad"
      data-clip-id={clip.id}
      data-clip-name={clip.name}
      data-state={state}
      role="button"
      aria-label={clip.name}
      aria-pressed={selected}
      tabIndex={0}
      draggable={!error}
      onDragStart={(e) => {
        e.dataTransfer.setData(CLIP_DRAG_TYPE, clip.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      title={`${clip.name}\n${error ?? STATE_LABEL[state]}`}
      // A click only selects: browsing the library never changes the show by accident.
      // (Enter and Space stay with the global tempo shortcuts: beat 1 and tap.)
      onClick={() => onSelect(clip.id)}
      onDoubleClick={() => !error && onPlay(clip.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="pad-media">
        {hover && !error ? (
          clip.kind === 'video' ? (
            <video src={clip.url} muted autoPlay loop playsInline />
          ) : (
            <img src={clip.url} alt="" />
          )
        ) : thumb ? (
          <img src={thumb} alt="" />
        ) : (
          <div className="pad-placeholder">{error ? '⚠' : '…'}</div>
        )}
        {probe?.ok && probe.meta.hasAlpha && (
          <span className="badge alpha" title="Has transparency">
            α
          </span>
        )}
        <span className={`dot ${state}`} aria-label={STATE_LABEL[state]} />
        {selected && !error && (
          <button
            className="pad-play"
            aria-label={`Play ${clip.name} on Background`}
            title="Play now on the Background layer (or double-click the clip)"
            onClick={(e) => {
              e.stopPropagation()
              onPlay(clip.id)
            }}
          >
            ▶ Play
          </button>
        )}
        <button
          className="pad-remove"
          aria-label={`Remove ${clip.name}`}
          onClick={(e) => {
            e.stopPropagation()
            onRemove(clip.id)
          }}
        >
          ✕
        </button>
      </div>
      <div className="pad-name">{clip.name}</div>
      <div className="pad-meta">
        {error ? <span className="pad-error">{error}</span> : metaLine(clip, probe)}
      </div>
    </div>
  )
})

interface Props {
  library: LibraryState
  onPlay(id: string): void
}

export function LibraryPanel({ library, onPlay }: Props) {
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  /** Paths removed by the last Clear, offered for undo for a few seconds. */
  const [undo, setUndo] = useState<{ paths: string[]; count: number } | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { remove } = library
  const removeOne = useCallback((id: string) => remove([id]), [remove])
  const select = useCallback((id: string) => setSelectedId(id), [])

  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current)
    },
    [],
  )

  const clearAll = () => {
    const paths = library.clips.map((c) => c.path)
    remove(library.clips.map((c) => c.id))
    setConfirmClear(false)
    setSelectedId(null)
    setUndo({ paths, count: paths.length })
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS)
  }

  const undoClear = () => {
    if (!undo) return
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndo(null)
    // Clip ids come from file paths, so re-importing restores pad assignments too.
    request({ type: 'importPaths', paths: undo.paths }, 'imported').catch((e: Error) =>
      setNotice(`Undo failed: ${e.message}`),
    )
  }

  const runImport = (p: ReturnType<typeof request<'imported'>>) => {
    p.then(({ result }) => {
      if (result.added === 0 && result.skipped === 0) return
      setNotice(
        `Added ${result.added} clip${result.added === 1 ? '' : 's'}` +
          (result.skipped ? ` (${result.skipped} skipped: duplicates or unsupported)` : ''),
      )
    }).catch((e: Error) => setNotice(`Import failed: ${e.message}`))
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const paths = [...e.dataTransfer.files].map((f) => bridge.getPathForFile(f)).filter(Boolean)
    if (paths.length > 0) runImport(request({ type: 'importPaths', paths }, 'imported'))
  }

  const { clips } = library
  return (
    <section
      className={`panel library${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <div className="library-header">
        <h2>
          Library{' '}
          <span className="count" data-testid="clip-count">
            {clips.length}
          </span>
        </h2>
        <div className="row">
          <button
            onClick={() => runImport(request({ type: 'pickAndImport', mode: 'files' }, 'imported'))}
          >
            Add files…
          </button>
          <button
            onClick={() =>
              runImport(request({ type: 'pickAndImport', mode: 'folder' }, 'imported'))
            }
          >
            Add folder…
          </button>
          {clips.length > 0 && !confirmClear && (
            <button className="subtle" onClick={() => setConfirmClear(true)}>
              Clear library…
            </button>
          )}
        </div>
      </div>
      {confirmClear && (
        <div className="confirm-bar" role="alertdialog" aria-label="Confirm clearing the library">
          <span>
            Remove all {clips.length} clips from the library? Files on disk are not touched.
          </span>
          <button className="danger" onClick={clearAll}>
            Remove all
          </button>
          <button onClick={() => setConfirmClear(false)}>Cancel</button>
        </div>
      )}
      {undo && (
        <div className="confirm-bar" role="status">
          <span>
            Removed {undo.count} clip{undo.count === 1 ? '' : 's'}.
          </span>
          <button onClick={undoClear}>Undo</button>
        </div>
      )}
      {clips.length > 0 && (
        <p className="hint library-hint">
          Click to select · double-click or ▶ Play to show it on the Background now · drag onto a
          pad to assign
        </p>
      )}
      {notice && (
        <p className="notice" data-testid="import-notice" onClick={() => setNotice(null)}>
          {notice}
        </p>
      )}
      {clips.length === 0 ? (
        <div className="empty-library">
          Drop clips or folders here. MP4, WebM, MOV, GIF, WebP, APNG, PNG and JPEG are supported.
        </div>
      ) : (
        <div className="pad-grid">
          {clips.map((clip) => (
            <Pad
              key={clip.id}
              clip={clip}
              probe={library.probes[clip.id]}
              outputState={library.outputStates[clip.id]}
              playing={library.playingId === clip.id}
              selected={selectedId === clip.id}
              onSelect={select}
              onPlay={onPlay}
              onRemove={removeOne}
            />
          ))}
        </div>
      )}
      {dragging && <div className="drop-overlay">Drop to add clips</div>}
    </section>
  )
}
