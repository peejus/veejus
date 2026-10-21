import { useEffect, useRef, useState } from 'react'
import { BAND_NAMES } from '@shared/audio'
import { LAYER_NAMES } from '@shared/layers'
import {
  CHAIN_PARAMS,
  EFFECT_DEFS,
  EFFECT_TYPES,
  ENV_TRIGGERS,
  ENV_TRIGGER_LABELS,
  LFO_PERIODS,
  LFO_SHAPES,
  PRESET_IDS,
  PRESET_LABELS,
  targetSpec,
  type EffectInstance,
  type EffectType,
  type EnvTrigger,
  type FxChain,
  type FxScope,
  type LfoShape,
  type ModSource,
  type Modulator,
  type ParamSpec,
} from '@shared/fx'
import { SmartSlider, formatByStep, type LiveSource } from './SmartSlider'
import type { FxLink } from './useFx'
import { targetKey } from '@shared/midi'

export const SCOPE_NAMES: Record<FxScope, string> = { ...LAYER_NAMES, master: 'Master' }

/** Whether a chain has anything switched on (for the mixer's FX dot). */
export function chainActive(chain: FxChain): boolean {
  return chain.effects.some((e) => e.enabled) || chain.mods.some((m) => m.enabled)
}

const EFFECT_CARDS: Record<EffectType, { icon: string; hint: string }> = {
  strobe: { icon: '⚡', hint: 'Flash to white or black, steady or on the beat' },
  rgbSplit: { icon: '≋', hint: 'Pull the red and blue apart' },
  kaleidoscope: { icon: '✳', hint: 'Mirror into rotating segments' },
  mirror: { icon: '⇋', hint: 'Reflect left↔right or top↔bottom' },
  pixelate: { icon: '▦', hint: 'Big chunky pixels' },
  zoomBump: { icon: '⊕', hint: 'Zoom in (great on a kick envelope)' },
  shake: { icon: '〰', hint: 'Jitter the picture around' },
  invert: { icon: '◑', hint: 'Negative colors' },
  hueRotate: { icon: '◍', hint: 'Shift every color around the wheel' },
  feedback: { icon: '◎', hint: 'Trails and tunnels from earlier frames' },
}

/** "Strobe / flash 2" style names, numbered when a chain has several of one type. */
function effectNames(chain: FxChain): Map<string, string> {
  const seen = new Map<EffectType, number>()
  const names = new Map<string, string>()
  for (const e of chain.effects) {
    const n = (seen.get(e.type) ?? 0) + 1
    seen.set(e.type, n)
    const total = chain.effects.filter((x) => x.type === e.type).length
    names.set(e.id, `${EFFECT_DEFS[e.type].label}${total > 1 ? ` ${n}` : ''}`)
  }
  return names
}

/** The layer-motion rows: what they're called and the range their live meter shows. */
function motionRows(scope: FxScope): { target: string; label: string; spec: ParamSpec }[] {
  const opacity = scope === 'master' ? 'Brightness' : 'Opacity'
  return [
    { target: 'opacity', label: opacity, spec: { ...CHAIN_PARAMS.opacity!, min: 0, max: 1 } },
    { target: 'scale', label: 'Scale', spec: CHAIN_PARAMS.scale! },
    { target: 'rotation', label: 'Rotation', spec: CHAIN_PARAMS.rotation! },
    { target: 'x', label: 'Move X', spec: CHAIN_PARAMS.x! },
    { target: 'y', label: 'Move Y', spec: CHAIN_PARAMS.y! },
  ]
}

/** Every parameter a modulator in this chain can drive, as [target, label]. */
function targetOptions(chain: FxChain, scope: FxScope): [string, string][] {
  const names = effectNames(chain)
  const base = motionRows(scope).map((r): [string, string] => [r.target, r.label])
  const fx = chain.effects.flatMap((e) =>
    EFFECT_DEFS[e.type].params.map((p): [string, string] => [
      `${e.id}.${p.name}`,
      `${names.get(e.id)}: ${p.label}`,
    ]),
  )
  return [...base, ...fx]
}

/** One-line description of a modulator's source, for the overview. */
function sourceSummary(s: ModSource): string {
  switch (s.kind) {
    case 'lfo':
      return `${s.shape === 'random' ? 'random step' : s.shape} LFO, ${
        LFO_PERIODS.find((p) => p.beats === s.periodBeats)?.label ?? `${s.periodBeats} beats`
      }`
    case 'envelope':
      return `envelope on ${ENV_TRIGGER_LABELS[s.trigger].toLowerCase()}`
    case 'audio':
      return `${BAND_NAMES[s.band]} level`
  }
}

/** Modulator ranges are validated to ±1000. */
const limit = (v: number) => Math.max(-1000, Math.min(1000, v))

interface Ctx {
  fx: FxLink
  scope: FxScope
  chain: FxChain
  /** Targets whose modulator editors are expanded. */
  expanded: Set<string>
  toggle(target: string, open?: boolean): void
  live(target: string): LiveSource
}

/** The effects and modulators of one layer (or the master), shown in the context panel. */
export function FxPanel({ fx, scope }: { fx: FxLink; scope: FxScope }) {
  const [cardsOpen, setCardsOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // Live sources are cached per scope + target so sliders don't resubscribe on every render.
  const [liveCache] = useState(() => new Map<string, LiveSource>())
  const chain = fx.config[scope]
  const names = effectNames(chain)
  const count = chain.effects.length + chain.mods.length

  const live = (target: string): LiveSource => {
    const key = `${scope}|${target}`
    let src = liveCache.get(key)
    if (!src) {
      src = {
        get: () => fx.live.current[scope]?.[target],
        subscribe: (l) => fx.onLive(l),
      }
      liveCache.set(key, src)
    }
    return src
  }
  const ctx: Ctx = {
    fx,
    scope,
    chain,
    expanded,
    live,
    toggle: (target, open) =>
      setExpanded((prev) => {
        const next = new Set(prev)
        if (open ?? !next.has(target)) next.add(target)
        else next.delete(target)
        return next
      }),
  }
  const motionModulated = chain.mods.some((m) =>
    motionRows(scope).some((r) => r.target === m.target),
  )

  return (
    <div className="fx-panel" data-testid={`fx-panel-${scope}`}>
      <h2>Effects · {SCOPE_NAMES[scope]}</h2>

      <div className="fx-presets">
        {PRESET_IDS.map((id) => {
          const on = fx.presetActive(scope, id)
          return (
            <button
              key={id}
              className={`fx-preset${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => fx.togglePreset(scope, id)}
            >
              <span className="fx-preset-name">{PRESET_LABELS[id].label}</span>
              <span className="fx-preset-hint">{PRESET_LABELS[id].hint}</span>
            </button>
          )
        })}
      </div>

      <h3>Effects</h3>
      {chain.effects.length === 0 && (
        <p className="hint">No effects on this {scope === 'master' ? 'output' : 'layer'} yet.</p>
      )}
      {chain.effects.map((e, i) => (
        <EffectRow
          key={e.id}
          effect={e}
          name={names.get(e.id)!}
          first={i === 0}
          last={i === chain.effects.length - 1}
          ctx={ctx}
        />
      ))}
      <button
        className="fx-add-button"
        aria-expanded={cardsOpen}
        onClick={() => setCardsOpen(!cardsOpen)}
      >
        {cardsOpen ? 'Close' : '+ Add effect'}
      </button>
      {cardsOpen && (
        <div className="fx-cards" role="group" aria-label="Effects to add">
          {EFFECT_TYPES.map((t) => (
            <button
              key={t}
              className="fx-card"
              aria-label={`Add ${EFFECT_DEFS[t].label}`}
              onClick={() => {
                fx.addEffect(scope, t)
                setCardsOpen(false)
              }}
            >
              <span className="fx-card-icon" aria-hidden="true">
                {EFFECT_CARDS[t].icon}
              </span>
              <span className="fx-card-name">{EFFECT_DEFS[t].label}</span>
              <span className="fx-card-hint">{EFFECT_CARDS[t].hint}</span>
            </button>
          ))}
        </div>
      )}

      <details className="sub-section fx-motion" open={motionModulated || undefined}>
        <summary>{scope === 'master' ? 'Whole picture' : 'Layer'} motion and opacity</summary>
        <p className="hint">
          Press <b>~</b> to make one of these move with the music.
        </p>
        {motionRows(scope).map((r) => (
          <ParamRow key={r.target} ctx={ctx} target={r.target} label={r.label} spec={r.spec} />
        ))}
      </details>

      {chain.mods.length > 0 && <ModOverview ctx={ctx} />}

      {count > 0 && (
        <div className="fx-add">
          <button className="compact" onClick={() => fx.clear(scope)}>
            Clear all effects and modulators
          </button>
        </div>
      )}
    </div>
  )
}

function EffectRow(props: {
  effect: EffectInstance
  name: string
  first: boolean
  last: boolean
  ctx: Ctx
}) {
  const { effect: e, name, ctx } = props
  const { fx, scope } = ctx
  return (
    <div className={`fx-item${e.enabled ? '' : ' muted'}`} data-testid={`effect-${e.type}`}>
      <div className="fx-item-top">
        <label className="check">
          <input
            type="checkbox"
            aria-label={`Enable ${name}`}
            checked={e.enabled}
            onChange={(ev) => fx.updateEffect(scope, e.id, { enabled: ev.target.checked })}
          />
          {name}
        </label>
        {e.preset && <span className="tag">{PRESET_LABELS[e.preset].label}</span>}
        <button
          className="ms"
          aria-label={`Move ${name} up`}
          disabled={props.first}
          onClick={() => fx.moveEffect(scope, e.id, -1)}
        >
          ↑
        </button>
        <button
          className="ms"
          aria-label={`Move ${name} down`}
          disabled={props.last}
          onClick={() => fx.moveEffect(scope, e.id, 1)}
        >
          ↓
        </button>
        <button
          className="ms"
          aria-label={`Remove ${name}`}
          onClick={() => fx.removeEffect(scope, e.id)}
        >
          ✕
        </button>
      </div>
      {EFFECT_DEFS[e.type].params.map((p) => (
        <ParamRow
          key={p.name}
          ctx={ctx}
          target={`${e.id}.${p.name}`}
          label={p.label}
          aria={`${name} ${p.label}`}
          spec={p}
          value={e.params[p.name]!}
          onChange={(v) => fx.setEffectParam(scope, e.id, p.name, v)}
        />
      ))}
    </div>
  )
}

/**
 * One parameter: its slider (or, for layer motion, a live meter) and a "~" button that
 * attaches a modulator. The modulators driving it are edited right underneath.
 */
function ParamRow(props: {
  ctx: Ctx
  target: string
  label: string
  aria?: string
  spec: ParamSpec
  value?: number
  onChange?(v: number): void
}) {
  const { ctx, target, spec } = props
  const aria = props.aria ?? props.label
  // Effect parameters ("<effectId>.<param>") can be mapped to MIDI knobs.
  const dot = target.indexOf('.')
  const learnKey =
    dot > 0
      ? targetKey({
          kind: 'effectParam',
          scope: ctx.scope,
          effectId: target.slice(0, dot),
          param: target.slice(dot + 1),
        })
      : undefined
  const mods = ctx.chain.mods.map((m, i) => ({ m, i })).filter(({ m }) => m.target === target)
  const open = ctx.expanded.has(target) && mods.length > 0
  return (
    <div className={`fx-param-block${mods.length ? ' modulated' : ''}`}>
      <div className="fx-param">
        <span className="label">{props.label}</span>
        {props.value !== undefined && props.onChange ? (
          <SmartSlider
            aria={aria}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={props.value}
            defaultValue={spec.default}
            onChange={props.onChange}
            live={mods.length ? ctx.live(target) : undefined}
            learn={learnKey}
          />
        ) : (
          <LiveMeter live={ctx.live(target)} spec={spec} modulated={mods.length > 0} />
        )}
        <button
          className={`mod-button${mods.length ? ' on' : ''}`}
          aria-label={`Modulate ${aria}`}
          aria-pressed={mods.length > 0}
          aria-expanded={open}
          title={
            mods.length
              ? `${mods.length} modulator${mods.length > 1 ? 's' : ''}: click to ${open ? 'hide' : 'show'}`
              : 'Make this move with the music'
          }
          onClick={() => {
            if (mods.length === 0) {
              ctx.fx.addModulator(ctx.scope, target)
              ctx.toggle(target, true)
            } else ctx.toggle(target)
          }}
        >
          ~{mods.length > 1 ? mods.length : ''}
        </button>
      </div>
      {open && (
        <div className="fx-param-mods">
          {mods.map(({ m, i }) => (
            <ModEditor key={m.id} mod={m} index={i} ctx={ctx} />
          ))}
          <button
            className="link"
            onClick={() => ctx.fx.addModulator(ctx.scope, target)}
            title="Several modulators on one parameter add up"
          >
            + another modulator here
          </button>
        </div>
      )}
    </div>
  )
}

/** A live readout for parameters without a base slider (layer motion). */
function LiveMeter({
  live,
  spec,
  modulated,
}: {
  live: LiveSource
  spec: ParamSpec
  modulated: boolean
}) {
  const marker = useRef<HTMLSpanElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const update = () => {
      const v = live.get()
      if (marker.current) {
        marker.current.hidden = v === undefined
        if (v !== undefined) {
          const f = (Math.min(spec.max, Math.max(spec.min, v)) - spec.min) / (spec.max - spec.min)
          marker.current.style.left = `${f * 100}%`
        }
      }
      if (text.current)
        text.current.textContent = v === undefined ? '—' : formatByStep(v, spec.step)
    }
    update()
    return live.subscribe(update)
  }, [live, spec])
  return (
    <div className="live-meter" title={modulated ? 'Live value' : 'Not modulated'}>
      <div className="live-track">
        <span className="ghost-thumb" ref={marker} hidden />
      </div>
      <span className="slider-value" ref={text}>
        —
      </span>
    </div>
  )
}

const SOURCE_DEFAULTS: Record<ModSource['kind'], ModSource> = {
  lfo: { kind: 'lfo', shape: 'sine', periodBeats: 4, phase: 0 },
  envelope: { kind: 'envelope', trigger: 'kick', attackBeats: 0, decayBeats: 0.5 },
  audio: { kind: 'audio', band: 0, gain: 2 },
}

/** Edit one modulator, shown under the parameter it drives. */
function ModEditor({ mod: m, index, ctx }: { mod: Modulator; index: number; ctx: Ctx }) {
  const { fx, scope, chain } = ctx
  const label = `Modulator ${index + 1}`
  const spec = targetSpec(chain, m.target)
  const step = spec?.step ?? 0.01
  const update = (patch: Partial<Modulator>) => fx.updateModulator(scope, m.id, patch)
  const setSource = (patch: Partial<ModSource>) =>
    update({ source: { ...m.source, ...patch } as ModSource })
  const s = m.source
  const slider = (
    lab: string,
    aria: string,
    min: number,
    max: number,
    st: number,
    value: number,
    def: number,
    onChange: (v: number) => void,
  ) => (
    <div className="fx-param">
      <span className="label">{lab}</span>
      <SmartSlider
        aria={`${label} ${aria}`}
        min={min}
        max={max}
        step={st}
        value={value}
        defaultValue={def}
        onChange={onChange}
      />
    </div>
  )
  return (
    <div
      className={`fx-item mod-item${m.enabled ? '' : ' muted'}`}
      data-testid={`mod-${index + 1}`}
    >
      <div className="fx-item-top">
        <label className="check">
          <input
            type="checkbox"
            aria-label={`Enable ${label}`}
            checked={m.enabled}
            onChange={(ev) => update({ enabled: ev.target.checked })}
          />
          {label}
        </label>
        {m.preset && <span className="tag">{PRESET_LABELS[m.preset].label}</span>}
        <button
          className="ms"
          aria-label={`Remove ${label}`}
          onClick={() => fx.removeModulator(scope, m.id)}
        >
          ✕
        </button>
      </div>
      <div className="fx-source">
        <select
          aria-label={`${label} source`}
          value={s.kind}
          onChange={(ev) =>
            update({ source: SOURCE_DEFAULTS[ev.target.value as ModSource['kind']] })
          }
        >
          <option value="lfo">LFO (wave)</option>
          <option value="envelope">Beat envelope</option>
          <option value="audio">Audio band</option>
        </select>
        {s.kind === 'lfo' && (
          <>
            <select
              aria-label={`${label} shape`}
              value={s.shape}
              onChange={(ev) => setSource({ shape: ev.target.value as LfoShape })}
            >
              {LFO_SHAPES.map((sh) => (
                <option key={sh} value={sh}>
                  {sh === 'random' ? 'Random step' : sh[0]!.toUpperCase() + sh.slice(1)}
                </option>
              ))}
            </select>
            <select
              aria-label={`${label} period`}
              value={s.periodBeats}
              onChange={(ev) => setSource({ periodBeats: Number(ev.target.value) })}
            >
              {LFO_PERIODS.map((pd) => (
                <option key={pd.beats} value={pd.beats}>
                  {pd.label}
                </option>
              ))}
            </select>
          </>
        )}
        {s.kind === 'envelope' && (
          <select
            aria-label={`${label} trigger`}
            value={s.trigger}
            onChange={(ev) => setSource({ trigger: ev.target.value as EnvTrigger })}
          >
            {ENV_TRIGGERS.map((t) => (
              <option key={t} value={t}>
                {ENV_TRIGGER_LABELS[t]}
              </option>
            ))}
          </select>
        )}
        {s.kind === 'audio' && (
          <select
            aria-label={`${label} band`}
            value={s.band}
            onChange={(ev) => setSource({ band: Number(ev.target.value) })}
          >
            {BAND_NAMES.map((b, i) => (
              <option key={b} value={i}>
                {b}
              </option>
            ))}
          </select>
        )}
      </div>
      {s.kind === 'lfo' &&
        slider('Phase', 'phase', 0, 1, 0.05, s.phase, 0, (v) => setSource({ phase: v }))}
      {s.kind === 'envelope' && (
        <>
          {slider('Attack (beats)', 'attack', 0, 2, 0.05, s.attackBeats, 0, (v) =>
            setSource({ attackBeats: v }),
          )}
          {slider('Decay (beats)', 'decay', 0.05, 8, 0.05, s.decayBeats, 0.5, (v) =>
            setSource({ decayBeats: v }),
          )}
        </>
      )}
      {s.kind === 'audio' &&
        slider('Gain', 'gain', 0, 10, 0.1, s.gain, 2, (v) => setSource({ gain: v }))}
      {slider('Amount', 'amount', 0, 1, 0.01, m.amount, 1, (v) => update({ amount: v }))}
      <div className="fx-range" title="What the modulator adds to the value, from min to max">
        <span className="label">Adds</span>
        <input
          type="number"
          aria-label={`${label} min`}
          step={step}
          value={m.min}
          onChange={(ev) =>
            ev.target.value !== '' && update({ min: limit(Number(ev.target.value)) })
          }
        />
        <span>to</span>
        <input
          type="number"
          aria-label={`${label} max`}
          step={step}
          value={m.max}
          onChange={(ev) =>
            ev.target.value !== '' && update({ max: limit(Number(ev.target.value)) })
          }
        />
        <label className="check">
          <input
            type="checkbox"
            aria-label={`Invert ${label}`}
            checked={m.invert}
            onChange={(ev) => update({ invert: ev.target.checked })}
          />
          Invert
        </label>
      </div>
    </div>
  )
}

/** Every modulator in the chain at a glance, with a way to retarget or jump to it. */
function ModOverview({ ctx }: { ctx: Ctx }) {
  const { fx, scope, chain } = ctx
  const targets = targetOptions(chain, scope)
  return (
    <details className="sub-section mod-overview">
      <summary>All modulators ({chain.mods.length})</summary>
      {chain.mods.map((m, i) => {
        const label = `Modulator ${i + 1}`
        return (
          <div className={`mod-overview-row${m.enabled ? '' : ' muted'}`} key={m.id}>
            <span className="mod-overview-name">{i + 1}</span>
            <select
              aria-label={`${label} target`}
              value={m.target}
              onChange={(ev) => {
                fx.updateModulator(scope, m.id, { target: ev.target.value })
                ctx.toggle(ev.target.value, true)
              }}
            >
              {!targetSpec(chain, m.target) && <option value={m.target}>(missing)</option>}
              {targets.map(([t, l]) => (
                <option key={t} value={t}>
                  {l}
                </option>
              ))}
            </select>
            <span className="mod-overview-src">{sourceSummary(m.source)}</span>
            <button
              className="link"
              aria-label={`Show ${label}`}
              onClick={() => ctx.toggle(m.target, true)}
            >
              show
            </button>
          </div>
        )
      })}
    </details>
  )
}
