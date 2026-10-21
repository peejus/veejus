import { useEffect, useRef, useState } from 'react'
import { EFFECT_DEFS, type FxConfig } from '@shared/fx'
import {
  CC_MODES,
  CC_MODE_LABELS,
  TEMPLATES,
  TEMPLATE_LABELS,
  isContinuous,
  targetKey,
  targetLabel,
  type CcMode,
  type MidiBinding,
  type MidiTarget,
  type TemplateId,
} from '@shared/midi'
import type { MidiLink } from './useMidi'

/** Controls that aren't buttons on screen, so they're learned from here. */
const EXTRA_TARGETS: MidiTarget[] = [
  { kind: 'armModifier' },
  { kind: 'dropNow' },
  { kind: 'bankNext' },
  { kind: 'bankPrev' },
  { kind: 'quantizeCycle' },
]

const sourceText = (b: MidiBinding) =>
  `${b.device ?? 'Any device'} · ${b.type === 'note' ? 'Note' : 'CC'} ${b.number} · ch ${b.channel + 1}`

export function MidiSetup({ midi, fx }: { midi: MidiLink; fx: FxConfig }) {
  const monitor = useRef<HTMLSpanElement>(null)
  const [template, setTemplate] = useState<TemplateId>('apcMini')
  const [tplInput, setTplInput] = useState<string>('')
  const [tplOutput, setTplOutput] = useState<string>('')
  const { onMessage } = midi

  useEffect(
    () =>
      onMessage((device, text) => {
        if (monitor.current) monitor.current.textContent = `${device}: ${text}`
      }),
    [onMessage],
  )

  // Name an effect by its type, for labels like "Overlay A: RGB split amount".
  const effectName = (id: string) => {
    for (const chain of Object.values(fx)) {
      const e = chain.effects.find((x) => x.id === id)
      if (e) return EFFECT_DEFS[e.type].label
    }
    return undefined
  }

  const bindings = [...midi.settings.bindings].sort((a, b) =>
    targetLabel(a.target).localeCompare(targetLabel(b.target), undefined, { numeric: true }),
  )

  return (
    <>
      <section className="panel midi-panel">
        <h2>MIDI controllers</h2>
        {!midi.supported ? (
          <p className="hint">This build has no Web MIDI.</p>
        ) : midi.error ? (
          <p className="error-text">MIDI unavailable: {midi.error}</p>
        ) : (
          <dl className="facts">
            <dt>Inputs</dt>
            <dd data-testid="midi-inputs">{midi.inputs.join(', ') || 'none found'}</dd>
            <dt>Outputs</dt>
            <dd>{midi.outputs.join(', ') || 'none found'}</dd>
            <dt>Last message</dt>
            <dd>
              <span ref={monitor} data-testid="midi-monitor">
                —
              </span>
            </dd>
          </dl>
        )}
        <button
          className={`learn-button${midi.learn.active ? ' on' : ''}`}
          aria-pressed={midi.learn.active}
          onClick={() => midi.setLearn(!midi.learn.active)}
        >
          {midi.learn.active ? 'Done learning' : 'MIDI learn…'}
        </button>
        <p className="hint">
          MIDI learn: click a pad, button, fader or effect slider anywhere in Veejus, then press or
          move the control on your controller. Map as many as you like, then press Done.
        </p>

        <h3>Actions without a button on screen</h3>
        <div className="midi-extras">
          {EXTRA_TARGETS.map((t) => (
            <button key={targetKey(t)} data-learn={targetKey(t)} disabled={!midi.learn.active}>
              {targetLabel(t)}
            </button>
          ))}
        </div>
        {!midi.learn.active && <p className="hint">Turn on MIDI learn to map these.</p>}
      </section>

      <section className="panel">
        <h2>Controller template</h2>
        <p className="hint">Maps a whole controller at once, LEDs included.</p>
        <div className="field">
          <span className="label">Controller</span>
          <select
            aria-label="Controller template"
            value={template}
            onChange={(e) => setTemplate(e.target.value as TemplateId)}
          >
            {TEMPLATES.map((t) => (
              <option key={t} value={t}>
                {TEMPLATE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <span className="label">Input</span>
          <select
            aria-label="Template input"
            value={tplInput}
            onChange={(e) => setTplInput(e.target.value)}
          >
            <option value="">Any device</option>
            {midi.inputs.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <span className="label">LEDs to</span>
          <select
            aria-label="Template output"
            value={tplOutput}
            onChange={(e) => setTplOutput(e.target.value)}
          >
            <option value="">No LED feedback</option>
            {midi.outputs.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <button onClick={() => midi.applyTemplate(template, tplInput || null, tplOutput || null)}>
          Apply template
        </button>
      </section>

      <section className="panel">
        <h2>LED feedback</h2>
        <div className="field">
          <span className="label">Output</span>
          <select
            aria-label="LED feedback output"
            value={midi.settings.feedbackOutput ?? ''}
            onChange={(e) => midi.setFeedbackOutput(e.target.value || null)}
          >
            <option value="">None</option>
            {midi.outputs.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            {midi.settings.feedbackOutput &&
              !midi.outputs.includes(midi.settings.feedbackOutput) && (
                <option value={midi.settings.feedbackOutput}>
                  {midi.settings.feedbackOutput} (not connected)
                </option>
              )}
          </select>
        </div>
        <p className="hint">
          Pads mapped to notes light up: off when empty, yellow ready, green playing, blinking green
          queued, blinking red armed.
        </p>
      </section>

      <section className="panel">
        <h2>
          Mappings <span className="count">{bindings.length}</span>
        </h2>
        {bindings.length === 0 ? (
          <p className="hint">Nothing mapped yet. Use MIDI learn or a template.</p>
        ) : (
          <ul className="midi-bindings" data-testid="midi-bindings">
            {bindings.map((b) => (
              <li key={b.id}>
                <span className="midi-target">{targetLabel(b.target, effectName)}</span>
                <span className="midi-source">{sourceText(b)}</span>
                {b.type === 'cc' && isContinuous(b.target) && (
                  <select
                    aria-label={`${targetLabel(b.target, effectName)} CC mode`}
                    value={b.ccMode}
                    onChange={(e) => midi.updateBinding(b.id, { ccMode: e.target.value as CcMode })}
                  >
                    {CC_MODES.map((m) => (
                      <option key={m} value={m}>
                        {CC_MODE_LABELS[m]}
                      </option>
                    ))}
                  </select>
                )}
                {b.type === 'note' && b.target.kind === 'pad' && (
                  <label className="check" title="Hit harder for a more opaque clip">
                    <input
                      type="checkbox"
                      checked={b.velocity}
                      onChange={(e) => midi.updateBinding(b.id, { velocity: e.target.checked })}
                    />
                    Velocity
                  </label>
                )}
                <button
                  className="ms"
                  aria-label={`Remove mapping ${targetLabel(b.target, effectName)}`}
                  onClick={() => midi.removeBinding(b.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        {bindings.length > 0 && (
          <button className="subtle" onClick={midi.clearBindings}>
            Remove all mappings
          </button>
        )}
      </section>
    </>
  )
}

/** The bar shown while MIDI learn is on. */
export function LearnBanner({ midi }: { midi: MidiLink }) {
  if (!midi.learn.active) return null
  const t = midi.learn.target
  return (
    <div className="learn-banner" role="status" data-testid="learn-banner">
      <b>MIDI learn</b>
      <span>
        {t
          ? `Now press or move a control on your MIDI controller for “${midi.learn.label ?? targetLabel(t)}”…`
          : 'Click a pad, button, fader or effect slider, then press or move a control on your controller.'}
      </span>
      {midi.learn.lastMapped && <span className="learn-last">Mapped: {midi.learn.lastMapped}</span>}
      <button onClick={() => midi.setLearn(false)}>Done</button>
    </div>
  )
}
