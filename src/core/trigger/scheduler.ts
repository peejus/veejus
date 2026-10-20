import { BEATS_PER_BAR } from '@shared/beat'
import { LAYER_IDS, type LayerId } from '@shared/layers'
import {
  DEFAULT_TRIGGER_SETTINGS,
  type DropStatus,
  type PadRuntime,
  type PadSource,
  type PadSpec,
  type Quantize,
  type TriggerSettings,
  type TriggerState,
} from '@shared/pads'
import type { GridUnit } from '../beat/beatClock'
import { pickRandom } from './randomPick'

/**
 * Beat-quantized pad triggering, in beat positions of the visual timeline.
 *
 * Presses, releases and arms come in from the UI; every rendered frame `update()` returns the
 * actions due on that frame (start / restart / stop). An action fires on the frame nearest its
 * boundary. Each layer shows one pad at a time: starting a pad replaces whatever pad was on
 * its layer, and leaves the other layers alone.
 */

/** The parts of the beat clock the scheduler needs. */
export interface ClockView {
  position(nowMs: number): number
  boundaryAfter(pos: number, unit: GridUnit): number
  boundaryAtOrBefore(pos: number, unit: GridUnit): number
  readonly beatsPerMs: number
}

export interface ClipSource {
  /** Clip ids a source can play right now (existence and errors already filtered out). */
  candidates(source: PadSource): string[]
  /** Start loading a clip so it is ready when its boundary arrives. */
  prepare(clipId: string): void
}

export type TriggerAction =
  | {
      type: 'start'
      layer: LayerId
      padId: string
      clipId: string
      spec: PadSpec
      startPos: number
    }
  | { type: 'restart'; layer: LayerId; padId: string }
  | { type: 'stop'; layer: LayerId; padId: string }

/** A press this soon after a boundary still counts for that boundary (human timing). */
export const GRACE_MS = 80

interface Pending {
  kind: 'start' | 'stop'
  spec: PadSpec
  clipId: string | null
  firePos: number
}

/** What a layer is showing for a pad. */
export interface Voice {
  padId: string
  spec: PadSpec
  clipId: string
  startPos: number
  /** When the voice ends (beats mode, or a stop with fade-out). */
  endPos: number | null
  /** Fade-out runs from here to endPos. */
  fadeFromPos: number | null
  nextRetriggerPos: number | null
}

const unitFor = (q: Exclude<Quantize, 'off'>): GridUnit => q

export class TriggerScheduler {
  settings: TriggerSettings = { ...DEFAULT_TRIGGER_SETTINGS }
  private readonly pending = new Map<string, Pending>()
  private readonly armed = new Map<string, { spec: PadSpec; clipId: string | null }>()
  private dropPos: number | null = null
  private readonly voices = new Map<LayerId, Voice>()
  private readonly lastPick = new Map<string, string>()
  /** Bumped on every state change, so the UI can be told. */
  version = 0

  constructor(
    private readonly clips: ClipSource,
    private readonly rand: () => number = Math.random,
  ) {}

  /** The pad voice on a layer, if any. */
  voiceOn(layer: LayerId): Readonly<Voice> | null {
    return this.voices.get(layer) ?? null
  }

  private voiceOf(padId: string): [LayerId, Voice] | null {
    for (const [layer, v] of this.voices) if (v.padId === padId) return [layer, v]
    return null
  }

  private changed(): void {
    this.version++
  }

  /** Beat position this press should fire at (`pos` = now if due immediately). */
  private firePosition(pos: number, quantize: Quantize, clock: ClockView): number {
    if (quantize === 'off') return pos
    const unit = unitFor(quantize)
    const graceBeats = GRACE_MS * clock.beatsPerMs
    const last = clock.boundaryAtOrBefore(pos, unit)
    if (pos - last <= graceBeats) return pos
    return clock.boundaryAfter(pos, unit)
  }

  private choose(padId: string, source: PadSource): string | null {
    const clipId = pickRandom(
      this.clips.candidates(source),
      this.lastPick.get(padId) ?? null,
      this.rand,
    )
    if (clipId) {
      this.lastPick.set(padId, clipId)
      this.clips.prepare(clipId)
    }
    return clipId
  }

  press(padId: string, spec: PadSpec, nowMs: number, clock: ClockView): void {
    const pos = clock.position(nowMs)
    const firePos = this.firePosition(pos, spec.quantize, clock)
    const queued = this.pending.get(padId)
    const active = this.voiceOf(padId)?.[1] ?? null
    const latches = spec.mode === 'toggle' || spec.mode === 'retrigger'

    if (spec.mode === 'hold' && (active || queued)) return // key repeat

    if (queued) {
      if (queued.kind === 'stop') {
        this.pending.delete(padId) // pressed again before the stop: keep playing
        this.changed()
      } else if (latches) {
        this.pending.delete(padId) // pressed again before it started: cancel
        this.changed()
      }
      return
    }
    if (active && latches && active.endPos === null) {
      this.pending.set(padId, { kind: 'stop', spec, clipId: active.clipId, firePos })
      this.changed()
      return
    }
    const clipId = this.choose(padId, spec.source)
    if (!clipId) return
    this.pending.set(padId, { kind: 'start', spec, clipId, firePos })
    this.changed()
  }

  release(padId: string, nowMs: number, clock: ClockView): void {
    const queued = this.pending.get(padId)
    if (queued?.kind === 'start' && queued.spec.mode === 'hold') {
      this.pending.delete(padId)
      this.changed()
      return
    }
    const found = this.voiceOf(padId)
    if (found && found[1].spec.mode === 'hold') this.beginStop(found[1], clock.position(nowMs))
  }

  /** Arm a pad for the drop; arming an armed pad disarms it. */
  arm(padId: string, spec: PadSpec, nowMs: number, clock: ClockView): void {
    if (this.armed.delete(padId)) {
      if (this.armed.size === 0) this.dropPos = null
      this.changed()
      return
    }
    const clipId = this.choose(padId, spec.source)
    if (!clipId) return
    this.armed.set(padId, { spec, clipId })
    if (this.dropPos === null) {
      const pos = clock.position(nowMs) + 1e-6
      const drop = this.settings.drop
      this.dropPos =
        drop.kind === 'phrase'
          ? clock.boundaryAfter(pos, 'phrase')
          : clock.boundaryAfter(pos, 'bar') + (drop.bars - 1) * BEATS_PER_BAR
    }
    this.changed()
  }

  /** Stop everything now and cancel the drop. Returns stop actions for the showing pads. */
  stopAll(): TriggerAction[] {
    const actions: TriggerAction[] = []
    for (const [layer, v] of this.voices) actions.push({ type: 'stop', layer, padId: v.padId })
    this.voices.clear()
    this.pending.clear()
    this.armed.clear()
    this.dropPos = null
    this.changed()
    return actions
  }

  /** Stop the pad on one layer now. */
  stopLayer(layer: LayerId): TriggerAction[] {
    const v = this.voices.get(layer)
    if (!v) return []
    this.voices.delete(layer)
    this.pending.delete(v.padId)
    this.changed()
    return [{ type: 'stop', layer, padId: v.padId }]
  }

  /** A layer finished a one-shot clip by itself. */
  onClipEnded(padId: string): void {
    const found = this.voiceOf(padId)
    if (found) {
      this.voices.delete(found[0])
      this.changed()
    }
  }

  /** Something outside the scheduler (a library preview) took over a layer. */
  onLayerTakenOver(layer: LayerId): void {
    if (this.voices.delete(layer)) this.changed()
  }

  private beginStop(v: Voice, pos: number): void {
    v.fadeFromPos = pos
    v.endPos = pos + v.spec.fadeOutBeats
    v.nextRetriggerPos = null
    this.changed()
  }

  /** Actions due on the frame at `nowMs`. Call once per rendered frame. */
  update(nowMs: number, frameMs: number, clock: ClockView): TriggerAction[] {
    const pos = clock.position(nowMs)
    // Fire on the frame nearest the target: up to half a frame early.
    const due = (target: number) => pos >= target - (clock.beatsPerMs * frameMs) / 2
    const actions: TriggerAction[] = []

    const start = (padId: string, spec: PadSpec, clipId: string, startPos: number) => {
      // A pad moving layers leaves its old one.
      const previous = this.voiceOf(padId)
      if (previous && previous[0] !== spec.layer) {
        this.voices.delete(previous[0])
        actions.push({ type: 'stop', layer: previous[0], padId })
      }
      const v: Voice = {
        padId,
        spec,
        clipId,
        startPos,
        endPos: spec.mode === 'beats' ? startPos + spec.lengthBeats : null,
        fadeFromPos: null,
        nextRetriggerPos:
          spec.mode === 'retrigger'
            ? clock.boundaryAfter(startPos + 1e-6, spec.retriggerEvery)
            : null,
      }
      if (v.endPos !== null && spec.fadeOutBeats > 0) {
        v.fadeFromPos = Math.max(startPos, v.endPos - spec.fadeOutBeats)
      }
      this.voices.set(spec.layer, v)
      actions.push({ type: 'start', layer: spec.layer, padId, clipId, spec, startPos })
      this.changed()
    }

    // The drop: every armed pad fires together, each on its own layer.
    if (this.dropPos !== null && due(this.dropPos)) {
      const at = this.dropPos
      for (const [padId, a] of this.armed) {
        if (a.clipId) {
          this.pending.delete(padId)
          start(padId, a.spec, a.clipId, at)
        }
      }
      this.armed.clear()
      this.dropPos = null
      this.changed()
    }

    for (const [padId, p] of [...this.pending]) {
      if (!due(p.firePos)) continue
      this.pending.delete(padId)
      if (p.kind === 'start' && p.clipId) start(padId, p.spec, p.clipId, Math.max(p.firePos, pos))
      else if (p.kind === 'stop') {
        const found = this.voiceOf(padId)
        if (found) this.beginStop(found[1], pos)
      }
      this.changed()
    }

    for (const layer of LAYER_IDS) {
      const v = this.voices.get(layer)
      if (!v) continue
      if (v.endPos !== null && due(v.endPos)) {
        actions.push({ type: 'stop', layer, padId: v.padId })
        this.voices.delete(layer)
        this.changed()
      } else if (v.nextRetriggerPos !== null && due(v.nextRetriggerPos)) {
        actions.push({ type: 'restart', layer, padId: v.padId })
        v.nextRetriggerPos = clock.boundaryAfter(v.nextRetriggerPos + 1e-6, v.spec.retriggerEvery)
      }
    }
    return actions
  }

  /** Opacity of the pad on `layer` at `nowMs` (fades in and out in beats); 1 if none. */
  opacity(layer: LayerId, nowMs: number, clock: ClockView): number {
    const v = this.voices.get(layer)
    if (!v) return 1
    const pos = clock.position(nowMs)
    let a = 1
    if (v.spec.fadeInBeats > 0)
      a *= Math.min(1, Math.max(0, (pos - v.startPos) / v.spec.fadeInBeats))
    if (v.fadeFromPos !== null && v.endPos !== null && v.endPos > v.fadeFromPos) {
      a *= Math.min(1, Math.max(0, (v.endPos - pos) / (v.endPos - v.fadeFromPos)))
    }
    return a
  }

  state(nowMs: number, clock: ClockView): TriggerState {
    const pads: Record<string, PadRuntime> = {}
    for (const [padId, p] of this.pending) {
      if (p.kind === 'start')
        pads[padId] = { state: 'queued', clipId: p.clipId, layer: p.spec.layer }
    }
    for (const [padId, a] of this.armed)
      pads[padId] = { state: 'armed', clipId: a.clipId, layer: a.spec.layer }
    for (const [layer, v] of this.voices) {
      const stopping = v.fadeFromPos !== null && v.spec.mode !== 'beats'
      const stopQueued = this.pending.get(v.padId)?.kind === 'stop'
      pads[v.padId] = {
        state: stopping || stopQueued ? 'stopping' : 'playing',
        clipId: v.clipId,
        layer,
      }
    }
    let drop: DropStatus | null = null
    if (this.dropPos !== null) {
      const beatsRemaining = Math.max(0, this.dropPos - clock.position(nowMs))
      drop = {
        padIds: [...this.armed.keys()],
        beatsRemaining,
        barsRemaining: Math.ceil(beatsRemaining / BEATS_PER_BAR - 1e-9),
      }
    }
    return { pads, drop, settings: { ...this.settings } }
  }
}
