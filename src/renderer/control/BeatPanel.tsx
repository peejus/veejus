import { useEffect, useRef, useState } from 'react'
import {
  BEATS_PER_BAR,
  LATENCY_OFFSET_RANGE_MS,
  MANUAL_BPM_RANGE,
  NUDGE_MS,
  PHRASE_BAR_OPTIONS,
  isValidTempoRange,
  type PhraseBars,
} from '@shared/beat'
import type { AudioEngineState } from '@shared/audio'
import type { BeatLink } from './useBeat'

const FLASH_MS = 120

/**
 * Local copy of a value owned by the output: changes show immediately, and the copy re-syncs
 * whenever the output reports a new value.
 */
function useMirrored<T>(remote: T): [T, (v: T) => void] {
  const [local, setLocal] = useState(remote)
  const [seen, setSeen] = useState(remote)
  if (!Object.is(remote, seen)) {
    setSeen(remote)
    setLocal(remote)
  }
  return [local, setLocal]
}

/** Four beat lights flashed by beat events (no React renders per beat). */
function BeatLights({ beat }: { beat: BeatLink }) {
  const lights = useRef<(HTMLDivElement | null)[]>([])
  const { onBeat } = beat
  useEffect(() => {
    let timer = 0
    return onBeat((e) => {
      lights.current.forEach((el, i) => {
        if (!el) return
        el.classList.toggle('on', i === e.beatInBar - 1)
        el.classList.toggle('current', i === e.beatInBar - 1)
      })
      const root = lights.current[0]?.parentElement
      if (root) root.dataset.beat = String(e.beatInBar)
      clearTimeout(timer)
      timer = window.setTimeout(
        () => lights.current.forEach((el) => el?.classList.remove('on')),
        FLASH_MS,
      )
    })
  }, [onBeat])

  return (
    <div className="beat-lights" data-testid="beat-lights">
      {Array.from({ length: BEATS_PER_BAR }, (_, i) => (
        <div
          key={i}
          className={`beat-light${i === 0 ? ' downbeat' : ''}`}
          ref={(el) => {
            lights.current[i] = el
          }}
        />
      ))}
    </div>
  )
}

function BpmEntry({ beat }: { beat: BeatLink }) {
  const [text, setText] = useState('')
  const submit = () => {
    const bpm = Number(text)
    if (Number.isFinite(bpm) && bpm >= MANUAL_BPM_RANGE[0] && bpm <= MANUAL_BPM_RANGE[1]) {
      beat.command({ type: 'setBpm', bpm })
      setText('')
    }
  }
  return (
    <input
      className="bpm-entry"
      type="number"
      inputMode="decimal"
      placeholder="Type BPM"
      aria-label="Type BPM"
      min={MANUAL_BPM_RANGE[0]}
      max={MANUAL_BPM_RANGE[1]}
      step={0.1}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') setText('')
      }}
      onBlur={submit}
    />
  )
}

/** Bring the audio input picker into view and focus it. */
function goToAudioInput(): void {
  const panel = document.getElementById('audio-panel')
  panel?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  panel?.querySelector<HTMLSelectElement>('select')?.focus({ preventScroll: true })
}

export function BeatPanel({ beat, audioState }: { beat: BeatLink; audioState: AudioEngineState }) {
  const s = beat.state
  const settings = s?.settings
  const locked = settings?.tempoMode === 'locked'
  const [phaseCorrection, setPhaseCorrection] = useMirrored(settings?.phaseCorrection ?? true)
  const [latency, setLatency] = useMirrored(settings?.latencyOffsetMs ?? 0)
  const [phraseBars, setPhraseBars] = useMirrored<number>(settings?.phraseBars ?? 8)
  const [rangeMin, setRangeMin] = useState<string | null>(null)
  const [rangeMax, setRangeMax] = useState<string | null>(null)

  const commitRange = () => {
    if (!settings) return
    const min = Number(rangeMin ?? settings.minBpm)
    const max = Number(rangeMax ?? settings.maxBpm)
    if (isValidTempoRange(min, max))
      beat.command({ type: 'setTempoRange', minBpm: min, maxBpm: max })
    setRangeMin(null)
    setRangeMax(null)
  }

  return (
    <section className="panel beat-panel">
      <div className="tempo-header">
        <div className="bpm-readout">
          <span className="bpm-value" data-testid="bpm-value">
            {s ? s.bpm.toFixed(1) : '---.-'}
          </span>
          <span className="bpm-unit">BPM</span>
        </div>
        <div className="tempo-meta">
          <span className={`mode-badge ${locked ? 'locked' : 'auto'}`} data-testid="tempo-mode">
            {locked ? 'LOCKED' : 'AUTO'}
          </span>
          {audioState === 'running' ? (
            <span className="detected" data-testid="detected-bpm">
              {s?.detectedBpm != null ? `detected ${s.detectedBpm.toFixed(1)}` : 'listening…'}
            </span>
          ) : (
            <button
              className="link no-audio"
              data-testid="no-audio"
              title="Beat detection needs an audio input"
              onClick={goToAudioInput}
            >
              {audioState === 'starting'
                ? 'Starting audio…'
                : audioState === 'error'
                  ? 'Audio error: check input'
                  : 'No audio input: choose one'}
            </button>
          )}
          <div className="confidence" title="How sure the detector is about the tempo">
            <div
              className="confidence-fill"
              style={{ width: `${Math.round((s?.confidence ?? 0) * 100)}%` }}
            />
          </div>
        </div>
      </div>

      <div className="beat-row">
        <BeatLights beat={beat} />
        <div className="bar-counter" data-testid="bar-counter">
          {s ? (
            <>
              Bar {s.barIndex + 1} · Phrase {s.phraseIndex + 1}{' '}
              <span className="muted">
                ({s.barInPhrase}/{s.settings.phraseBars})
              </span>
            </>
          ) : (
            '—'
          )}
        </div>
        <span className={`phase-state ${s?.inPhase ? 'ok' : ''}`} data-testid="phase-state">
          {s?.inPhase ? 'in phase' : 'searching'}
        </span>
      </div>

      <div className="tempo-buttons">
        <button
          className="tap"
          data-testid="tap-button"
          onClick={() => beat.command({ type: 'tap' })}
        >
          TAP{s && s.taps > 0 ? ` ${s.taps}` : ''}
        </button>
        <button
          data-testid="resync-button"
          title="Mark now as beat 1 of the bar (Enter)"
          onClick={() => beat.command({ type: 'resyncDownbeat' })}
        >
          Beat 1
        </button>
        <button
          aria-label="Nudge earlier"
          title="Move the beat grid earlier (←)"
          onClick={() => beat.command({ type: 'nudge', ms: -NUDGE_MS })}
        >
          −{NUDGE_MS} ms
        </button>
        <button
          aria-label="Nudge later"
          title="Move the beat grid later (→)"
          onClick={() => beat.command({ type: 'nudge', ms: NUDGE_MS })}
        >
          +{NUDGE_MS} ms
        </button>
        <button
          aria-label="Halve tempo"
          onClick={() => beat.command({ type: 'multiply', factor: 0.5 })}
        >
          ÷2
        </button>
        <button
          aria-label="Double tempo"
          onClick={() => beat.command({ type: 'multiply', factor: 2 })}
        >
          ×2
        </button>
      </div>
      <div className="row tempo-row2">
        <button
          data-testid="lock-toggle"
          className={locked ? 'on' : ''}
          onClick={() => beat.command({ type: locked ? 'auto' : 'lock' })}
          title={locked ? 'Follow the detected tempo again' : 'Freeze the current tempo'}
        >
          {locked ? 'Unlock (Auto)' : 'Lock tempo'}
        </button>
        <BpmEntry beat={beat} />
      </div>
      <p className="hint">Space tap · Enter marks beat 1 · ←/→ nudge {NUDGE_MS} ms</p>

      {settings && (
        <details className="beat-settings">
          <summary>Clock settings</summary>
          <label className="field check">
            <input
              type="checkbox"
              aria-label="Phase correction"
              checked={phaseCorrection}
              onChange={(e) => {
                setPhaseCorrection(e.target.checked)
                beat.command({ type: 'setPhaseCorrection', enabled: e.target.checked })
              }}
            />
            Phase correction (follow the kicks)
          </label>
          <label className="field">
            <span className="label">Latency offset</span>
            <input
              type="range"
              aria-label="Latency offset"
              min={LATENCY_OFFSET_RANGE_MS[0]}
              max={LATENCY_OFFSET_RANGE_MS[1]}
              step={5}
              value={latency}
              onChange={(e) => {
                setLatency(Number(e.target.value))
                beat.command({ type: 'setLatencyOffset', ms: Number(e.target.value) })
              }}
            />
            <code className="slider-value">
              {latency > 0 ? '+' : ''}
              {latency} ms
            </code>
          </label>
          <p className="hint">
            Positive = visuals earlier. Raise it if flashes land after the kick you hear.
          </p>
          <label className="field">
            <span className="label">Phrase length</span>
            <select
              aria-label="Phrase length"
              value={phraseBars}
              onChange={(e) => {
                setPhraseBars(Number(e.target.value))
                beat.command({ type: 'setPhraseBars', bars: Number(e.target.value) as PhraseBars })
              }}
            >
              {PHRASE_BAR_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} bars
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span className="label">Tempo range</span>
            <input
              className="range-input"
              type="number"
              aria-label="Minimum BPM"
              value={rangeMin ?? settings.minBpm}
              onChange={(e) => setRangeMin(e.target.value)}
              onBlur={commitRange}
              onKeyDown={(e) => e.key === 'Enter' && commitRange()}
            />
            <span>–</span>
            <input
              className="range-input"
              type="number"
              aria-label="Maximum BPM"
              value={rangeMax ?? settings.maxBpm}
              onChange={(e) => setRangeMax(e.target.value)}
              onBlur={commitRange}
              onKeyDown={(e) => e.key === 'Enter' && commitRange()}
            />
            <span className="hint">BPM (≥ 1 octave)</span>
          </div>
        </details>
      )}
    </section>
  )
}
