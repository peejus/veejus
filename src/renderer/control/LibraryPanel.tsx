import { memo, useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import type { ClipInfo, ClipLoadState } from '@shared/protocol'
import type { ProbeResult } from './probe'
import { bridge, request } from './bridge'
import type { LibraryState } from './useLibrary'
import { CLIP_DRAG_TYPE } from './PadGrid'

const UNDO_MS = 10_000
/** The "collection" value that means favorites. */
const FAVORITES = '\u0000favorites'

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

// ---- Filters ------------------------------------------------------------------

const FILTERS = ['all', 'video', 'animated', 'still', 'broken'] as const
type Filter = (typeof FILTERS)[number]
const FILTER_LABELS: Record<Filter, string> = {
  all: 'All',
  video: 'Video',
  animated: 'GIF / animated',
  still: 'Stills',
  broken: 'Broken',
}

type Category = Exclude<Filter, 'all'>

/** What kind of clip this is, for the filters. Broken wins over everything else. */
function categoryOf(clip: ClipInfo, library: LibraryState): Category {
  if (errorOf(clip, library)) return 'broken'
  if (clip.kind === 'video') return 'video'
  const probe = library.probes[clip.id]
  const frames = probe?.ok ? probe.meta.frameCount : undefined
  if (frames !== undefined) return frames > 1 ? 'animated' : 'still'
  // Not probed yet: guess from the type.
  return clip.mime === 'image/gif' || clip.mime === 'image/apng' ? 'animated' : 'still'
}

function errorOf(clip: ClipInfo, library: LibraryState): string | null {
  const out = library.outputStates[clip.id]
  const probe = library.probes[clip.id]
  return out?.state === 'error' ? (out.error ?? 'Error') : probe && !probe.ok ? probe.error : null
}

function matches(clip: ClipInfo, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return clip.path.replaceAll('\\', '/').toLowerCase().includes(q)
}

// ---- Tiles --------------------------------------------------------------------

interface PadProps {
  clip: ClipInfo
  probe: ProbeResult | undefined
  error: string | null
  outputState: { state: ClipLoadState; error?: string } | undefined
  playing: boolean
  selected: boolean
  /** How many pads use this clip. */
  assigned: number
  onSelect(id: string): void
  onPlay(id: string): void
  onRemove(id: string): void
}

const Pad = memo(function Pad({
  clip,
  probe,
  error,
  outputState,
  playing,
  selected,
  assigned,
  onSelect,
  onPlay,
  onRemove,
}: PadProps) {
  const [hover, setHover] = useState(false)
  const state: ClipLoadState = error ? 'error' : (outputState?.state ?? 'cold')
  const thumb = probe?.ok ? probe.meta.thumbUrl : null
  const onPads = assigned > 0 ? `\nOn ${assigned} pad${assigned === 1 ? '' : 's'}` : ''

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
      title={`${clip.name}\n${
        error ??
        `${STATE_LABEL[state]}${onPads}\nClick to select · double-click to play now · drag onto a pad`
      }`}
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
        <div className="pad-badges">
          {probe?.ok && probe.meta.hasAlpha && (
            <span className="badge alpha" title="Has transparency">
              α
            </span>
          )}
          {clip.favorite && (
            <span className="badge fav" title="Favorite">
              ★
            </span>
          )}
          {assigned > 0 && (
            <span
              className="badge assigned"
              data-testid="assigned"
              title={`On ${assigned} pad${assigned === 1 ? '' : 's'}`}
            >
              ▣ {assigned}
            </span>
          )}
        </div>
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
        {/* Name and details sit on the thumbnail, so they're never scrolled out of view. */}
        <div className="pad-caption">
          <div className="pad-name">{clip.name}</div>
          <div className="pad-meta">
            {error ? <span className="pad-error">{error}</span> : metaLine(clip, probe)}
          </div>
        </div>
      </div>
    </div>
  )
})

// ---- Panel --------------------------------------------------------------------

interface Props {
  library: LibraryState
  onPlay(id: string): void
  selectedId: string | null
  onSelect(id: string | null): void
  /** Pads per clip id. */
  assigned: Record<string, number>
}

export function LibraryPanel({ library, onPlay, selectedId, onSelect, assigned }: Props) {
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [chosenFilter, setFilter] = useState<Filter>('all')
  /** A collection (tag) or FAVORITES to show, or null for everything. */
  const [chosenCollection, setCollection] = useState<string | null>(null)
  /** A removal waiting for confirmation (clearing, or clips that pads use). */
  const [confirm, setConfirm] = useState<{ ids: string[]; text: string; action: string } | null>(
    null,
  )
  /** Paths removed last, offered for undo for a few seconds. */
  const [undo, setUndo] = useState<{ paths: string[]; count: number } | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { remove, clips } = library

  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current)
    },
    [],
  )

  /** Remove clips, offering Undo (ids come from paths, so re-importing restores pads too). */
  const removeWithUndo = useCallback(
    (ids: string[]) => {
      const gone = clips.filter((c) => ids.includes(c.id))
      if (gone.length === 0) return
      remove(gone.map((c) => c.id))
      if (selectedId && ids.includes(selectedId)) onSelect(null)
      setConfirm(null)
      setUndo({ paths: gone.map((c) => c.path), count: gone.length })
      if (undoTimer.current) clearTimeout(undoTimer.current)
      undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS)
    },
    [clips, remove, selectedId, onSelect],
  )

  const removeOne = useCallback(
    (id: string) => {
      const n = assigned[id] ?? 0
      const clip = clips.find((c) => c.id === id)
      if (n > 0 && clip) {
        setConfirm({
          ids: [id],
          text: `${clip.name} is on ${n} pad${n === 1 ? '' : 's'}. Remove it from the library? Those pads will be empty until it's added back.`,
          action: 'Remove',
        })
      } else removeWithUndo([id])
    },
    [assigned, clips, removeWithUndo],
  )
  const select = useCallback((id: string) => onSelect(id), [onSelect])

  const undoRemove = () => {
    if (!undo) return
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndo(null)
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

  const categories = new Map(clips.map((c) => [c.id, categoryOf(c, library)]))
  const counts = Object.fromEntries(
    FILTERS.map((f) => [
      f,
      f === 'all' ? clips.length : clips.filter((c) => categories.get(c.id) === f).length,
    ]),
  ) as Record<Filter, number>
  // A filter that no longer matches anything (say, after removing the broken clips) falls back to All.
  const filter: Filter = chosenFilter !== 'all' && counts[chosenFilter] === 0 ? 'all' : chosenFilter
  // Collections (tags) and favorites narrow the view further.
  const tags = [...new Set(clips.flatMap((c) => c.tags))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  )
  const favorites = clips.filter((c) => c.favorite).length
  const collection =
    chosenCollection === FAVORITES
      ? favorites > 0
        ? FAVORITES
        : null
      : chosenCollection && tags.includes(chosenCollection)
        ? chosenCollection
        : null
  const inCollection = (c: ClipInfo) =>
    collection === null || (collection === FAVORITES ? c.favorite : c.tags.includes(collection))
  const shown = clips.filter(
    (c) =>
      (filter === 'all' || categories.get(c.id) === filter) && inCollection(c) && matches(c, query),
  )
  const broken = clips.filter((c) => categories.get(c.id) === 'broken')

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
        <h2 title="Click a clip to select it, double-click to play it now on the Background, drag it onto a pad to assign it">
          Library{' '}
          <span className="count" data-testid="clip-count">
            {clips.length}
          </span>
        </h2>
        {clips.length > 0 && (
          <input
            className="library-search"
            type="search"
            placeholder="Search…"
            aria-label="Search clips"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
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
          {clips.length > 0 && (
            <button
              className="subtle"
              onClick={() =>
                setConfirm({
                  ids: clips.map((c) => c.id),
                  text: `Remove all ${clips.length} clips from the library? Files on disk are not touched.`,
                  action: 'Remove all',
                })
              }
            >
              Clear library…
            </button>
          )}
        </div>
      </div>
      {clips.length > 0 && (
        <div className="library-filters" role="group" aria-label="Clip filter">
          {FILTERS.map((f) =>
            f !== 'all' && counts[f] === 0 ? null : (
              <button
                key={f}
                className={`chip${filter === f ? ' on' : ''}${f === 'broken' ? ' bad' : ''}`}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {FILTER_LABELS[f]} <span className="chip-count">{counts[f]}</span>
              </button>
            ),
          )}
          {(favorites > 0 || tags.length > 0) && <span className="chip-divider" />}
          {favorites > 0 && (
            <button
              className={`chip${collection === FAVORITES ? ' on' : ''}`}
              aria-pressed={collection === FAVORITES}
              onClick={() => setCollection(collection === FAVORITES ? null : FAVORITES)}
            >
              ★ Favorites <span className="chip-count">{favorites}</span>
            </button>
          )}
          {tags.map((t) => (
            <button
              key={t}
              className={`chip tag${collection === t ? ' on' : ''}`}
              aria-pressed={collection === t}
              title={`Collection: ${t}`}
              onClick={() => setCollection(collection === t ? null : t)}
            >
              {t}{' '}
              <span className="chip-count">{clips.filter((c) => c.tags.includes(t)).length}</span>
            </button>
          ))}
          {broken.length > 0 && (
            <button
              className="subtle remove-broken"
              title="Remove the clips that can't be played"
              onClick={() => removeWithUndo(broken.map((c) => c.id))}
            >
              Remove {broken.length} broken
            </button>
          )}
        </div>
      )}
      {confirm && (
        <div className="confirm-bar" role="alertdialog" aria-label="Confirm removing clips">
          <span>{confirm.text}</span>
          <button className="danger" onClick={() => removeWithUndo(confirm.ids)}>
            {confirm.action}
          </button>
          <button onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      )}
      {undo && (
        <div className="confirm-bar undo-toast" role="status">
          <span>
            Removed {undo.count} clip{undo.count === 1 ? '' : 's'}.
          </span>
          <button onClick={undoRemove}>Undo</button>
        </div>
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
      ) : shown.length === 0 ? (
        <div className="empty-library small">
          No clips match.{' '}
          <button
            className="link"
            onClick={() => {
              setQuery('')
              setFilter('all')
            }}
          >
            Show all
          </button>
        </div>
      ) : (
        <div className="pad-grid">
          {shown.map((clip) => (
            <Pad
              key={clip.id}
              clip={clip}
              probe={library.probes[clip.id]}
              error={errorOf(clip, library)}
              outputState={library.outputStates[clip.id]}
              playing={library.playingId === clip.id}
              selected={selectedId === clip.id}
              assigned={assigned[clip.id] ?? 0}
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
