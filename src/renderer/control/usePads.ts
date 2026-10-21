import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  BANK_COUNT,
  DEFAULT_PAD_CONFIG,
  DEFAULT_TRIGGER_SETTINGS,
  PAD_KEY_CODES,
  PADS_PER_BANK,
  PAD_COLS,
  autoLayer,
  padId,
  type PadConfig,
  type PadSource,
  type PadSpec,
  type TriggerSettings,
  type TriggerState,
} from '@shared/pads'
import { isOutputToControl } from '@shared/protocol'
import { bridge } from './bridge'

export interface PadRef {
  bank: number
  index: number
}

export interface PadsLink {
  banks: PadConfig[][]
  bank: number
  setBank(bank: number): void
  selected: PadRef | null
  select(pad: PadRef | null): void
  settings: TriggerSettings
  setSettings(settings: TriggerSettings): void
  runtime: TriggerState | null
  assign(pad: PadRef, source: PadSource | null): void
  update(pad: PadRef, patch: Partial<PadConfig>): void
  /** Put these clips on the current bank's pads, in order. */
  fillBank(clipIds: string[]): void
  /** `velocity` (0..1, e.g. from a MIDI pad) scales the clip's opacity. */
  press(pad: PadRef, velocity?: number): void
  release(pad: PadRef): void
  arm(pad: PadRef): void
  stopAll(): void
}

const emptyBanks = (): PadConfig[][] =>
  Array.from({ length: BANK_COUNT }, () =>
    Array.from({ length: PADS_PER_BANK }, () => ({ ...DEFAULT_PAD_CONFIG, source: null })),
  )

export function specFor(
  config: PadConfig,
  settings: TriggerSettings,
  forDrop = false,
): PadSpec | null {
  if (!config.source) return null
  return {
    source: config.source,
    mode: config.mode,
    quantize: config.quantize === 'global' ? settings.quantize : config.quantize,
    lengthBeats: config.lengthBeats,
    retriggerEvery: config.retriggerEvery,
    fadeInBeats: config.fadeInBeats,
    fadeOutBeats: config.fadeOutBeats,
    syncBeats: config.syncBeats,
    layer: config.layer === 'auto' ? autoLayer(config.mode, forDrop) : config.layer,
    placement: config.placement,
    key: config.key,
  }
}

/** Pad banks (owned here, in the control window), triggering and the output's pad states. */
export function usePads(): PadsLink {
  const [banks, setBanks] = useState<PadConfig[][]>(emptyBanks)
  const [bank, setBank] = useState(0)
  const [selected, select] = useState<PadRef | null>(null)
  const [settings, setSettingsState] = useState<TriggerSettings>(DEFAULT_TRIGGER_SETTINGS)
  const [runtime, setRuntime] = useState<TriggerState | null>(null)
  // Latest values for event handlers that outlive a render.
  const latest = useRef({ banks, settings })
  useLayoutEffect(() => {
    latest.current = { banks, settings }
  })

  useEffect(() => {
    const off = bridge.onOutputMessage((msg) => {
      if (!isOutputToControl(msg)) return
      if (msg.type === 'triggerState') setRuntime(msg.state)
      else if (msg.type === 'outputReady') {
        bridge.sendToOutput({ type: 'setTriggerSettings', settings: latest.current.settings })
      }
    })
    bridge.sendToOutput({ type: 'setTriggerSettings', settings: latest.current.settings })
    return off
  }, [])

  const update = useCallback((pad: PadRef, patch: Partial<PadConfig>) => {
    setBanks((prev) =>
      prev.map((b, bi) =>
        bi !== pad.bank ? b : b.map((p, pi) => (pi === pad.index ? { ...p, ...patch } : p)),
      ),
    )
  }, [])

  const assign = useCallback(
    (pad: PadRef, source: PadSource | null) => update(pad, { source }),
    [update],
  )

  const fillBank = useCallback(
    (clipIds: string[]) => {
      setBanks((prev) =>
        prev.map((b, bi) =>
          bi !== bank
            ? b
            : b.map((p, pi) =>
                clipIds[pi] ? { ...p, source: { kind: 'clip', clipId: clipIds[pi]! } } : p,
              ),
        ),
      )
    },
    [bank],
  )

  const setSettings = useCallback((next: TriggerSettings) => {
    setSettingsState(next)
    bridge.sendToOutput({ type: 'setTriggerSettings', settings: next })
  }, [])

  const send = useCallback((type: 'padPress' | 'padArm', pad: PadRef, velocity?: number) => {
    const { banks: b, settings: s } = latest.current
    const spec = specFor(b[pad.bank]![pad.index]!, s, type === 'padArm')
    if (!spec) return
    const id = padId(pad.bank, pad.index)
    if (type === 'padPress')
      bridge.sendToOutput({
        type,
        padId: id,
        spec,
        ...(velocity !== undefined ? { velocity } : {}),
      })
    else bridge.sendToOutput({ type, padId: id, spec })
  }, [])

  const press = useCallback(
    (pad: PadRef, velocity?: number) => send('padPress', pad, velocity),
    [send],
  )
  const arm = useCallback((pad: PadRef) => send('padArm', pad), [send])
  const release = useCallback(
    (pad: PadRef) => bridge.sendToOutput({ type: 'padRelease', padId: padId(pad.bank, pad.index) }),
    [],
  )
  const stopAll = useCallback(() => bridge.sendToOutput({ type: 'stopAll' }), [])

  return {
    banks,
    bank,
    setBank,
    selected,
    select,
    settings,
    setSettings,
    runtime,
    assign,
    update,
    fillBank,
    press,
    release,
    arm,
    stopAll,
  }
}

/** Grid position for a KeyboardEvent.code, or null. */
export function padIndexForCode(code: string): number | null {
  for (let r = 0; r < PAD_KEY_CODES.length; r++) {
    const c = PAD_KEY_CODES[r]!.indexOf(code)
    if (c >= 0) return r * PAD_COLS + c
  }
  return null
}

function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)
}

/**
 * Pad hotkeys: grid keys press (and release, for 'hold'), Shift+key arms for the drop,
 * F1-F4 switch banks, Escape stops everything.
 */
export function usePadShortcuts(pads: PadsLink): void {
  const { bank, setBank, press, release, arm, stopAll } = pads
  useEffect(() => {
    /** Keys held down, so release goes to the pad that was pressed even if the bank changed. */
    const held = new Map<string, PadRef>()
    const onDown = (e: KeyboardEvent) => {
      if (typingInto(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      const fn = /^F([1-4])$/.exec(e.key)
      if (fn) {
        e.preventDefault()
        setBank(Number(fn[1]) - 1)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        stopAll()
        return
      }
      const index = padIndexForCode(e.code)
      if (index === null) return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      const pad = { bank, index }
      if (e.shiftKey) arm(pad)
      else {
        held.set(e.code, pad)
        press(pad)
      }
    }
    const onUp = (e: KeyboardEvent) => {
      const pad = held.get(e.code)
      if (!pad) return
      held.delete(e.code)
      release(pad)
    }
    window.addEventListener('keydown', onDown, { capture: true })
    window.addEventListener('keyup', onUp, { capture: true })
    return () => {
      window.removeEventListener('keydown', onDown, { capture: true })
      window.removeEventListener('keyup', onUp, { capture: true })
    }
  }, [bank, setBank, press, release, arm, stopAll])
}
