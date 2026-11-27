import { useCallback, useEffect, useRef, useState } from 'react'
import type { BeatCommand, BeatEvent, BeatState } from '@shared/beat'
import { isOutputToControl } from '@shared/protocol'
import { bridge } from './bridge'

export type BeatListener = (event: BeatEvent) => void

export interface BeatLink {
  state: BeatState | null
  command(command: BeatCommand): void
  /** Subscribe to beat events without re-rendering. */
  onBeat(listener: BeatListener): () => void
}

/** Beat clock state (~10 updates/s) as React state; individual beats via listeners. */
export function useBeat(): BeatLink {
  const [state, setState] = useState<BeatState | null>(null)
  const listeners = useRef(new Set<BeatListener>())

  useEffect(
    () =>
      bridge.onOutputMessage((msg) => {
        if (!isOutputToControl(msg)) return
        if (msg.type === 'beatState') setState(msg.state)
        else if (msg.type === 'beat') for (const l of listeners.current) l(msg.event)
      }),
    [],
  )

  const command = useCallback(
    (c: BeatCommand) => bridge.sendToOutput({ type: 'beatCommand', command: c }),
    [],
  )
  const onBeat = useCallback((l: BeatListener) => {
    listeners.current.add(l)
    return () => listeners.current.delete(l)
  }, [])

  return { state, command, onBeat }
}

/** Is focus somewhere that needs these keys for itself (text entry, sliders, menus)? */
function keysBelongToTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  // Custom sliders (the trim handles) use the arrow keys.
  if (target.getAttribute('role') === 'slider') return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
}

/**
 * Global tempo shortcuts: Space = tap, Enter = downbeat resync, Left/Right = nudge.
 * Captured before buttons or pads see them, so a focused button is never activated instead.
 */
export function useBeatShortcuts(command: (c: BeatCommand) => void, nudgeMs: number): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keysBelongToTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      let c: BeatCommand | null = null
      if (e.key === ' ' && !e.repeat) c = { type: 'tap' }
      else if (e.key === 'Enter' && !e.repeat) c = { type: 'resyncDownbeat' }
      else if (e.key === 'ArrowLeft') c = { type: 'nudge', ms: -nudgeMs }
      else if (e.key === 'ArrowRight') c = { type: 'nudge', ms: nudgeMs }
      if (!c) return
      e.preventDefault()
      e.stopPropagation()
      command(c)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [command, nudgeMs])
}
