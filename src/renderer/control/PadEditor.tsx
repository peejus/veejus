import {
  PAD_COLS,
  PAD_KEY_LABELS,
  PLAY_MODES,
  PLAY_MODE_LABELS,
  QUANTIZE_LABELS,
  QUANTIZES,
  padId,
  type PadConfig,
  type PadSource,
  type PlayMode,
  type Quantize,
  type RetriggerUnit,
} from '@shared/pads'
import type { ClipInfo } from '@shared/protocol'
import type { PadsLink } from './usePads'

const BEAT_CHOICES = [0.5, 1, 2, 4, 8, 16, 32]
const FADE_CHOICES = [0, 0.25, 0.5, 1, 2, 4]

const beatsLabel = (b: number) =>
  b >= 4 && b % 4 === 0 ? `${b / 4} bar${b === 4 ? '' : 's'}` : `${b} beat${b === 1 ? '' : 's'}`

function sourceValue(s: PadSource | null): string {
  if (!s) return ''
  return s.kind === 'clip' ? `clip:${s.clipId}` : `random:${s.folder ?? ''}`
}

function sourceFromValue(v: string): PadSource | null {
  if (!v) return null
  if (v.startsWith('clip:')) return { kind: 'clip', clipId: v.slice(5) }
  const folder = v.slice('random:'.length)
  return { kind: 'random', folder: folder || null }
}

/** Parent folders of the library's clips, for random pads. */
function folders(clips: ClipInfo[]): string[] {
  const set = new Set(clips.map((c) => c.path.replaceAll('\\', '/').replace(/\/[^/]*$/, '')))
  return [...set].sort()
}

export function PadEditor({ pads, clips }: { pads: PadsLink; clips: ClipInfo[] }) {
  const sel = pads.selected
  if (!sel) {
    return (
      <section className="panel">
        <h2>Pad</h2>
        <p className="hint">
          Right-click a pad (or use Edit pads) to set its clip, play mode, quantize and fades.
        </p>
      </section>
    )
  }
  const config = pads.banks[sel.bank]![sel.index]!
  const set = (patch: Partial<PadConfig>) => pads.update(sel, patch)
  const id = padId(sel.bank, sel.index)
  const key = PAD_KEY_LABELS[Math.floor(sel.index / PAD_COLS)]![sel.index % PAD_COLS]
  const globalQ = QUANTIZE_LABELS[pads.settings.quantize]

  return (
    <section className="panel pad-editor" data-testid="pad-editor">
      <h2>
        Pad {id} <span className="muted">(key {key})</span>
      </h2>

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
    </section>
  )
}
