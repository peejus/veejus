import { useCallback, useEffect, useRef, useState } from 'react'
import { NUDGE_MS } from '@shared/beat'

const GROUPS: { title: string; keys?: false; rows: [string, string][] }[] = [
  {
    title: 'Pads',
    rows: [
      ['1–8 · Q–I · A–K · Z–,', 'Fire the pad in that spot (one keyboard row per pad row)'],
      ['Shift + pad key', 'Arm or disarm it for the drop'],
      ['F1 – F4', 'Switch to bank A – D'],
      ['Esc', 'Stop everything'],
    ],
  },
  {
    title: 'Tempo',
    rows: [
      ['Space', 'Tap tempo'],
      ['Enter', 'Mark now as beat 1 of the bar'],
      ['← / →', `Nudge the beat grid ${NUDGE_MS} ms earlier / later`],
    ],
  },
  {
    title: 'Show',
    rows: [
      ['`', 'Blackout on / off'],
      ['Esc (output window)', 'Leave fullscreen'],
      ['F11 (output window)', 'Toggle fullscreen'],
    ],
  },
  {
    title: 'Mouse',
    keys: false,
    rows: [
      ['Click a pad', 'Fire it (hold for “While held” pads)'],
      ['Shift + click a pad', 'Arm it for the drop'],
      ['Right-click a pad, or ✎', 'Edit it'],
      ['Drag a library clip onto a pad', 'Put the clip on that pad'],
      ['Double-click a library clip', 'Play it now on the Background'],
    ],
  },
]

const typingInto = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName))

/**
 * Open state for the keyboard sheet, and its keys: "?" toggles it, and while it is open Esc
 * closes it instead of stopping everything. Call this before the other shortcut hooks, so its
 * listener runs first and can keep Esc from reaching "Stop all".
 */
export function useShortcutSheet(): { open: boolean; setOpen(open: boolean): void } {
  const [open, setOpenState] = useState(false)
  const openRef = useRef(open)
  const setOpen = useCallback((v: boolean) => {
    openRef.current = v
    setOpenState(v)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '?' && !typingInto(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        e.stopImmediatePropagation()
        setOpen(!openRef.current)
      } else if (e.key === 'Escape' && openRef.current) {
        e.preventDefault()
        e.stopImmediatePropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [setOpen])
  return { open, setOpen }
}

export function ShortcutSheet({ onClose }: { onClose(): void }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-header">
          <h2>Keyboard shortcuts</h2>
          <span className="hint">Press ? or Esc to close</span>
          <button className="close" aria-label="Close shortcuts" onClick={onClose}>
            ✕
          </button>
        </div>
        <ShortcutList />
        <p className="hint">
          Keys don’t fire pads while you’re typing in a field; click an empty spot first.
        </p>
      </div>
    </div>
  )
}

/** Every shortcut and mouse gesture (the ? sheet, and Setup → Keys). */
export function ShortcutList() {
  return (
    <div className="sheet-groups">
      {GROUPS.map((g) => (
        <section key={g.title}>
          <h3>{g.title}</h3>
          <dl>
            {g.rows.map(([k, v]) => (
              <div key={k} className="sheet-row">
                <dt>
                  {g.keys === false ? <span className="sheet-action">{k}</span> : <kbd>{k}</kbd>}
                </dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}
