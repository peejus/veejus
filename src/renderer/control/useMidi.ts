import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NUDGE_MS, type BeatCommand } from '@shared/beat'
import type { LayerId } from '@shared/layers'
import type { FxScope } from '@shared/fx'
import { BANK_NAMES, QUANTIZES, type PadRunState, type Quantize } from '@shared/pads'
import {
  DEFAULT_MIDI_SETTINGS,
  continuousValue,
  describeMessage,
  isContinuous,
  isMidiSettings,
  isMidiTarget,
  isPress,
  matchBindings,
  padLed,
  parseMidi,
  sameSource,
  targetKey,
  targetLabel,
  templateBindings,
  type MidiBinding,
  type MidiMessage,
  type MidiSettings,
  type MidiTarget,
  type TemplateId,
} from '@shared/midi'

const STORAGE_KEY = 'veejus.midi'

/** What MIDI controls can do: the app's own actions, wired up in App. */
export interface MidiActions {
  press(index: number, velocity: number): void
  release(index: number): void
  arm(index: number): void
  bank: number
  setBank(bank: number): void
  quantize: Quantize
  setQuantize(q: Quantize): void
  beat(cmd: BeatCommand): void
  stopAll(): void
  blackout: boolean
  setBlackout(on: boolean): void
  dropNow(): void
  layerOpacity(layer: LayerId): number
  setLayerOpacity(layer: LayerId, v: number): void
  master: number
  setMaster(v: number): void
  /** Current value and range of an effect parameter, or null if it doesn't exist. */
  effectParam(
    scope: FxScope,
    effectId: string,
    param: string,
  ): { value: number; min: number; max: number } | null
  setEffectParam(scope: FxScope, effectId: string, param: string, v: number): void
}

/** Pad LEDs for the current bank. */
export interface PadLeds {
  bank: number
  pads: { empty: boolean; state: PadRunState }[]
}

export interface LedEvent {
  output: string | null
  bytes: [number, number, number]
}

export interface MidiLink {
  supported: boolean
  error: string | null
  inputs: string[]
  outputs: string[]
  settings: MidiSettings
  learn: {
    active: boolean
    target: MidiTarget | null
    /** What the picked control is called on screen. */
    label: string | null
    lastMapped: string | null
  }
  setLearn(active: boolean): void
  pickTarget(target: MidiTarget): void
  removeBinding(id: string): void
  updateBinding(id: string, patch: Partial<MidiBinding>): void
  clearBindings(): void
  applyTemplate(id: TemplateId, input: string | null, output: string | null): void
  setFeedbackOutput(name: string | null): void
  /** Subscribe to incoming messages (for the monitor), without re-rendering the app. */
  onMessage(listener: (device: string, text: string) => void): () => void
}

function loadSettings(): MidiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (isMidiSettings(parsed)) return parsed
  } catch {
    // Unreadable: start empty.
  }
  return DEFAULT_MIDI_SETTINGS
}

let nextId = 0
const newId = () => `m${Date.now().toString(36)}${(nextId++).toString(36)}`
const QUANTIZE_CYCLE: Quantize[] = [...QUANTIZES]
/** How long a value we just sent stands in for the app's (until it has re-rendered). */
const RECENT_MS = 250

/**
 * MIDI controllers: Web MIDI input/output, mapping, MIDI learn and LED feedback.
 * Mappings are saved in this window's storage and come back on the next start.
 */
export function useMidi(actions: MidiActions, leds: PadLeds): MidiLink {
  const supported = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator
  const [access, setAccess] = useState<MIDIAccess | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ports, setPorts] = useState<{ inputs: string[]; outputs: string[] }>({
    inputs: [],
    outputs: [],
  })
  const [settings, setSettings] = useState<MidiSettings>(loadSettings)
  const [learn, setLearnState] = useState<MidiLink['learn']>({
    active: false,
    target: null,
    label: null,
    lastMapped: null,
  })

  // Latest values for the message handler, which is created once.
  const latest = useRef({ actions, settings, learn })
  useLayoutEffect(() => {
    latest.current = { actions, settings, learn }
  })
  const armHeld = useRef(false)
  /** Values just sent to continuous targets (0..1), for stepping encoders in bursts. */
  const sentValues = useRef(new Map<string, { value: number; at: number }>())
  const listeners = useRef(new Set<(device: string, text: string) => void>())
  const ledLog = useRef<LedEvent[]>([])
  const ledCache = useRef(new Map<string, number>())

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // Not saved; the mapping still works this session.
    }
  }, [settings])

  const bind = useCallback(
    (device: string | null, m: MidiMessage, target: MidiTarget, label: string | null) => {
      const binding: MidiBinding = {
        id: newId(),
        device,
        type: m.kind,
        channel: m.channel,
        number: m.number,
        target,
        ccMode: 'absolute',
        velocity: target.kind === 'pad',
      }
      // One control drives one thing: re-learning a control replaces what it did.
      setSettings((s) => ({
        ...s,
        bindings: [
          ...s.bindings.filter((b) => !sameSource(b, device, m) || b.device !== device),
          binding,
        ],
      }))
      const source = m.kind === 'note' ? `Note ${m.number}` : `CC ${m.number}`
      setLearnState((l) => ({
        ...l,
        target: null,
        label: null,
        lastMapped: `${label ?? targetLabel(target)} ← ${source}, ch ${m.channel + 1}${
          device ? ` (${device})` : ''
        }`,
      }))
    },
    [],
  )

  /** Everything that happens for one incoming message. */
  const handle = useCallback(
    (device: string, bytes: ArrayLike<number>) => {
      const m = parseMidi(bytes)
      if (!m) return
      const text = describeMessage(m)
      for (const l of listeners.current) l(device, text)
      const { actions: a, settings: s, learn: lr } = latest.current

      if (lr.active) {
        // Learning: the first press or CC after picking a control maps it.
        if (lr.target && (m.kind === 'cc' || m.on)) bind(device, m, lr.target, lr.label)
        return
      }

      for (const b of matchBindings(s.bindings, device, m)) {
        const t = b.target
        if (isContinuous(t)) {
          if (m.kind === 'note' && !m.on) continue
          // Encoders send bursts faster than the app re-renders: step from the value we set
          // last (for a moment), not from the not-yet-updated app state.
          const key = targetKey(t)
          const recent = sentValues.current.get(key)
          const now = performance.now()
          const apply = (appValue: number) => {
            const current = recent && now - recent.at < RECENT_MS ? recent.value : appValue
            const v =
              m.kind === 'cc' ? continuousValue(b.ccMode, m.value, current) : m.velocity / 127
            sentValues.current.set(key, { value: v, at: now })
            return v
          }
          if (t.kind === 'layerOpacity') a.setLayerOpacity(t.layer, apply(a.layerOpacity(t.layer)))
          else if (t.kind === 'masterBrightness') a.setMaster(apply(a.master))
          else if (t.kind === 'effectParam') {
            const p = a.effectParam(t.scope, t.effectId, t.param)
            if (!p) continue
            const span = p.max - p.min || 1
            const v = apply((p.value - p.min) / span)
            a.setEffectParam(t.scope, t.effectId, t.param, p.min + v * span)
          }
          continue
        }
        const press = isPress(m)
        switch (t.kind) {
          case 'pad':
            if (press) {
              if (armHeld.current) a.arm(t.index)
              else a.press(t.index, b.velocity && m.kind === 'note' ? m.velocity / 127 : 1)
            } else a.release(t.index)
            break
          case 'armModifier':
            armHeld.current = press
            break
          default:
            if (!press) break
            switch (t.kind) {
              case 'bank':
                a.setBank(t.bank)
                break
              case 'bankNext':
              case 'bankPrev': {
                const n = BANK_NAMES.length
                a.setBank((a.bank + (t.kind === 'bankNext' ? 1 : -1) + n) % n)
                break
              }
              case 'quantize':
                a.setQuantize(t.value)
                break
              case 'quantizeCycle': {
                const i = QUANTIZE_CYCLE.indexOf(a.quantize)
                a.setQuantize(QUANTIZE_CYCLE[(i + 1) % QUANTIZE_CYCLE.length]!)
                break
              }
              case 'tap':
                a.beat({ type: 'tap' })
                break
              case 'resync':
                a.beat({ type: 'resyncDownbeat' })
                break
              case 'nudge':
                a.beat({ type: 'nudge', ms: t.dir * NUDGE_MS })
                break
              case 'dropNow':
                a.dropNow()
                break
              case 'stopAll':
                a.stopAll()
                break
              case 'blackout':
                a.setBlackout(!a.blackout)
                break
            }
        }
      }
    },
    [bind],
  )

  // Open Web MIDI and listen to every input.
  useEffect(() => {
    if (!supported) return
    let cancelled = false
    navigator
      .requestMIDIAccess({ sysex: false })
      .then((acc) => {
        if (cancelled) return
        const attach = () => {
          const inputs: string[] = []
          for (const input of acc.inputs.values()) {
            const name = input.name ?? 'MIDI input'
            inputs.push(name)
            input.onmidimessage = (e) => {
              if (e.data) handle(name, e.data)
            }
          }
          const outputs = [...acc.outputs.values()].map((o) => o.name ?? 'MIDI output')
          setPorts({ inputs, outputs })
          ledCache.current.clear() // a reconnected device needs its LEDs again
        }
        attach()
        acc.onstatechange = attach
        setAccess(acc)
      })
      .catch((e: Error) => setError(e.message))
    return () => {
      cancelled = true
    }
  }, [supported, handle])

  // LED feedback: pad states (and the current bank) on the chosen output, sending only changes.
  useEffect(() => {
    const outName = settings.feedbackOutput
    const out =
      access && outName ? [...access.outputs.values()].find((o) => o.name === outName) : null
    for (const b of settings.bindings) {
      if (b.type !== 'note') continue
      let velocity: number
      if (b.target.kind === 'pad') {
        const p = leds.pads[b.target.index]
        if (!p) continue
        velocity = padLed(p.empty, p.state)
      } else if (b.target.kind === 'bank') velocity = b.target.bank === leds.bank ? 1 : 0
      else continue
      const key = `${outName}|${b.channel}|${b.number}`
      if (ledCache.current.get(key) === velocity) continue
      ledCache.current.set(key, velocity)
      const bytes: [number, number, number] = [0x90 | b.channel, b.number, velocity]
      out?.send(bytes)
      ledLog.current.push({ output: outName, bytes })
      if (ledLog.current.length > 500) ledLog.current.splice(0, 100)
    }
  }, [leds, settings, access])

  // MIDI learn: clicking a learnable control picks it instead of using it.
  useEffect(() => {
    document.body.classList.toggle('midi-learn', learn.active)
    if (!learn.active) return
    const intercept = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.('[data-learn]')
      if (!el) return
      e.preventDefault()
      e.stopPropagation()
      if (e.type !== 'click') return
      try {
        const t: unknown = JSON.parse(el.getAttribute('data-learn') ?? '')
        // Its on-screen name: the slider/button label, or its text.
        const label =
          el.getAttribute('aria-label') ??
          el.querySelector('[aria-label]')?.getAttribute('aria-label') ??
          el.textContent?.trim() ??
          null
        if (isMidiTarget(t)) setLearnState((l) => ({ ...l, target: t, label: label || null }))
      } catch {
        // Not a target.
      }
    }
    const types = ['pointerdown', 'mousedown', 'click', 'contextmenu', 'dblclick'] as const
    for (const t of types) window.addEventListener(t, intercept, { capture: true })
    return () => {
      for (const t of types) window.removeEventListener(t, intercept, { capture: true })
    }
  }, [learn.active])

  // In learn mode, show which controls are mapped and which one is waiting.
  useEffect(() => {
    if (!learn.active) {
      for (const el of document.querySelectorAll('.learn-mapped, .learn-target'))
        el.classList.remove('learn-mapped', 'learn-target')
      return
    }
    const mapped = new Set(settings.bindings.map((b) => targetKey(b.target)))
    const waiting = learn.target ? targetKey(learn.target) : null
    const mark = () => {
      for (const el of document.querySelectorAll('[data-learn]')) {
        const key = el.getAttribute('data-learn')
        el.classList.toggle('learn-mapped', !!key && mapped.has(key))
        el.classList.toggle('learn-target', key === waiting)
      }
    }
    mark()
    // Panels open and close while learning; keep the marks current.
    const timer = setInterval(mark, 300)
    return () => clearInterval(timer)
  })

  // Test hooks: inject messages as if from a device, and read what was sent to LEDs.
  useEffect(() => {
    ;(window as unknown as { __veejusMidi: unknown }).__veejusMidi = {
      inject: (device: string, bytes: number[]) => handle(device, bytes),
      leds: () => [...ledLog.current],
      bindings: () => latest.current.settings.bindings,
    }
  }, [handle])

  return {
    supported,
    error,
    inputs: ports.inputs,
    outputs: ports.outputs,
    settings,
    learn,
    setLearn: useCallback(
      (active: boolean) =>
        setLearnState((l) => ({
          active,
          target: null,
          label: null,
          lastMapped: active ? null : l.lastMapped,
        })),
      [],
    ),
    pickTarget: useCallback(
      (target: MidiTarget) => setLearnState((l) => ({ ...l, target, label: null })),
      [],
    ),
    removeBinding: useCallback(
      (id: string) =>
        setSettings((s) => ({ ...s, bindings: s.bindings.filter((b) => b.id !== id) })),
      [],
    ),
    updateBinding: useCallback(
      (id: string, patch: Partial<MidiBinding>) =>
        setSettings((s) => ({
          ...s,
          bindings: s.bindings.map((b) => (b.id === id ? { ...b, ...patch } : b)),
        })),
      [],
    ),
    clearBindings: useCallback(() => setSettings((s) => ({ ...s, bindings: [] })), []),
    applyTemplate: useCallback((id: TemplateId, input: string | null, output: string | null) => {
      ledCache.current.clear()
      setSettings((s) => ({
        ...s,
        bindings: [
          ...s.bindings.filter((b) => !b.id.startsWith(`t-${id}-`)),
          ...templateBindings(id, input),
        ],
        feedbackOutput: output ?? s.feedbackOutput,
      }))
    }, []),
    setFeedbackOutput: useCallback((name: string | null) => {
      ledCache.current.clear()
      setSettings((s) => ({ ...s, feedbackOutput: name }))
    }, []),
    onMessage: useCallback((l: (device: string, text: string) => void) => {
      listeners.current.add(l)
      return () => {
        listeners.current.delete(l)
      }
    }, []),
  }
}
