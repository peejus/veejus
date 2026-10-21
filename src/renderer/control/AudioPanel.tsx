import { useEffect, useRef } from 'react'
import {
  BAND_NAMES,
  INPUT_GAIN_RANGE_DB,
  type AnalysisSettings,
  type AudioSource,
  type OnsetBand,
} from '@shared/audio'
import type { AudioLink } from './useAudio'

const TEST_BPM = 120
const FLASH_MS = 110

/** Select-box value for a source. */
function sourceKey(source: AudioSource | null): string {
  if (!source) return 'off'
  switch (source.kind) {
    case 'test':
      return 'test'
    case 'loopback':
      return 'loopback'
    case 'device':
      return `device:${source.deviceId}`
  }
}

function sourceFromKey(key: string): AudioSource | null {
  if (key === 'off') return null
  if (key === 'test') return { kind: 'test', bpm: TEST_BPM }
  if (key === 'loopback') return { kind: 'loopback' }
  return { kind: 'device', deviceId: key.slice('device:'.length) }
}

const STATE_TEXT = { off: 'Off', starting: 'Starting…', running: 'Running', error: 'Error' }

/** Level meter, band bars and spectrum, drawn from the latest meter snapshot every frame. */
function Meters({ audio }: { audio: AudioLink }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const level = useRef<HTMLDivElement>(null)
  const peak = useRef<HTMLDivElement>(null)
  const clip = useRef<HTMLSpanElement>(null)
  const bars = useRef<(HTMLDivElement | null)[]>([])
  const latency = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let raf = 0
    const smooth = new Float32Array(64)
    let clipUntil = 0
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const m = audio.meters.current
      const toDb = (v: number) => (v > 0 ? 20 * Math.log10(v) : -120)
      const dbToPct = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100))

      if (level.current && peak.current) {
        level.current.style.width = `${100 - (m ? dbToPct(toDb(m.rms) + 3) : 0)}%`
        peak.current.style.left = `${m ? dbToPct(toDb(m.peak)) : 0}%`
      }
      if (m?.clipped) clipUntil = now + 1000
      clip.current?.classList.toggle('on', now < clipUntil)
      for (let i = 0; i < bars.current.length; i++) {
        const el = bars.current[i]
        if (!el) continue
        const v = m?.bands[i] ?? 0
        el.style.height = `${(v * 100).toFixed(1)}%`
        el.dataset.level = v.toFixed(3)
      }
      if (latency.current) latency.current.textContent = m ? `~${m.latencyMs.toFixed(0)} ms` : '--'

      const c = canvas.current
      const ctx = c?.getContext('2d')
      if (!c || !ctx) return
      const w = c.width
      const h = c.height
      ctx.clearRect(0, 0, w, h)
      const spec = m?.spectrum
      const n = smooth.length
      const bw = w / n
      for (let i = 0; i < n; i++) {
        const target = spec?.[i] ?? 0
        // Fast rise, slow fall, so the display is readable.
        smooth[i] = target > smooth[i]! ? target : smooth[i]! * 0.85 + target * 0.15
        const bh = smooth[i]! * h
        ctx.fillStyle = `hsl(${300 - (i / n) * 120}, 90%, 60%)`
        ctx.fillRect(i * bw + 1, h - bh, bw - 2, bh)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [audio.meters])

  return (
    <div className="meters">
      <div className="level-row">
        <span className="label">Level</span>
        <div className="level-meter" data-testid="level-meter">
          <div className="level-cover" ref={level} />
          <div className="level-peak" ref={peak} />
        </div>
        <span className="clip" ref={clip} title="Clipping: lower the input gain">
          CLIP
        </span>
      </div>
      <div className="bands-and-spectrum">
        <div className="bands">
          {BAND_NAMES.map((name, i) => (
            <div className="band" key={name}>
              <div className="band-track">
                <div
                  className="band-fill"
                  data-testid={`band-${i}`}
                  ref={(el) => {
                    bars.current[i] = el
                  }}
                />
              </div>
              <span className="band-name">{name}</span>
            </div>
          ))}
        </div>
        <canvas className="spectrum" ref={canvas} width={256} height={96} data-testid="spectrum" />
      </div>
      <p className="hint">
        Analysis latency <span ref={latency}>--</span> (plus your audio interface's input latency)
      </p>
    </div>
  )
}

/** Flashes on each onset and counts them. Updated directly, without React renders. */
function OnsetBlinkers({ audio }: { audio: AudioLink }) {
  const lamps = useRef<Record<OnsetBand, HTMLDivElement | null>>({ low: null, high: null })
  const counts = useRef<Record<OnsetBand, HTMLSpanElement | null>>({ low: null, high: null })

  const { onOnset } = audio
  useEffect(() => {
    const n: Record<OnsetBand, number> = { low: 0, high: 0 }
    const timers: Record<OnsetBand, number> = { low: 0, high: 0 }
    return onOnset((band) => {
      n[band]++
      const lamp = lamps.current[band]
      const count = counts.current[band]
      if (count) count.textContent = String(n[band])
      if (!lamp) return
      lamp.classList.add('flash')
      clearTimeout(timers[band])
      timers[band] = window.setTimeout(() => lamp.classList.remove('flash'), FLASH_MS)
    })
  }, [onOnset])

  return (
    <div className="blinkers">
      {(
        [
          ['low', 'Kick'],
          ['high', 'Snare / hat'],
        ] as const
      ).map(([band, name]) => (
        <div className={`blinker ${band}`} key={band}>
          <div
            className="lamp"
            ref={(el) => {
              lamps.current[band] = el
            }}
          />
          <span>{name}</span>
          <span
            className="count"
            data-testid={band === 'low' ? 'kick-count' : 'high-count'}
            ref={(el) => {
              counts.current[band] = el
            }}
          >
            0
          </span>
        </div>
      ))}
    </div>
  )
}

function Slider(props: {
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

function AnalysisSettingsEditor({ audio }: { audio: AudioLink }) {
  const s = audio.settings
  const set = (patch: Partial<AnalysisSettings>) => audio.setSettings({ ...s, ...patch })
  const setCrossover = (i: number, hz: number) => {
    const next = [...s.crossoversHz] as AnalysisSettings['crossoversHz']
    next[i] = hz
    if (next[0] > 20 && next[0] < next[1] && next[1] < next[2] && next[2] < 20000) {
      set({ crossoversHz: next })
    }
  }
  const pct = (v: number) => `${Math.round(v * 100)}%`
  return (
    <details className="analysis-settings">
      <summary>Analysis settings</summary>
      <Slider
        label="Kick sensitivity"
        min={0}
        max={1}
        step={0.05}
        value={s.kickSensitivity}
        format={pct}
        onChange={(v) => set({ kickSensitivity: v })}
      />
      <Slider
        label="Snare/hat sensitivity"
        min={0}
        max={1}
        step={0.05}
        value={s.highSensitivity}
        format={pct}
        onChange={(v) => set({ highSensitivity: v })}
      />
      <Slider
        label="Attack"
        min={0}
        max={100}
        step={1}
        value={s.attackMs}
        format={(v) => `${v} ms`}
        onChange={(v) => set({ attackMs: v })}
      />
      <Slider
        label="Release"
        min={10}
        max={1000}
        step={10}
        value={s.releaseMs}
        format={(v) => `${v} ms`}
        onChange={(v) => set({ releaseMs: v })}
      />
      <div className="field crossovers">
        <span className="label">Crossovers</span>
        {s.crossoversHz.map((hz, i) => (
          // Uncontrolled, committed on blur/Enter, so half-typed values aren't rejected mid-edit.
          <input
            key={`${i}-${hz}`}
            type="number"
            aria-label={`Crossover ${i + 1} (Hz)`}
            min={21}
            max={19999}
            defaultValue={hz}
            onBlur={(e) => {
              setCrossover(i, Number(e.target.value))
              e.target.value = String(s.crossoversHz[i])
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
        ))}
        <span className="hint">Hz</span>
      </div>
      {BAND_NAMES.map((name, i) => (
        <Slider
          key={name}
          label={`${name} gain`}
          min={-12}
          max={12}
          step={1}
          value={s.bandGainsDb[i]!}
          format={(v) => `${v > 0 ? '+' : ''}${v} dB`}
          onChange={(v) => {
            const g = [...s.bandGainsDb] as AnalysisSettings['bandGainsDb']
            g[i] = v
            set({ bandGainsDb: g })
          }}
        />
      ))}
    </details>
  )
}

export function AudioPanel({ audio }: { audio: AudioLink }) {
  const { status, devices } = audio
  const current = sourceKey(status.source)
  return (
    <section className="panel audio-panel" id="audio-panel">
      <h2>Audio input</h2>
      <div className="row">
        <select
          aria-label="Audio source"
          data-testid="audio-source"
          value={current}
          onChange={(e) => audio.setSource(sourceFromKey(e.target.value))}
        >
          <option value="off">Off</option>
          <option value="test">Test beat ({TEST_BPM} BPM, silent)</option>
          <option value="loopback">System audio (what this PC is playing)</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={`device:${d.deviceId}`}>
              {d.label}
            </option>
          ))}
          {status.source?.kind === 'device' &&
            !devices.some((d) => `device:${d.deviceId}` === current) && (
              <option value={current}>{status.label ?? 'Selected device'}</option>
            )}
        </select>
        <button className="subtle" onClick={audio.refreshDevices} title="Refresh device list">
          ↻
        </button>
      </div>
      <p className={`audio-state ${status.state}`} data-testid="audio-state">
        {STATE_TEXT[status.state]}
        {status.state === 'running' && status.label ? ` · ${status.label}` : ''}
        {status.state === 'running' && status.sampleRate
          ? ` · ${status.sampleRate / 1000} kHz`
          : ''}
        {status.error ? ` · ${status.error}` : ''}
      </p>

      <Slider
        label="Input gain"
        min={INPUT_GAIN_RANGE_DB[0]}
        max={INPUT_GAIN_RANGE_DB[1]}
        step={1}
        value={audio.settings.inputGainDb}
        format={(v) => `${v > 0 ? '+' : ''}${v} dB`}
        onChange={(v) => audio.setSettings({ ...audio.settings, inputGainDb: v })}
      />
      <Meters audio={audio} />
      <OnsetBlinkers audio={audio} />
      <AnalysisSettingsEditor audio={audio} />
    </section>
  )
}
