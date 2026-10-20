import { useEffect, useRef } from 'react'
import {
  BLEND_MODES,
  LAYER_IDS,
  LAYER_NAMES,
  TAKEOVER_MODES,
  type BlendMode,
  type TakeoverMode,
} from '@shared/layers'
import type { ClipInfo } from '@shared/protocol'
import type { LayersLink } from './useLayers'

const TAKEOVER_LABELS: Record<TakeoverMode, string> = {
  none: 'Keep playing',
  dim: 'Dim',
  pause: 'Pause',
  hide: 'Hide',
}

/** Live mirror of the output, drawn from preview frames without React renders. */
export function PreviewMonitor({ layers }: { layers: LayersLink }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const { onPreview } = layers
  useEffect(
    () =>
      onPreview((f) => {
        const c = canvas.current
        if (!c) return
        if (c.width !== f.width || c.height !== f.height) {
          c.width = f.width
          c.height = f.height
        }
        const ctx = c.getContext('2d')
        if (!ctx) return
        const data = new Uint8ClampedArray(f.pixels.length)
        data.set(f.pixels)
        ctx.putImageData(new ImageData(data, f.width, f.height), 0, 0)
      }),
    [onPreview],
  )
  return (
    <section className="panel preview-panel">
      <div className="preview-header">
        <h2>Output preview</h2>
        {layers.master.blackout && <span className="blackout-badge">BLACKOUT</span>}
        <label className="check">
          <input
            type="checkbox"
            aria-label="Show preview"
            checked={layers.previewEnabled}
            onChange={(e) => layers.setPreviewEnabled(e.target.checked)}
          />
          Live
        </label>
      </div>
      {/* Frames arrive bottom-up (GL order); the CSS flip puts them right way up. */}
      <canvas
        ref={canvas}
        className={`preview-canvas${layers.previewEnabled ? '' : ' off'}`}
        width={320}
        height={180}
        data-testid="preview-canvas"
      />
    </section>
  )
}

export function LayersPanel({ layers, clips }: { layers: LayersLink; clips: ClipInfo[] }) {
  const names = new Map(clips.map((c) => [c.id, c.name]))
  const { config, master } = layers
  return (
    <section className="panel layers-panel">
      <h2>Layers</h2>
      {/* Top layer first, like a mixing desk. */}
      {[...LAYER_IDS].reverse().map((id) => {
        const cfg = config.layers[id]
        const show = layers.showing[id]
        return (
          <div
            className={`layer-row${cfg.muted ? ' muted' : ''}`}
            key={id}
            data-testid={`layer-${id}`}
          >
            <div className="layer-top">
              <span className="layer-name">{LAYER_NAMES[id]}</span>
              <span className="layer-clip" data-testid={`layer-${id}-clip`}>
                {show.clipId
                  ? `${names.get(show.clipId) ?? '?'}${show.padId ? ` · ${show.padId}` : ''}`
                  : '—'}
              </span>
              <button
                className={`ms${cfg.muted ? ' on' : ''}`}
                aria-label={`Mute ${LAYER_NAMES[id]}`}
                aria-pressed={cfg.muted}
                onClick={() => layers.setLayer(id, { muted: !cfg.muted })}
              >
                M
              </button>
              <button
                className={`ms solo${cfg.solo ? ' on' : ''}`}
                aria-label={`Solo ${LAYER_NAMES[id]}`}
                aria-pressed={cfg.solo}
                onClick={() => layers.setLayer(id, { solo: !cfg.solo })}
              >
                S
              </button>
              <button
                className="ms"
                aria-label={`Stop ${LAYER_NAMES[id]}`}
                disabled={!show.clipId}
                onClick={() => layers.stopLayer(id)}
              >
                ■
              </button>
            </div>
            <div className="layer-controls">
              <input
                type="range"
                aria-label={`${LAYER_NAMES[id]} opacity`}
                min={0}
                max={1}
                step={0.01}
                value={cfg.opacity}
                onChange={(e) => layers.setLayer(id, { opacity: Number(e.target.value) })}
              />
              <code className="slider-value">{Math.round(cfg.opacity * 100)}%</code>
              <select
                aria-label={`${LAYER_NAMES[id]} blend`}
                value={cfg.blend}
                onChange={(e) => layers.setLayer(id, { blend: e.target.value as BlendMode })}
              >
                {BLEND_MODES.map((b) => (
                  <option key={b} value={b}>
                    {b[0]!.toUpperCase() + b.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )
      })}

      <div className="field">
        <span className="label">Under takeover</span>
        <select
          aria-label="Takeover behavior"
          value={config.takeoverMode}
          onChange={(e) => layers.setTakeover({ takeoverMode: e.target.value as TakeoverMode })}
        >
          {TAKEOVER_MODES.map((m) => (
            <option key={m} value={m}>
              {TAKEOVER_LABELS[m]}
            </option>
          ))}
        </select>
        {config.takeoverMode === 'dim' && (
          <input
            type="range"
            aria-label="Takeover dim amount"
            min={0}
            max={1}
            step={0.05}
            value={config.takeoverDim}
            onChange={(e) => layers.setTakeover({ takeoverDim: Number(e.target.value) })}
          />
        )}
      </div>

      <h3>Master</h3>
      <label className="field">
        <span className="label">Brightness</span>
        <input
          type="range"
          aria-label="Master brightness"
          min={0}
          max={1}
          step={0.01}
          value={master.brightness}
          onChange={(e) => layers.setMaster({ brightness: Number(e.target.value) })}
        />
        <code className="slider-value">{Math.round(master.brightness * 100)}%</code>
      </label>
      <button
        className={`blackout${master.blackout ? ' on' : ''}`}
        aria-pressed={master.blackout}
        data-testid="blackout"
        title="Blackout (` key)"
        onClick={() => layers.setMaster({ blackout: !master.blackout })}
      >
        {master.blackout ? 'BLACKOUT ON' : 'Blackout'}
      </button>
    </section>
  )
}
