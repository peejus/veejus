import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { NUDGE_MS } from '@shared/beat'
import { LAYER_NAMES } from '@shared/layers'
import type { MidiBinding } from '@shared/midi'
import { BANK_NAMES, PAD_COLS, PAD_KEY_LABELS, PLAY_MODE_LABELS, padId } from '@shared/pads'
import type { ClipInfo } from '@shared/protocol'
import { LAYER_COLORS } from './layerColors'
import { modeIcon, resolvedLayer, sourceLabel } from './PadGrid'
import { FULLSCREEN_KEY, isMac } from './platform'
import type { PadsLink } from './usePads'

const GROUPS: { title: string; keys?: false; rows: [string, string][] }[] = [
  {
    title: 'Pads',
    rows: [
      ['1–8 · Q–I · A–K · Z–,', 'Fire the pad in that spot (one keyboard row per pad row)'],
      ['Shift + pad key', 'Arm or disarm it for the drop'],
      [isMac ? 'fn + F1 – F4' : 'F1 – F4', 'Switch to bank A – D'],
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
      ['P', 'Auto-play on / off (steps through your clips on the beat)'],
      ['Esc (output window)', 'Leave fullscreen'],
      [`${FULLSCREEN_KEY} (output window)`, 'Toggle fullscreen'],
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

const bankKey = (bank: number) => `${isMac ? 'fn + ' : ''}F${bank + 1}`

/** "Note 36" / "CC 7" for the MIDI controls mapped to a pad slot (any device, any channel). */
function midiFor(index: number, bindings: readonly MidiBinding[]): string | null {
  const found = bindings.filter((b) => b.target.kind === 'pad' && b.target.index === index)
  if (found.length === 0) return null
  return found.map((b) => `${b.type === 'note' ? 'Note' : 'CC'} ${b.number}`).join(', ')
}

/**
 * Every pad that has something on it, by bank: its key, what it plays, how, on which layer,
 * and any MIDI control mapped to it. The current bank comes first; click a row to edit the pad.
 */
export function YourPads(p: {
  pads: PadsLink
  clips: ClipInfo[]
  bindings: readonly MidiBinding[]
  onEdit(): void
}) {
  const clipMap = new Map(p.clips.map((c) => [c.id, c]))
  const order = [p.pads.bank, ...p.pads.banks.map((_, i) => i).filter((i) => i !== p.pads.bank)]
  const banks = order
    .map((bank) => ({
      bank,
      loaded: p.pads.banks[bank]!.map((config, index) => ({ config, index })).filter(
        (x) => x.config.source !== null,
      ),
    }))
    .filter((b) => b.loaded.length > 0)

  return (
    <section className="your-pads" data-testid="your-pads">
      <h3>Your pads</h3>
      {banks.length === 0 ? (
        <p className="hint">
          No pads loaded yet. Drag library clips onto the pads, or press Auto-fill, and their keys
          show up here.
        </p>
      ) : (
        banks.map(({ bank, loaded }) => {
          const current = bank === p.pads.bank
          return (
            <div key={bank} className={`your-pads-bank${current ? ' current' : ''}`}>
              <h4>
                Bank {BANK_NAMES[bank]}{' '}
                {current ? (
                  <span className="hint">· showing now</span>
                ) : (
                  <span className="hint">
                    · press <kbd>{bankKey(bank)}</kbd> first
                  </span>
                )}
              </h4>
              <ul>
                {loaded.map(({ config, index }) => {
                  const id = padId(bank, index)
                  const key = PAD_KEY_LABELS[Math.floor(index / PAD_COLS)]![index % PAD_COLS]!
                  const layer = resolvedLayer(config)
                  const midi = midiFor(index, p.bindings)
                  const name = sourceLabel(config, clipMap)
                  return (
                    <li key={id}>
                      <button
                        className="your-pad"
                        data-pad-row={id}
                        title={`Edit pad ${id}`}
                        style={{ '--layer-color': LAYER_COLORS[layer] } as CSSProperties}
                        onClick={() => {
                          if (!current) p.pads.setBank(bank)
                          p.pads.select({ bank, index })
                          p.onEdit()
                        }}
                      >
                        <kbd>{key}</kbd>
                        <span className="your-pad-name">{name}</span>
                        <span
                          className="your-pad-how"
                          title={`${PLAY_MODE_LABELS[config.mode]} on ${LAYER_NAMES[layer]}`}
                        >
                          <span className="your-pad-mode" aria-hidden="true">
                            {modeIcon(config)}
                          </span>{' '}
                          {PLAY_MODE_LABELS[config.mode]} · {LAYER_NAMES[layer]}
                        </span>
                        {midi && <span className="your-pad-midi">MIDI {midi}</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })
      )}
    </section>
  )
}

export function ShortcutSheet({
  onClose,
  pads,
  clips,
  bindings,
}: {
  onClose(): void
  pads?: PadsLink
  clips?: ClipInfo[]
  bindings?: readonly MidiBinding[]
}) {
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
        {pads && (
          <YourPads pads={pads} clips={clips ?? []} bindings={bindings ?? []} onEdit={onClose} />
        )}
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
