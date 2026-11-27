import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import type { ClipInfo, ClipTrim } from '@shared/protocol'
import { clampTrim, formatClipTime, trimFor, type TrimEdge as Edge } from '@shared/trim'
import { thumbStrip } from './thumbStrip'

const STRIP_FRAMES = 10
/** Arrow keys move a handle this far (ten times as far with Shift). */
const KEY_STEP_MS = 100

const sameTrim = (a: ClipTrim | null | undefined, b: ClipTrim | null | undefined) =>
  (a ?? null) === null ? (b ?? null) === null : !!b && a!.inMs === b.inMs && a!.outMs === b.outMs

/**
 * Trim a video: drag the in and out handles over a strip of its frames (or focus one and use
 * the arrow keys). The preview loops the part that plays, and shows the frame under a handle
 * while it moves. The trim is saved when a drag ends.
 */
export function TrimEditor(p: {
  clip: ClipInfo
  durationMs: number
  onChange(trim: ClipTrim | null): void
}) {
  const { clip, durationMs } = p
  const saved = {
    inMs: clip.trim?.inMs ?? 0,
    outMs: Math.min(clip.trim?.outMs ?? durationMs, durationMs),
  }
  const [draft, setDraft] = useState<{ inMs: number; outMs: number } | null>(null)
  // The last range sent to main, shown until the library comes back with it (so quick key
  // presses build on each other instead of on the old trim).
  const [sent, setSent] = useState<{
    range: { inMs: number; outMs: number }
    trim: ClipTrim | null
  } | null>(null)
  const [dragging, setDragging] = useState<Edge | null>(null)
  const [frames, setFrames] = useState<string[]>([])
  const echoed = sent !== null && sameTrim(sent.trim, clip.trim)
  const range = draft ?? (sent && !echoed ? sent.range : saved)
  const stripRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const rangeRef = useRef(range)
  useLayoutEffect(() => {
    rangeRef.current = range
  })

  useEffect(() => {
    // The editor is keyed by clip, so a new clip starts with no frames.
    let live = true
    thumbStrip(clip.id, clip.url, durationMs, STRIP_FRAMES)
      .then((f) => live && setFrames(f))
      .catch(() => {
        // No strip: the handles still work over a plain bar.
      })
    return () => {
      live = false
    }
  }, [clip.id, clip.url, durationMs])

  // Preview: loop the part that plays; while dragging, hold on the frame under the handle.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (dragging) {
      v.pause()
      v.currentTime = (dragging === 'in' ? range.inMs : Math.max(0, range.outMs - 40)) / 1000
      return
    }
    v.currentTime = range.inMs / 1000
    void v.play().catch(() => {})
    const onTime = () => {
      const r = rangeRef.current
      if (v.currentTime * 1000 >= r.outMs || v.currentTime * 1000 < r.inMs - 50)
        v.currentTime = r.inMs / 1000
    }
    v.addEventListener('timeupdate', onTime)
    return () => v.removeEventListener('timeupdate', onTime)
  }, [dragging, range.inMs, range.outMs])

  const commit = (r: { inMs: number; outMs: number }) => {
    const trim = trimFor(r.inMs, r.outMs, durationMs)
    setDraft(null)
    setSent({ range: r, trim })
    p.onChange(trim)
  }

  const msAt = (clientX: number) => {
    const el = stripRef.current
    if (!el) return 0
    const box = el.getBoundingClientRect()
    return (
      (Math.min(Math.max(0, clientX - box.left), box.width) / Math.max(1, box.width)) * durationMs
    )
  }

  const move = (edge: Edge, ms: number) => {
    const r = rangeRef.current
    const next =
      edge === 'in'
        ? clampTrim(ms, r.outMs, durationMs, 'in')
        : clampTrim(r.inMs, ms, durationMs, 'out')
    setDraft(next)
    return next
  }

  const onStripDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const ms = msAt(e.clientX)
    // Grab whichever handle is nearer.
    const edge: Edge = Math.abs(ms - range.inMs) <= Math.abs(ms - range.outMs) ? 'in' : 'out'
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(edge)
    move(edge, ms)
  }
  const onStripMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging) move(dragging, msAt(e.clientX))
  }
  const onStripUp = () => {
    if (!dragging) return
    setDragging(null)
    commit(rangeRef.current)
  }

  const onHandleKey = (edge: Edge) => (e: KeyboardEvent<HTMLDivElement>) => {
    const step = (e.shiftKey ? 10 : 1) * KEY_STEP_MS
    const r = rangeRef.current
    const cur = edge === 'in' ? r.inMs : r.outMs
    let ms: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') ms = cur - step
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') ms = cur + step
    else if (e.key === 'Home') ms = edge === 'in' ? 0 : r.inMs
    else if (e.key === 'End') ms = edge === 'out' ? durationMs : r.outMs
    if (ms === null) return
    e.preventDefault()
    e.stopPropagation()
    commit(move(edge, ms))
  }

  const pct = (ms: number) => `${(ms / Math.max(1, durationMs)) * 100}%`
  const length = range.outMs - range.inMs
  const trimmed = range.inMs > 0 || range.outMs < durationMs - 1

  return (
    <div className="trim-editor" data-testid="trim-editor">
      <h3>Trim</h3>
      <video
        ref={videoRef}
        className="trim-preview"
        src={clip.url}
        muted
        playsInline
        aria-label="Trim preview"
      />
      <div
        ref={stripRef}
        className={`trim-strip${dragging ? ' dragging' : ''}`}
        data-testid="trim-strip"
        onPointerDown={onStripDown}
        onPointerMove={onStripMove}
        onPointerUp={onStripUp}
        onPointerCancel={onStripUp}
      >
        <div className="trim-frames" aria-hidden="true">
          {frames.map((f, i) => (
            <img key={i} src={f} alt="" draggable={false} />
          ))}
        </div>
        <div className="trim-shade" style={{ left: 0, width: pct(range.inMs) }} />
        <div className="trim-shade" style={{ left: pct(range.outMs), right: 0 }} />
        <div
          className="trim-window"
          style={{ left: pct(range.inMs), width: pct(range.outMs - range.inMs) }}
        />
        {(['in', 'out'] as const).map((edge) => {
          const ms = edge === 'in' ? range.inMs : range.outMs
          return (
            <div
              key={edge}
              className={`trim-handle ${edge}`}
              style={{ left: pct(ms) }}
              role="slider"
              tabIndex={0}
              aria-label={edge === 'in' ? 'Trim start' : 'Trim end'}
              aria-valuemin={0}
              aria-valuemax={Math.round(durationMs)}
              aria-valuenow={Math.round(ms)}
              aria-valuetext={formatClipTime(ms)}
              onKeyDown={onHandleKey(edge)}
            />
          )
        })}
      </div>
      <div className="trim-readout">
        <span data-testid="trim-readout">
          {formatClipTime(range.inMs)} – {formatClipTime(range.outMs)} ·{' '}
          {(length / 1000).toFixed(1)} s of {(durationMs / 1000).toFixed(1)} s
        </span>
        <button
          className="subtle"
          disabled={!trimmed}
          onClick={() => commit({ inMs: 0, outMs: durationMs })}
        >
          Reset
        </button>
      </div>
      <p className="hint">
        Only the part between the handles plays: on pads, in auto-play and from the library. Arrow
        keys move a focused handle by 0.1 s (Shift: 1 s).
      </p>
    </div>
  )
}
