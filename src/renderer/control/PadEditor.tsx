import { useState } from 'react'
import {
  PAD_COLS,
  PAD_KEY_LABELS,
  PLAY_MODES,
  PLAY_MODE_LABELS,
  QUANTIZE_LABELS,
  QUANTIZES,
  autoLayer,
  padId,
  type PadConfig,
  type PadSource,
  type PlayMode,
  type Quantize,
  type RetriggerUnit,
} from '@shared/pads'
import {
  ANCHORS,
  ANCHOR_LABELS,
  ENTRANCES,
  ENTRANCE_LABELS,
  KEY_BLUE,
  KEY_GREEN,
  LAYER_IDS,
  LAYER_NAMES,
  type Anchor,
  type Entrance,
  type KeySettings,
  type LayerId,
  type Placement,
} from '@shared/layers'
import { FIT_MODES, type ClipInfo, type FitMode } from '@shared/protocol'
import { hexToRgb, rgbToHex } from '@shared/color'
import type { PadsLink } from './usePads'

/** Key presets shown in one menu; 'custom' uses the color picker. */
type KeyChoice = 'none' | 'green' | 'blue' | 'custom' | 'luma'

function keyChoice(k: KeySettings): KeyChoice {
  if (k.mode === 'none') return 'none'
  if (k.mode === 'luma') return 'luma'
  if (rgbToHex(k.color) === rgbToHex(KEY_GREEN)) return 'green'
  if (rgbToHex(k.color) === rgbToHex(KEY_BLUE)) return 'blue'
  return 'custom'
}

function Range(props: {
  label: string
  min: number
  max: number
  step: number
  value: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <label className="field">
      <span className="label">{props.label}</span>
      <input
        type="range"
        aria-label={props.label}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <code className="slider-value">{props.format(props.value)}</code>
    </label>
  )
}

const pct = (v: number) => `${Math.round(v * 100)}%`

/** Where the clip goes: the basic placement settings. */
function PositionEditor({ p, set }: { p: Placement; set: (patch: Partial<Placement>) => void }) {
  return (
    <>
      <label className="field">
        <span className="label">Position</span>
        <select
          aria-label="Position"
          value={p.anchor}
          onChange={(e) => set({ anchor: e.target.value as Anchor })}
        >
          {ANCHORS.map((a) => (
            <option key={a} value={a}>
              {ANCHOR_LABELS[a]}
            </option>
          ))}
        </select>
      </label>
      {p.anchor === 'full' || p.anchor === 'leftHalf' || p.anchor === 'rightHalf' ? (
        <label className="field">
          <span className="label">Fit</span>
          <select
            aria-label="Placement fit"
            value={p.fit}
            onChange={(e) => set({ fit: e.target.value as FitMode })}
          >
            {FIT_MODES.map((f) => (
              <option key={f} value={f}>
                {f[0]!.toUpperCase() + f.slice(1)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <Range
          label="Size"
          min={0.05}
          max={1}
          step={0.01}
          value={p.size}
          format={pct}
          onChange={(v) => set({ size: v })}
        />
      )}
    </>
  )
}

/** Fine placement and the entrance animation (advanced). */
function MotionEditor({ p, set }: { p: Placement; set: (patch: Partial<Placement>) => void }) {
  return (
    <>
      <Range
        label="Offset X"
        min={-0.5}
        max={0.5}
        step={0.01}
        value={p.offsetX}
        format={pct}
        onChange={(v) => set({ offsetX: v })}
      />
      <Range
        label="Offset Y"
        min={-0.5}
        max={0.5}
        step={0.01}
        value={p.offsetY}
        format={pct}
        onChange={(v) => set({ offsetY: v })}
      />
      <Range
        label="Rotation"
        min={-180}
        max={180}
        step={1}
        value={p.rotationDeg}
        format={(v) => `${v}°`}
        onChange={(v) => set({ rotationDeg: v })}
      />
      <label className="field">
        <span className="label">Entrance</span>
        <select
          aria-label="Entrance"
          value={p.entrance}
          onChange={(e) => set({ entrance: e.target.value as Entrance })}
        >
          {ENTRANCES.map((en) => (
            <option key={en} value={en}>
              {ENTRANCE_LABELS[en]}
            </option>
          ))}
        </select>
        {p.entrance !== 'none' && (
          <select
            aria-label="Entrance length"
            value={p.entranceBeats}
            onChange={(e) => set({ entranceBeats: Number(e.target.value) })}
          >
            {[0.25, 0.5, 1, 2, 4].map((b) => (
              <option key={b} value={b}>
                {b} beat{b === 1 ? '' : 's'}
              </option>
            ))}
          </select>
        )}
      </label>
    </>
  )
}

function KeyEditor({ k, set }: { k: KeySettings; set: (patch: Partial<KeySettings>) => void }) {
  const choice = keyChoice(k)
  return (
    <details className="sub-section" open={k.mode !== 'none'}>
      <summary>Keying</summary>
      <label className="field">
        <span className="label">Remove</span>
        <select
          aria-label="Key"
          value={choice}
          onChange={(e) => {
            const v = e.target.value as KeyChoice
            if (v === 'none') set({ mode: 'none' })
            else if (v === 'luma') set({ mode: 'luma' })
            else if (v === 'green') set({ mode: 'chroma', color: KEY_GREEN })
            else if (v === 'blue') set({ mode: 'chroma', color: KEY_BLUE })
            else set({ mode: 'chroma' })
          }}
        >
          <option value="none">Nothing</option>
          <option value="green">Green screen</option>
          <option value="blue">Blue screen</option>
          <option value="custom">Custom color</option>
          <option value="luma">Dark areas (luma key)</option>
        </select>
        {choice === 'custom' && (
          <input
            type="color"
            aria-label="Key color"
            value={rgbToHex(k.color)}
            onChange={(e) => {
              const rgb = hexToRgb(e.target.value)
              if (rgb) set({ color: rgb })
            }}
          />
        )}
      </label>
      {k.mode === 'chroma' && (
        <>
          <Range
            label="Similarity"
            min={0}
            max={1}
            step={0.01}
            value={k.similarity}
            format={pct}
            onChange={(v) => set({ similarity: v })}
          />
          <Range
            label="Smoothness"
            min={0}
            max={1}
            step={0.01}
            value={k.smoothness}
            format={pct}
            onChange={(v) => set({ smoothness: v })}
          />
          <Range
            label="Spill"
            min={0}
            max={1}
            step={0.01}
            value={k.spill}
            format={pct}
            onChange={(v) => set({ spill: v })}
          />
        </>
      )}
      {k.mode === 'luma' && (
        <>
          <Range
            label="Threshold"
            min={0}
            max={1}
            step={0.01}
            value={k.threshold}
            format={pct}
            onChange={(v) => set({ threshold: v })}
          />
          <Range
            label="Softness"
            min={0}
            max={1}
            step={0.01}
            value={k.softness}
            format={pct}
            onChange={(v) => set({ softness: v })}
          />
          <label className="field check">
            <input
              type="checkbox"
              aria-label="Invert luma key"
              checked={k.invert}
              onChange={(e) => set({ invert: e.target.checked })}
            />
            Remove bright areas instead
          </label>
        </>
      )}
    </details>
  )
}

const BEAT_CHOICES = [0.5, 1, 2, 4, 8, 16, 32]
const FADE_CHOICES = [0, 0.25, 0.5, 1, 2, 4]

const beatsLabel = (b: number) =>
  b >= 4 && b % 4 === 0 ? `${b / 4} bar${b === 4 ? '' : 's'}` : `${b} beat${b === 1 ? '' : 's'}`

function sourceValue(s: PadSource | null): string {
  if (!s) return ''
  switch (s.kind) {
    case 'clip':
      return `clip:${s.clipId}`
    case 'collection':
      return `collection:${s.tag}`
    case 'favorites':
      return 'favorites'
    case 'random':
      return `random:${s.folder ?? ''}`
  }
}

function sourceFromValue(v: string): PadSource | null {
  if (!v) return null
  if (v.startsWith('clip:')) return { kind: 'clip', clipId: v.slice(5) }
  if (v.startsWith('collection:')) return { kind: 'collection', tag: v.slice('collection:'.length) }
  if (v === 'favorites') return { kind: 'favorites' }
  const folder = v.slice('random:'.length)
  return { kind: 'random', folder: folder || null }
}

/** Every collection used in the library, sorted. */
function collections(clips: ClipInfo[]): string[] {
  return [...new Set(clips.flatMap((c) => c.tags))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  )
}

/** Parent folders of the library's clips, for random pads. */
function folders(clips: ClipInfo[]): string[] {
  const set = new Set(clips.map((c) => c.path.replaceAll('\\', '/').replace(/\/[^/]*$/, '')))
  return [...set].sort()
}

const ADVANCED_KEY = 'veejus.padEditor.advancedOpen'

/** Whether "More settings" is open; remembered across pads and restarts. */
function useAdvancedOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(ADVANCED_KEY) === '1'
    } catch {
      return false
    }
  })
  const set = (v: boolean) => {
    setOpen(v)
    try {
      localStorage.setItem(ADVANCED_KEY, v ? '1' : '0')
    } catch {
      // Storage may be unavailable; the setting just isn't remembered.
    }
  }
  return [open, set]
}

/** Short list of the advanced settings that differ from the defaults, for the summary line. */
function advancedSummary(config: PadConfig): string {
  const parts: string[] = []
  if (config.quantize !== 'global') parts.push(`quantize ${QUANTIZE_LABELS[config.quantize]}`)
  if (config.fadeInBeats > 0 || config.fadeOutBeats > 0) parts.push('fades')
  if (config.syncBeats !== null) parts.push('tempo sync')
  const p = config.placement
  if (p.offsetX !== 0 || p.offsetY !== 0 || p.rotationDeg !== 0) parts.push('moved')
  if (p.entrance !== 'none') parts.push(ENTRANCE_LABELS[p.entrance].split(' ')[0]!.toLowerCase())
  if (config.key.mode !== 'none') parts.push(config.key.mode === 'luma' ? 'luma key' : 'chroma key')
  return parts.join(' · ')
}

export function PadEditor({ pads, clips }: { pads: PadsLink; clips: ClipInfo[] }) {
  const [advancedOpen, setAdvancedOpen] = useAdvancedOpen()
  const sel = pads.selected
  if (!sel) return null
  const config = pads.banks[sel.bank]![sel.index]!
  const set = (patch: Partial<PadConfig>) => pads.update(sel, patch)
  const setPlacement = (patch: Partial<Placement>) =>
    set({ placement: { ...config.placement, ...patch } })
  const id = padId(sel.bank, sel.index)
  const key = PAD_KEY_LABELS[Math.floor(sel.index / PAD_COLS)]![sel.index % PAD_COLS]
  const globalQ = QUANTIZE_LABELS[pads.settings.quantize]
  const changed = advancedSummary(config)

  return (
    <div className="pad-editor" data-testid="pad-editor">
      <h2>
        Pad {id} <span className="muted">(key {key})</span>
      </h2>
      <div className="row editor-actions">
        <button onClick={() => pads.press(sel)} disabled={!config.source}>
          Fire
        </button>
        <button onClick={() => pads.arm(sel)} disabled={!config.source}>
          Arm for drop
        </button>
        <button className="subtle" onClick={() => pads.assign(sel, null)} disabled={!config.source}>
          Clear
        </button>
      </div>

      <label className="field">
        <span className="label">Plays</span>
        <select
          aria-label="Pad source"
          value={sourceValue(config.source)}
          onChange={(e) => set({ source: sourceFromValue(e.target.value) })}
        >
          <option value="">(empty)</option>
          <optgroup label="Random clip">
            <option value="random:">Random from all clips</option>
            <option value="favorites">Random from ★ favorites</option>
            {collections(clips).map((t) => (
              <option key={`c-${t}`} value={`collection:${t}`}>
                Random from collection: {t}
              </option>
            ))}
            {folders(clips).map((f) => (
              <option key={f} value={`random:${f}`}>
                Random from {f.split('/').pop()}
              </option>
            ))}
          </optgroup>
          <optgroup label="Clip">
            {clips.map((c) => (
              <option key={c.id} value={`clip:${c.id}`}>
                {c.name}
              </option>
            ))}
          </optgroup>
        </select>
      </label>

      <label className="field">
        <span className="label">Mode</span>
        <select
          aria-label="Pad mode"
          value={config.mode}
          onChange={(e) => set({ mode: e.target.value as PlayMode })}
        >
          {PLAY_MODES.map((m) => (
            <option key={m} value={m}>
              {PLAY_MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </label>

      {config.mode === 'beats' && (
        <label className="field">
          <span className="label">Length</span>
          <select
            aria-label="Pad length"
            value={config.lengthBeats}
            onChange={(e) => set({ lengthBeats: Number(e.target.value) })}
          >
            {BEAT_CHOICES.map((b) => (
              <option key={b} value={b}>
                {beatsLabel(b)}
              </option>
            ))}
          </select>
        </label>
      )}

      {config.mode === 'retrigger' && (
        <label className="field">
          <span className="label">Restart every</span>
          <select
            aria-label="Retrigger every"
            value={config.retriggerEvery}
            onChange={(e) => set({ retriggerEvery: e.target.value as RetriggerUnit })}
          >
            <option value="beat">Beat</option>
            <option value="bar">Bar</option>
          </select>
        </label>
      )}

      <label className="field">
        <span className="label">Layer</span>
        <select
          aria-label="Pad layer"
          value={config.layer}
          onChange={(e) => set({ layer: e.target.value as LayerId | 'auto' })}
        >
          <option value="auto">
            Auto ({LAYER_NAMES[autoLayer(config.mode, false)]}; drops: Takeover)
          </option>
          {LAYER_IDS.map((lid) => (
            <option key={lid} value={lid}>
              {LAYER_NAMES[lid]}
            </option>
          ))}
        </select>
      </label>

      <PositionEditor p={config.placement} set={setPlacement} />

      <details
        className="sub-section advanced"
        data-testid="pad-advanced"
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>
          More settings
          {changed && <span className="advanced-summary"> · {changed}</span>}
        </summary>

        <label className="field">
          <span className="label">Quantize</span>
          <select
            aria-label="Pad quantize"
            value={config.quantize}
            onChange={(e) => set({ quantize: e.target.value as Quantize | 'global' })}
          >
            <option value="global">Global ({globalQ})</option>
            {QUANTIZES.map((q) => (
              <option key={q} value={q}>
                {QUANTIZE_LABELS[q]}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span className="label">Fade in / out</span>
          <select
            aria-label="Fade in"
            value={config.fadeInBeats}
            onChange={(e) => set({ fadeInBeats: Number(e.target.value) })}
          >
            {FADE_CHOICES.map((b) => (
              <option key={b} value={b}>
                {b === 0 ? 'none' : `${b} beat${b === 1 ? '' : 's'}`}
              </option>
            ))}
          </select>
          <select
            aria-label="Fade out"
            value={config.fadeOutBeats}
            onChange={(e) => set({ fadeOutBeats: Number(e.target.value) })}
          >
            {FADE_CHOICES.map((b) => (
              <option key={b} value={b}>
                {b === 0 ? 'none' : `${b} beat${b === 1 ? '' : 's'}`}
              </option>
            ))}
          </select>
        </div>

        <label className="field">
          <span className="label">Tempo sync</span>
          <select
            aria-label="Tempo sync"
            value={config.syncBeats ?? ''}
            onChange={(e) => set({ syncBeats: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">Off (normal speed)</option>
            {BEAT_CHOICES.map((b) => (
              <option key={b} value={b}>
                Stretch to {beatsLabel(b)}
              </option>
            ))}
          </select>
        </label>

        <MotionEditor p={config.placement} set={setPlacement} />
        <KeyEditor k={config.key} set={(patch) => set({ key: { ...config.key, ...patch } })} />
      </details>
    </div>
  )
}
