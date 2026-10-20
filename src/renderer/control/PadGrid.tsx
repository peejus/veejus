import { memo, useEffect, useRef, useState } from 'react'
import {
  BANK_NAMES,
  DROP_BAR_OPTIONS,
  PAD_KEY_LABELS,
  PAD_COLS,
  PLAY_MODE_LABELS,
  QUANTIZE_LABELS,
  QUANTIZES,
  padId,
  type DropTarget,
  type PadConfig,
  type PadRunState,
  type Quantize,
  autoLayer,
} from '@shared/pads'
import type { LayerId } from '@shared/layers'
import type { ClipInfo } from '@shared/protocol'
import type { ProbeResult } from './probe'
import type { BeatLink } from './useBeat'
import type { PadRef, PadsLink } from './usePads'

export const CLIP_DRAG_TYPE = 'application/x-veejus-clip'

const LAYER_SHORT: Record<LayerId, string> = {
  background: 'BG',
  overlayA: 'A',
  overlayB: 'B',
  takeover: 'TK',
}

const MODE_SHORT: Record<PadConfig['mode'], string> = {
  oneShot: '1×',
  beats: 'beats',
  hold: 'hold',
  toggle: 'loop',
  retrigger: 'retrig',
}

function sourceLabel(config: PadConfig, clips: Map<string, ClipInfo>): string {
  const s = config.source
  if (!s) return ''
  if (s.kind === 'clip') return clips.get(s.clipId)?.name ?? '(missing clip)'
  return s.folder ? `Random: ${s.folder.split(/[\\/]/).pop()}` : 'Random: all'
}

interface CellProps {
  pad: PadRef
  config: PadConfig
  keyLabel: string
  label: string
  thumb: string | null
  state: PadRunState
  selected: boolean
  editing: boolean
  pads: PadsLink
}

const PadCell = memo(function PadCell(props: CellProps) {
  const { pad, config, keyLabel, label, thumb, state, selected, editing, pads } = props
  const [dragOver, setDragOver] = useState(false)
  const id = padId(pad.bank, pad.index)
  const empty = !config.source
  return (
    <div
      className={`grid-pad state-${state}${empty ? ' empty' : ''}${selected ? ' selected' : ''}${
        dragOver ? ' drag-over' : ''
      }`}
      data-testid="grid-pad"
      data-pad={id}
      data-state={state}
      role="button"
      aria-label={`Pad ${id}${label ? `: ${label}` : ''}`}
      title={`${id} (key ${keyLabel})${label ? `\n${label}` : ''}\n${PLAY_MODE_LABELS[config.mode]}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        if (editing) pads.select(pad)
        else if (e.shiftKey) pads.arm(pad)
        else {
          pads.press(pad)
          // Release wherever the pointer goes up (matters for 'hold').
          const up = () => {
            pads.release(pad)
            window.removeEventListener('pointerup', up)
          }
          window.addEventListener('pointerup', up)
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        pads.select(pad)
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(CLIP_DRAG_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false)
        const clipId = e.dataTransfer.getData(CLIP_DRAG_TYPE)
        if (!clipId) return
        e.preventDefault()
        pads.assign(pad, { kind: 'clip', clipId })
        pads.select(pad)
      }}
    >
      {thumb && <img src={thumb} alt="" draggable={false} />}
      <span className="pad-key">{keyLabel}</span>
      {!empty && (
        <span className="pad-mode">
          {MODE_SHORT[config.mode]}·
          {LAYER_SHORT[config.layer === 'auto' ? autoLayer(config.mode, false) : config.layer]}
        </span>
      )}
      <span className="pad-label">{label}</span>
    </div>
  )
})

/** Big countdown while pads are armed for the drop. */
function DropBanner({ pads }: { pads: PadsLink }) {
  const drop = pads.runtime?.drop
  if (!drop) return null
  const text =
    drop.beatsRemaining >= 4
      ? `DROP in ${drop.barsRemaining} bar${drop.barsRemaining === 1 ? '' : 's'}`
      : `DROP in ${Math.ceil(drop.beatsRemaining - 1e-6)} beat${Math.ceil(drop.beatsRemaining - 1e-6) === 1 ? '' : 's'}`
  return (
    <div className="drop-banner" data-testid="drop-banner">
      <span className="drop-text">{text}</span>
      <span className="drop-pads">{drop.padIds.join(' + ')}</span>
      <button
        onClick={() => {
          for (const id of drop.padIds) {
            const bank = BANK_NAMES.indexOf(id[0] as (typeof BANK_NAMES)[number])
            pads.arm({ bank, index: Number(id.slice(1)) - 1 })
          }
        }}
      >
        Cancel
      </button>
    </div>
  )
}

interface Props {
  pads: PadsLink
  beat: BeatLink
  clips: ClipInfo[]
  probes: Record<string, ProbeResult>
}

export function PadGrid({ pads, beat, clips, probes }: Props) {
  const [editing, setEditing] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)
  const clipMap = new Map(clips.map((c) => [c.id, c]))
  const { onBeat } = beat

  // Pulse playing pads on every beat.
  useEffect(() => {
    let timer = 0
    return onBeat((e) => {
      const g = gridRef.current
      if (!g) return
      g.classList.add('beat-pulse')
      g.classList.toggle('downbeat', e.beatInBar === 1)
      clearTimeout(timer)
      timer = window.setTimeout(() => g.classList.remove('beat-pulse', 'downbeat'), 110)
    })
  }, [onBeat])

  const s = pads.settings
  const dropValue = s.drop.kind === 'phrase' ? 'phrase' : String(s.drop.bars)
  return (
    <section className="panel pad-panel">
      <div className="pad-header">
        <div className="bank-tabs" role="tablist" aria-label="Pad banks">
          {BANK_NAMES.map((name, i) => (
            <button
              key={name}
              role="tab"
              aria-selected={pads.bank === i}
              className={pads.bank === i ? 'on' : ''}
              data-testid={`bank-${name}`}
              title={`Bank ${name} (F${i + 1})`}
              onClick={() => pads.setBank(i)}
            >
              {name}
            </button>
          ))}
        </div>
        <label className="compact">
          Quantize
          <select
            aria-label="Global quantize"
            value={s.quantize}
            onChange={(e) => pads.setSettings({ ...s, quantize: e.target.value as Quantize })}
          >
            {QUANTIZES.map((q) => (
              <option key={q} value={q}>
                {QUANTIZE_LABELS[q]}
              </option>
            ))}
          </select>
        </label>
        <label className="compact">
          Drop
          <select
            aria-label="Drop timing"
            value={dropValue}
            onChange={(e) => {
              const v = e.target.value
              const drop: DropTarget =
                v === 'phrase'
                  ? { kind: 'phrase' }
                  : { kind: 'bars', bars: Number(v) as (typeof DROP_BAR_OPTIONS)[number] }
              pads.setSettings({ ...s, drop })
            }}
          >
            <option value="phrase">Next phrase</option>
            {DROP_BAR_OPTIONS.map((b) => (
              <option key={b} value={b}>
                In {b} bar{b === 1 ? '' : 's'}
              </option>
            ))}
          </select>
        </label>
        <button
          className={editing ? 'on' : ''}
          aria-pressed={editing}
          data-testid="edit-toggle"
          onClick={() => setEditing(!editing)}
          title="Edit mode: clicking a pad selects it instead of firing it"
        >
          {editing ? 'Done editing' : 'Edit pads'}
        </button>
        <button
          className="subtle"
          title="Put library clips on this bank's empty and existing pads, in order"
          onClick={() =>
            // Skip clips known to be unreadable.
            pads.fillBank(clips.filter((c) => probes[c.id]?.ok !== false).map((c) => c.id))
          }
          disabled={clips.length === 0}
        >
          Auto-fill
        </button>
        <button className="stop-all" onClick={pads.stopAll} title="Stop everything (Esc)">
          Stop all
        </button>
      </div>
      <DropBanner pads={pads} />
      <div
        className={`pad-grid-perf${editing ? ' editing' : ''}`}
        ref={gridRef}
        style={{ gridTemplateColumns: `repeat(${PAD_COLS}, minmax(0, 1fr))` }}
      >
        {pads.banks[pads.bank]!.map((config, index) => {
          const pad = { bank: pads.bank, index }
          const id = padId(pad.bank, index)
          const clipId =
            pads.runtime?.pads[id]?.clipId ??
            (config.source?.kind === 'clip' ? config.source.clipId : null)
          const probe = clipId ? probes[clipId] : undefined
          return (
            <PadCell
              key={id}
              pad={pad}
              config={config}
              keyLabel={PAD_KEY_LABELS[Math.floor(index / PAD_COLS)]![index % PAD_COLS]!}
              label={sourceLabel(config, clipMap)}
              thumb={probe?.ok ? probe.meta.thumbUrl : null}
              state={pads.runtime?.pads[id]?.state ?? 'idle'}
              selected={pads.selected?.bank === pad.bank && pads.selected.index === index}
              editing={editing}
              pads={pads}
            />
          )
        })}
      </div>
      <p className="hint">
        Keys 1-8 / Q-I / A-K / Z-, fire pads · Shift+key or Shift+click arms for the drop · F1-F4
        banks · Esc stops all · drag library clips onto pads · right-click a pad to edit it
      </p>
    </section>
  )
}
