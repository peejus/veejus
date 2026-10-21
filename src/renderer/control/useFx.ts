import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MAX_EFFECTS,
  MAX_MODS,
  defaultModRange,
  defaultParams,
  emptyFxConfig,
  presetItems,
  type EffectInstance,
  type EffectType,
  type FxChain,
  type FxConfig,
  type FxScope,
  type Modulator,
  type PresetId,
} from '@shared/fx'
import { isOutputToControl, type FxLiveValues } from '@shared/protocol'
import { bridge } from './bridge'

export interface FxLink {
  config: FxConfig
  addEffect(scope: FxScope, type: EffectType): void
  updateEffect(scope: FxScope, id: string, patch: Partial<EffectInstance>): void
  setEffectParam(scope: FxScope, id: string, name: string, value: number): void
  removeEffect(scope: FxScope, id: string): void
  moveEffect(scope: FxScope, id: string, delta: -1 | 1): void
  addModulator(scope: FxScope, target: string): void
  updateModulator(scope: FxScope, id: string, patch: Partial<Modulator>): void
  removeModulator(scope: FxScope, id: string): void
  presetActive(scope: FxScope, preset: PresetId): boolean
  togglePreset(scope: FxScope, preset: PresetId): void
  clear(scope: FxScope): void
  /** Latest modulated values from the output (see 'fxLive'); read without re-rendering. */
  live: { current: FxLiveValues }
  /** Subscribe to modulated-value updates. Returns an unsubscribe function. */
  onLive(listener: (values: FxLiveValues) => void): () => void
}

let nextId = 0
const newId = (kind: 'e' | 'm' | 'p') =>
  `${kind}${Date.now().toString(36)}${(nextId++).toString(36)}`

/** Effects and modulators per layer and master (owned here, mirrored to the output). */
export function useFx(): FxLink {
  const [config, setConfig] = useState<FxConfig>(emptyFxConfig)
  const latest = useRef(config)
  const [live] = useState<{ current: FxLiveValues }>(() => ({ current: {} }))
  const liveListeners = useRef(new Set<(v: FxLiveValues) => void>())
  const onLive = useCallback((l: (v: FxLiveValues) => void) => {
    liveListeners.current.add(l)
    return () => {
      liveListeners.current.delete(l)
    }
  }, [])
  useEffect(() => {
    latest.current = config
  })

  useEffect(() => {
    const push = () => bridge.sendToOutput({ type: 'setFx', config: latest.current })
    const off = bridge.onOutputMessage((msg) => {
      if (!isOutputToControl(msg)) return
      if (msg.type === 'outputReady') push()
      else if (msg.type === 'fxLive') {
        live.current = msg.values
        for (const l of liveListeners.current) l(msg.values)
      }
    })
    push()
    return off
  }, [live])

  const edit = useCallback((scope: FxScope, fn: (chain: FxChain) => FxChain) => {
    setConfig((prev) => {
      const next = { ...prev, [scope]: fn(prev[scope]) }
      bridge.sendToOutput({ type: 'setFx', config: next })
      return next
    })
  }, [])

  const addEffect = useCallback(
    (scope: FxScope, type: EffectType) =>
      edit(scope, (c) =>
        c.effects.length >= MAX_EFFECTS
          ? c
          : {
              ...c,
              effects: [
                ...c.effects,
                { id: newId('e'), type, enabled: true, params: defaultParams(type) },
              ],
            },
      ),
    [edit],
  )

  const updateEffect = useCallback(
    (scope: FxScope, id: string, patch: Partial<EffectInstance>) =>
      edit(scope, (c) => ({
        ...c,
        effects: c.effects.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      })),
    [edit],
  )

  const setEffectParam = useCallback(
    (scope: FxScope, id: string, name: string, value: number) =>
      edit(scope, (c) => ({
        ...c,
        effects: c.effects.map((e) =>
          e.id === id ? { ...e, params: { ...e.params, [name]: value } } : e,
        ),
      })),
    [edit],
  )

  const removeEffect = useCallback(
    (scope: FxScope, id: string) =>
      edit(scope, (c) => ({
        effects: c.effects.filter((e) => e.id !== id),
        // Modulators aimed at the removed effect go with it.
        mods: c.mods.filter((m) => !m.target.startsWith(`${id}.`)),
      })),
    [edit],
  )

  const moveEffect = useCallback(
    (scope: FxScope, id: string, delta: -1 | 1) =>
      edit(scope, (c) => {
        const i = c.effects.findIndex((e) => e.id === id)
        const j = i + delta
        if (i < 0 || j < 0 || j >= c.effects.length) return c
        const effects = [...c.effects]
        ;[effects[i], effects[j]] = [effects[j]!, effects[i]!]
        return { ...c, effects }
      }),
    [edit],
  )

  const addModulator = useCallback(
    (scope: FxScope, target: string) =>
      edit(scope, (c) =>
        c.mods.length >= MAX_MODS
          ? c
          : {
              ...c,
              mods: [
                ...c.mods,
                {
                  id: newId('m'),
                  enabled: true,
                  target,
                  source: { kind: 'lfo', shape: 'sine', periodBeats: 4, phase: 0 },
                  amount: 1,
                  min: defaultModRange(c, target)[0],
                  max: defaultModRange(c, target)[1],
                  invert: false,
                },
              ],
            },
      ),
    [edit],
  )

  const updateModulator = useCallback(
    (scope: FxScope, id: string, patch: Partial<Modulator>) =>
      edit(scope, (c) => ({
        ...c,
        mods: c.mods.map((m) => {
          if (m.id !== id) return m
          // A new target starts from a range that suits it.
          const range =
            patch.target && patch.target !== m.target ? defaultModRange(c, patch.target) : null
          return { ...m, ...(range ? { min: range[0], max: range[1] } : {}), ...patch }
        }),
      })),
    [edit],
  )

  const removeModulator = useCallback(
    (scope: FxScope, id: string) =>
      edit(scope, (c) => ({ ...c, mods: c.mods.filter((m) => m.id !== id) })),
    [edit],
  )

  const presetActive = useCallback(
    (scope: FxScope, preset: PresetId) =>
      config[scope].effects.some((e) => e.preset === preset) ||
      config[scope].mods.some((m) => m.preset === preset),
    [config],
  )

  const togglePreset = useCallback(
    (scope: FxScope, preset: PresetId) =>
      edit(scope, (c) => {
        const on =
          c.effects.some((e) => e.preset === preset) || c.mods.some((m) => m.preset === preset)
        if (on) {
          return {
            effects: c.effects.filter((e) => e.preset !== preset),
            mods: c.mods.filter((m) => m.preset !== preset),
          }
        }
        const items = presetItems(preset, newId('p'))
        if (
          c.effects.length + items.effects.length > MAX_EFFECTS ||
          c.mods.length + items.mods.length > MAX_MODS
        )
          return c
        return { effects: [...c.effects, ...items.effects], mods: [...c.mods, ...items.mods] }
      }),
    [edit],
  )

  const clear = useCallback(
    (scope: FxScope) => edit(scope, () => ({ effects: [], mods: [] })),
    [edit],
  )

  return {
    config,
    addEffect,
    updateEffect,
    setEffectParam,
    removeEffect,
    moveEffect,
    addModulator,
    updateModulator,
    removeModulator,
    presetActive,
    togglePreset,
    clear,
    live,
    onLive,
  }
}
