import { useEffect, useRef, useState } from 'react'

/** A modulated value to show as a "ghost" marker on the slider track. */
export interface LiveSource {
  /** Current modulated value, or undefined when the parameter isn't modulated. */
  get(): number | undefined
  subscribe(listener: () => void): () => void
}

export const formatByStep = (v: number, step: number) =>
  step >= 1 ? String(Math.round(v)) : v.toFixed(step >= 0.01 ? 2 : 3)

const FINE = 10
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
/** Thumb width assumed by the ghost marker, so it lines up with the real thumb. */
const THUMB_PX = 16

interface Props {
  /** Accessible name of the slider. */
  aria: string
  min: number
  max: number
  step: number
  value: number
  /** Double-clicking the slider returns here. */
  defaultValue: number
  onChange(v: number): void
  format?: (v: number) => string
  live?: LiveSource
  /** Turn off the shortcut (and its title hint) for type-in, where it makes no sense. */
  typeable?: boolean
  /** MIDI learn target (see useMidi); makes the slider mappable. */
  learn?: string
}

/**
 * A range slider with performer shortcuts: double-click to reset, Shift-drag for fine
 * control (1/10 speed), click the value to type one. With `live`, a ghost marker shows where
 * modulation is taking the value right now.
 */
export function SmartSlider(p: Props) {
  const format = p.format ?? ((v: number) => formatByStep(v, p.step))
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const ghost = useRef<HTMLSpanElement>(null)
  const drag = useRef<{ x: number; v: number; w: number } | null>(null)
  const { live, min, max } = p

  useEffect(() => {
    if (!live) return
    const update = () => {
      const el = ghost.current
      if (!el) return
      const v = live.get()
      el.hidden = v === undefined
      if (v === undefined) return
      const f = (clamp(v, min, max) - min) / (max - min || 1)
      el.style.left = `calc(${THUMB_PX / 2}px + (100% - ${THUMB_PX}px) * ${f})`
      el.dataset.value = String(v)
    }
    update()
    return live.subscribe(update)
  }, [live, min, max])

  const commit = () => {
    const v = Number(text)
    if (text.trim() !== '' && Number.isFinite(v)) p.onChange(clamp(v, p.min, p.max))
    setEditing(false)
  }

  const fineStep = p.step / FINE
  return (
    <div className="smart-slider" data-learn={p.learn}>
      <div className="smart-track">
        <input
          type="range"
          aria-label={p.aria}
          min={p.min}
          max={p.max}
          step={p.step}
          value={p.value}
          title="Double-click to reset · Shift-drag to fine-tune"
          onChange={(e) => p.onChange(Number(e.target.value))}
          onDoubleClick={() => p.onChange(p.defaultValue)}
          onPointerDown={(e) => {
            if (!e.shiftKey) return
            // Fine-tune: take over from the native drag and move at 1/10 speed.
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { x: e.clientX, v: p.value, w: e.currentTarget.clientWidth || 1 }
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d) return
            const dv = (((e.clientX - d.x) / d.w) * (p.max - p.min)) / FINE
            const v = Math.round((d.v + dv) / fineStep) * fineStep
            p.onChange(clamp(Number(v.toFixed(6)), p.min, p.max))
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        />
        {live && <span className="ghost-thumb" ref={ghost} hidden aria-hidden="true" />}
      </div>
      {editing ? (
        <input
          className="slider-edit"
          type="number"
          aria-label="Exact value"
          autoFocus
          step={fineStep}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <button
          className="slider-value"
          title={p.typeable === false ? undefined : 'Click to type a value'}
          disabled={p.typeable === false}
          onClick={() => {
            setText(String(Number(p.value.toFixed(4))))
            setEditing(true)
          }}
        >
          {format(p.value)}
        </button>
      )}
    </div>
  )
}
