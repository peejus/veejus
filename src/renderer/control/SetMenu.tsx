import { useEffect, useRef, useState } from 'react'
import { MOD, SHIFT } from './platform'
import type { SetLink } from './useSet'

/** The set name in the top bar, with New / Open / Save / Save as / Recent. */
export function SetMenu({ set }: { set: SetLink }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const { refreshRecent, save } = set

  // Ctrl+S (⌘S on macOS) saves, Ctrl+Shift+S saves as, Ctrl+O opens.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 's') {
        e.preventDefault()
        void save(e.shiftKey)
      } else if (k === 'o') {
        e.preventDefault()
        void set.open()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, set])

  // Close when clicking elsewhere.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  const act = (fn: () => unknown) => () => {
    setOpen(false)
    void fn()
  }

  return (
    <div className="set-menu" ref={root}>
      <button
        className="set-button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="set-button"
        title={set.path ?? 'Not saved yet'}
        onClick={() => {
          if (!open) refreshRecent()
          setOpen(!open)
        }}
      >
        <span className="set-name" data-testid="set-name">
          {set.name}
        </span>
        {set.dirty && (
          <span className="set-dirty" title="Unsaved changes" data-testid="set-dirty">
            ●
          </span>
        )}
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="set-dropdown" role="menu">
          <button role="menuitem" onClick={act(() => set.newSet())}>
            New set
          </button>
          <button role="menuitem" onClick={act(() => set.open())}>
            Open… <kbd>{MOD}O</kbd>
          </button>
          <button role="menuitem" onClick={act(() => set.save())}>
            Save <kbd>{MOD}S</kbd>
          </button>
          <button role="menuitem" onClick={act(() => set.save(true))}>
            Save as…{' '}
            <kbd>
              {MOD}
              {SHIFT}S
            </kbd>
          </button>
          {set.recent.length > 0 && <div className="set-dropdown-label">Recent sets</div>}
          {set.recent.map((r) => (
            <button
              key={r.path}
              role="menuitem"
              disabled={!r.exists}
              title={r.exists ? r.path : `${r.path} (not found)`}
              onClick={act(() => set.open(r.path))}
            >
              {r.name}
              {!r.exists && <span className="muted"> (missing)</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Shown after opening a set whose media moved: find it, or carry on without it. */
export function RelinkDialog({ set }: { set: SetLink }) {
  if (set.missing.length === 0) return null
  const shown = set.missing.slice(0, 8)
  return (
    <div className="sheet-backdrop">
      <div className="sheet relink" role="dialog" aria-label="Missing clips">
        <h2>
          {set.missing.length} clip{set.missing.length === 1 ? '' : 's'} not found
        </h2>
        <p>
          These files aren’t where the set expects them (moved, renamed, or on a drive that isn’t
          connected). Point Veejus at a folder and it will look for them by name, including in
          subfolders.
        </p>
        <ul className="relink-list" data-testid="missing-list">
          {shown.map((c) => (
            <li key={c.id} title={c.path}>
              {c.name}
              <span className="muted"> — {c.path}</span>
            </li>
          ))}
          {set.missing.length > shown.length && (
            <li className="muted">…and {set.missing.length - shown.length} more</li>
          )}
        </ul>
        <div className="row">
          <button className="primary" disabled={set.busy} onClick={() => void set.relink()}>
            Search a folder…
          </button>
          <button onClick={set.dismissMissing}>Continue without them</button>
        </div>
        <p className="hint">
          Pads that used missing clips stay assigned and show “(missing clip)”.
        </p>
      </div>
    </div>
  )
}
