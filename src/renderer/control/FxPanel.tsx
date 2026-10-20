import { useState } from 'react'
import { BAND_NAMES } from '@shared/audio'
import { LAYER_NAMES } from '@shared/layers'
import {
  CHAIN_PARAMS,
  EFFECT_DEFS,
  EFFECT_TYPES,
  ENV_TRIGGERS,
  ENV_TRIGGER_LABELS,
  FX_SCOPES,
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
} from '@shared/fx'
import type { FxLink } from './useFx'

const SCOPE_NAMES: Record<FxScope, string> = { ...LAYER_NAMES, master: 'Master' }
const SHORT: Record<FxScope, string> = {
  background: 'BG',
  overlayA: 'A',
  overlayB: 'B',
  takeover: 'TO',
  master: 'Master',
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

/** Every parameter a modulator in this chain can drive, as [target, label]. */
function targetOptions(chain: FxChain, scope: FxScope): [string, string][] {
  const names = effectNames(chain)
  const base = Object.values(CHAIN_PARAMS)
    .filter((p) => scope !== 'master' || p.name !== 'opacity')
    .map((p): [string, string] => [p.name, p.label])
  if (scope === 'master') base.unshift(['opacity', 'Brightness'])
  const fx = chain.effects.flatMap((e) =>
    EFFECT_DEFS[e.type].params.map((p): [string, string] => [
      `${e.id}.${p.name}`,
      `${names.get(e.id)}: ${p.label}`,
    ]),
  )
  return [...base, ...fx]
}

/** Modulator ranges are validated to ±1000. */
const limit = (v: number) => Math.max(-1000, Math.min(1000, v))

const fmt = (v: number, step: number) =>
  step >= 1 ? String(Math.round(v)) : v.toFixed(step >= 0.01 ? 2 : 3)

export function FxPanel({ fx }: { fx: FxLink }) {
  const [scope, setScope] = useState<FxScope>('overlayA')
  const [adding, setAdding] = useState<EffectType>('strobe')
  const chain = fx.config[scope]
  const names = effectNames(chain)
  const targets = targetOptions(chain, scope)
  const count = (s: FxScope) => fx.config[s].effects.length + fx.config[s].mods.length

  return (
    <section className="panel fx-panel">
      <h2>Effects &amp; modulation</h2>
      <div className="segmented fx-scopes" role="tablist" aria-label="Effects scope">
        {FX_SCOPES.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={scope === s}
            className={scope === s ? 'on' : ''}
            title={SCOPE_NAMES[s]}
            aria-label={`${SCOPE_NAMES[s]} effects`}
            onClick={() => setScope(s)}
          >
            {SHORT[s]}
            {count(s) > 0 && <span className="fx-count">{count(s)}</span>}
          </button>
        ))}
      </div>
      <p className="hint">{SCOPE_NAMES[scope]}</p>

      <div className="fx-presets">
        {PRESET_IDS.map((id) => {
          const on = fx.presetActive(scope, id)
          return (
            <button
              key={id}
              className={`fx-preset${on ? ' on' : ''}`}
              aria-pressed={on}
              title={PRESET_LABELS[id].hint}
              onClick={() => fx.togglePreset(scope, id)}
            >
              {PRESET_LABELS[id].label}
            </button>
          )
        })}
      </div>

      <h3>Effects</h3>
      {chain.effects.length === 0 && (
        <p className="hint">No effects on this {scope === 'master' ? 'output' : 'layer'}.</p>
      )}
      {chain.effects.map((e, i) => (
        <EffectRow
          key={e.id}
          effect={e}
          name={names.get(e.id)!}
          first={i === 0}
          last={i === chain.effects.length - 1}
          fx={fx}
          scope={scope}
        />
      ))}
      <div className="fx-add">
        <select
          aria-label="Effect to add"
          value={adding}
          onChange={(e) => setAdding(e.target.value as EffectType)}
        >
          {EFFECT_TYPES.map((t) => (
            <option key={t} value={t}>
              {EFFECT_DEFS[t].label}
            </option>
          ))}
        </select>
        <button onClick={() => fx.addEffect(scope, adding)}>Add effect</button>
      </div>

      <h3>Modulators</h3>
      {chain.mods.length === 0 && <p className="hint">Nothing modulated yet.</p>}
      {chain.mods.map((m, i) => (
        <ModRow
          key={m.id}
          mod={m}
          index={i}
          chain={chain}
          targets={targets}
          fx={fx}
          scope={scope}
        />
      ))}
      <div className="fx-add">
        <button onClick={() => fx.addModulator(scope, targets[0]![0])}>Add modulator</button>
        {count(scope) > 0 && (
          <button className="compact" onClick={() => fx.clear(scope)}>
            Clear all
          </button>
        )}
      </div>
    </section>
  )
}

function EffectRow(props: {
  effect: EffectInstance
  name: string
  first: boolean
  last: boolean
  fx: FxLink
  scope: FxScope
}) {
  const { effect: e, name, fx, scope } = props
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
        <label className="fx-param" key={p.name}>
          <span className="label">{p.label}</span>
          <input
            type="range"
            aria-label={`${name} ${p.label}`}
            min={p.min}
            max={p.max}
            step={p.step}
            value={e.params[p.name]}
            onChange={(ev) => fx.setEffectParam(scope, e.id, p.name, Number(ev.target.value))}
          />
          <code className="slider-value">{fmt(e.params[p.name]!, p.step)}</code>
        </label>
      ))}
    </div>
  )
}

const SOURCE_DEFAULTS: Record<ModSource['kind'], ModSource> = {
  lfo: { kind: 'lfo', shape: 'sine', periodBeats: 4, phase: 0 },
  envelope: { kind: 'envelope', trigger: 'kick', attackBeats: 0, decayBeats: 0.5 },
  audio: { kind: 'audio', band: 0, gain: 2 },
}

function ModRow(props: {
  mod: Modulator
  index: number
  chain: FxChain
  targets: [string, string][]
  fx: FxLink
  scope: FxScope
}) {
  const { mod: m, chain, targets, fx, scope } = props
  const label = `Modulator ${props.index + 1}`
  const spec = targetSpec(chain, m.target)
  const step = spec?.step ?? 0.01
  const update = (patch: Partial<Modulator>) => fx.updateModulator(scope, m.id, patch)
  const setSource = (patch: Partial<ModSource>) =>
    update({ source: { ...m.source, ...patch } as ModSource })
  const s = m.source
  return (
    <div className={`fx-item${m.enabled ? '' : ' muted'}`} data-testid={`mod-${props.index + 1}`}>
      <div className="fx-item-top">
        <input
          type="checkbox"
          aria-label={`Enable ${label}`}
          checked={m.enabled}
          onChange={(ev) => update({ enabled: ev.target.checked })}
        />
        <select
          aria-label={`${label} target`}
          value={m.target}
          onChange={(ev) => update({ target: ev.target.value })}
        >
          {!spec && <option value={m.target}>(missing)</option>}
          {targets.map(([t, l]) => (
            <option key={t} value={t}>
              {l}
            </option>
          ))}
        </select>
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
          <option value="lfo">LFO</option>
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
      {s.kind === 'lfo' && (
        <Slider
          label="Phase"
          aria={`${label} phase`}
          min={0}
          max={1}
          step={0.05}
          value={s.phase}
          onChange={(v) => setSource({ phase: v })}
        />
      )}
      {s.kind === 'envelope' && (
        <>
          <Slider
            label="Attack (beats)"
            aria={`${label} attack`}
            min={0}
            max={2}
            step={0.05}
            value={s.attackBeats}
            onChange={(v) => setSource({ attackBeats: v })}
          />
          <Slider
            label="Decay (beats)"
            aria={`${label} decay`}
            min={0.05}
            max={8}
            step={0.05}
            value={s.decayBeats}
            onChange={(v) => setSource({ decayBeats: v })}
          />
        </>
      )}
      {s.kind === 'audio' && (
        <Slider
          label="Gain"
          aria={`${label} gain`}
          min={0}
          max={10}
          step={0.1}
          value={s.gain}
          onChange={(v) => setSource({ gain: v })}
        />
      )}
      <Slider
        label="Amount"
        aria={`${label} amount`}
        min={0}
        max={1}
        step={0.01}
        value={m.amount}
        onChange={(v) => update({ amount: v })}
      />
      <div className="fx-range">
        <span className="label">Range</span>
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

function Slider(props: {
  label: string
  aria: string
  min: number
  max: number
  step: number
  value: number
  onChange(v: number): void
}) {
  return (
    <label className="fx-param">
      <span className="label">{props.label}</span>
      <input
        type="range"
        aria-label={props.aria}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(ev) => props.onChange(Number(ev.target.value))}
      />
      <code className="slider-value">{fmt(props.value, props.step)}</code>
    </label>
  )
}
