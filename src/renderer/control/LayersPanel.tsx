import { useEffect, useRef, type CSSProperties } from 'react'
import {
  BLEND_MODES,
  LAYER_IDS,
  LAYER_NAMES,
  TAKEOVER_MODES,
  type BlendMode,
  type TakeoverMode,
} from '@shared/layers'
import type { FxScope } from '@shared/fx'
import type { ClipInfo } from '@shared/protocol'
import { chainActive } from './FxPanel'
import { LAYER_COLORS } from './layerColors'
import type { FxLink } from './useFx'
import type { LayersLink } from './useLayers'

const TAKEOVER_LABELS: Record<TakeoverMode, string> = {
  none: 'Others: keep playing',
  dim: 'Others: dim',
  pause: 'Others: pause',
  hide: 'Others: hide',
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

interface MixerProps {
  layers: LayersLink
  fx: FxLink
  clips: ClipInfo[]
  /** Which chain the context panel is showing, if any. */
  fxOpen: FxScope | null
  onFx(scope: FxScope): void
}

/** The live mix: one strip per layer, bottom layer first, then the master. */
export function Mixer({ layers, fx, clips, fxOpen, onFx }: MixerProps) {
  const names = new Map(clips.map((c) => [c.id, c.name]))
  const { config, master } = layers
  const fxButton = (scope: FxScope, label: string) => {
    const active = chainActive(fx.config[scope])
    return (
      <button
        className={`fx-button${fxOpen === scope ? ' on' : ''}`}
        aria-label={`${label} effects`}
        aria-pressed={fxOpen === scope}
        title={`${label} effects${active ? ' (active)' : ''}`}
        onClick={() => onFx(scope)}
      >
        FX{active && <span className="fx-dot" data-testid={`fx-dot-${scope}`} />}
      </button>
    )
  }
  return (
    <section className="panel mixer" aria-label="Mixer">
      {LAYER_IDS.map((id) => {
        const cfg = config.layers[id]
        const show = layers.showing[id]
        const name = LAYER_NAMES[id]
        return (
          <div
            className={`strip${cfg.muted ? ' muted' : ''}`}
            key={id}
            data-testid={`layer-${id}`}
            style={{ '--layer-color': LAYER_COLORS[id] } as CSSProperties}
          >
            <div className="strip-top">
              <span className="strip-name">{name}</span>
              <button
                className={`ms${cfg.muted ? ' on' : ''}`}
                aria-label={`Mute ${name}`}
                aria-pressed={cfg.muted}
                title="Mute"
                onClick={() => layers.setLayer(id, { muted: !cfg.muted })}
              >
                M
              </button>
              <button
                className={`ms solo${cfg.solo ? ' on' : ''}`}
                aria-label={`Solo ${name}`}
                aria-pressed={cfg.solo}
                title="Solo"
                onClick={() => layers.setLayer(id, { solo: !cfg.solo })}
              >
                S
              </button>
              <button
                className="ms"
                aria-label={`Stop ${name}`}
                title="Stop the clip on this layer"
                disabled={!show.clipId}
                onClick={() => layers.stopLayer(id)}
              >
                ■
              </button>
            </div>
            <div
              className="strip-clip"
              data-testid={`layer-${id}-clip`}
              title={show.clipId ? names.get(show.clipId) : undefined}
            >
              {show.clipId
                ? `${names.get(show.clipId) ?? '?'}${show.padId ? ` · ${show.padId}` : ''}`
                : '—'}
            </div>
            <div className="strip-fader">
              <input
                type="range"
                aria-label={`${name} opacity`}
                min={0}
                max={1}
                step={0.01}
                value={cfg.opacity}
                onChange={(e) => layers.setLayer(id, { opacity: Number(e.target.value) })}
              />
              <code className="slider-value">{Math.round(cfg.opacity * 100)}%</code>
            </div>
            <div className="strip-bottom">
              <select
                aria-label={`${name} blend`}
                title="Blend mode"
                value={cfg.blend}
                onChange={(e) => layers.setLayer(id, { blend: e.target.value as BlendMode })}
              >
                {BLEND_MODES.map((b) => (
                  <option key={b} value={b}>
                    {b[0]!.toUpperCase() + b.slice(1)}
                  </option>
                ))}
              </select>
              {fxButton(id, name)}
            </div>
            {id === 'takeover' && (
              <div
                className="strip-takeover"
                title="What the layers below do while Takeover shows a clip"
              >
                <select
                  aria-label="Takeover behavior"
                  value={config.takeoverMode}
                  onChange={(e) =>
                    layers.setTakeover({ takeoverMode: e.target.value as TakeoverMode })
                  }
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
                    title={`Dim the others by ${Math.round(config.takeoverDim * 100)}%`}
                    min={0}
                    max={1}
                    step={0.05}
                    value={config.takeoverDim}
                    onChange={(e) => layers.setTakeover({ takeoverDim: Number(e.target.value) })}
                  />
                )}
              </div>
            )}
          </div>
        )
      })}

      <div className="strip master-strip" data-testid="layer-master">
        <div className="strip-top">
          <span className="strip-name">Master</span>
        </div>
        <div className="strip-fader">
          <input
            type="range"
            aria-label="Master brightness"
            title="Brightness"
            min={0}
            max={1}
            step={0.01}
            value={master.brightness}
            onChange={(e) => layers.setMaster({ brightness: Number(e.target.value) })}
          />
          <code className="slider-value">{Math.round(master.brightness * 100)}%</code>
        </div>
        <div className="strip-bottom">
          <button
            className={`blackout${master.blackout ? ' on' : ''}`}
            aria-pressed={master.blackout}
            data-testid="blackout"
            title="Blackout (backquote key)"
            onClick={() => layers.setMaster({ blackout: !master.blackout })}
          >
            {master.blackout ? 'BLACKOUT ON' : 'Blackout'}
          </button>
          {fxButton('master', 'Master')}
        </div>
      </div>
    </section>
  )
}
