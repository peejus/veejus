import { BEATS_PER_BAR } from '@shared/beat'
import { DEFAULT_KEY, DEFAULT_PLACEMENT, LAYER_IDS, type LayerId } from '@shared/layers'
import {
  AUTO_PAD_ID,
  DEFAULT_AUTO_PLAY,
  autoStepPlan,
  type AutoPlaySettings,
  type AutoStepPlan,
  type AutoPlayStatus,
  type AutoSource,
} from '@shared/autoplay'
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
  /** Clip ids auto-play can step through, in library order (default: none). */
  autoCandidates?(source: AutoSource): string[]
  /** Natural length of an animated clip or video, ms; null for a still or not loaded yet. */
  durationMs?(clipId: string): number | null
  /** Seek a loaded clip that isn't showing to `startMs`, so it starts there without a stall. */
  cue?(clipId: string, startMs: number): void
}

export type TriggerAction =
  | {
      type: 'start'
      layer: LayerId
      padId: string
      clipId: string
      spec: PadSpec
      startPos: number
      /** Where in the clip to start, ms (auto-play's long clips); 0 or missing: the start. */
      startMs?: number
    }
  | {
      type: 'restart'
      layer: LayerId
      padId: string
      /** Where in the clip to restart, ms; 0 or missing: the start. */
      startMs?: number
    }
  | { type: 'stop'; layer: LayerId; padId: string }

/** A press this soon after a boundary still counts for that boundary (human timing). */
export const GRACE_MS = 80

interface Pending {
  kind: 'start' | 'stop'
  spec: PadSpec
  clipId: string | null
  firePos: number
  /** 0..1 from pad velocity: scales the clip's opacity. */
  gain: number
  /** Where the clip starts, ms, decided at press when its length was known (and cued). */
  startMs: number | null
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
  /** 0..1 from pad velocity: scales the clip's opacity. */
  gain: number
  /** Where in the clip it started (and a beat loop jumps back to), ms. */
  startMs: number
}

/** Beats a pad repeats on: its beat loop, else its retrigger unit (retrigger mode). */
export function loopBeatsOf(spec: PadSpec): number | null {
  // A one-shot would never end, and retrigger already repeats on its own grid.
  if (spec.mode === 'oneShot' || spec.mode === 'retrigger') return null
  return spec.loopBeats ?? null
}

const unitFor = (q: Exclude<Quantize, 'off'>): GridUnit => q

export class TriggerScheduler {
  settings: TriggerSettings = { ...DEFAULT_TRIGGER_SETTINGS }
  private readonly pending = new Map<string, Pending>()
  private readonly armed = new Map<
    string,
    { spec: PadSpec; clipId: string | null; startMs: number | null }
  >()
  private dropPos: number | null = null
  private readonly voices = new Map<LayerId, Voice>()
  private readonly lastPick = new Map<string, string>()
  // Auto-play: steps through clips on the beat, as the voice AUTO_PAD_ID on its layer.
  private auto: AutoPlaySettings = { ...DEFAULT_AUTO_PLAY }
  /** When the next clip goes up (beats). */
  private autoNextPos: number | null = null
  /** The clip going up next, chosen a step early so it can load. */
  private autoNext: string | null = null
  private autoLast: string | null = null
  /** Shuffle order still to play. */
  private autoDeck: string[] = []
  private autoYielding = false
  /** Where the upcoming clip starts, ms, once decided (needs its length, so it's loaded). */
  private autoNextStartMs: number | null = null
  /** Where each clip carries on from, ms ('continue' start). */
  private readonly autoResume = new Map<string, number>()
  /** Set when stopping everything (or the auto-play layer) switched auto-play off. */
  private autoInterrupted = false
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

  /**
   * Where a pad's clip starts, ms: the beginning, or with 'random' a spot that leaves room for
   * what plays before the next jump (beat loop, retrigger or 'beats' length). Null while the
   * clip's length isn't known (not loaded). A tempo-synced clip always starts at the top.
   */
  private padStartMs(spec: PadSpec, clipId: string, clock: ClockView): number | null {
    if (spec.startAt !== 'random' || spec.syncBeats !== null) return 0
    const durationMs = this.clips.durationMs?.(clipId) ?? null
    if (durationMs === null) return null
    const windowBeats =
      loopBeatsOf(spec) ??
      (spec.mode === 'retrigger'
        ? spec.retriggerEvery === 'bar'
          ? BEATS_PER_BAR
          : 1
        : spec.mode === 'beats'
          ? spec.lengthBeats
          : 0)
    const room = Math.floor(durationMs - windowBeats / clock.beatsPerMs)
    return room > 0 ? Math.round(this.rand() * room) : 0
  }

  /** Decide a pad's start spot now if its clip is loaded, and cue the clip there. */
  private padCue(spec: PadSpec, clipId: string, clock: ClockView): number | null {
    const startMs = this.padStartMs(spec, clipId, clock)
    if (startMs) this.clips.cue?.(clipId, startMs)
    return startMs
  }

  press(padId: string, spec: PadSpec, nowMs: number, clock: ClockView, gain = 1): void {
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
      this.pending.set(padId, {
        kind: 'stop',
        spec,
        clipId: active.clipId,
        firePos,
        gain,
        startMs: null,
      })
      this.changed()
      return
    }
    const clipId = this.choose(padId, spec.source)
    if (!clipId) return
    const startMs = this.padCue(spec, clipId, clock)
    this.pending.set(padId, { kind: 'start', spec, clipId, firePos, gain, startMs })
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
    this.armed.set(padId, { spec, clipId, startMs: this.padCue(spec, clipId, clock) })
    if (this.dropPos === null) this.dropPos = this.dropTarget(nowMs, clock)
    this.changed()
  }

  /** Fire the armed drop on the next beat instead of waiting for its target. */
  dropNow(nowMs: number, clock: ClockView): void {
    if (this.dropPos === null) return
    this.dropPos = Math.min(this.dropPos, clock.boundaryAfter(clock.position(nowMs) + 1e-6, 'beat'))
    this.changed()
  }

  /** Where a drop armed now would land, per the drop setting. */
  private dropTarget(nowMs: number, clock: ClockView): number {
    const pos = clock.position(nowMs) + 1e-6
    const drop = this.settings.drop
    return drop.kind === 'phrase'
      ? clock.boundaryAfter(pos, 'phrase')
      : clock.boundaryAfter(pos, 'bar') + (drop.bars - 1) * BEATS_PER_BAR
  }

  /**
   * Change the settings. If a drop is pending and its timing changed, it is retargeted from
   * now, so the timing can be picked after arming.
   */
  setSettings(settings: TriggerSettings, nowMs: number, clock: ClockView): void {
    const dropChanged = JSON.stringify(settings.drop) !== JSON.stringify(this.settings.drop)
    this.settings = { ...settings }
    if (dropChanged && this.dropPos !== null) this.dropPos = this.dropTarget(nowMs, clock)
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
    this.autoOff()
    this.changed()
    return actions
  }

  /** Stop the pad on one layer now. */
  stopLayer(layer: LayerId): TriggerAction[] {
    if (layer === this.auto.layer && this.auto.enabled) {
      this.autoOff()
      this.changed()
    }
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

  // ---- auto-play ---------------------------------------------------------------

  get autoPlay(): Readonly<AutoPlaySettings> {
    return this.auto
  }

  /** Change auto-play. Returns stop actions when it was switched off or moved layers. */
  setAutoPlay(settings: AutoPlaySettings, nowMs: number, clock: ClockView): TriggerAction[] {
    const was = this.auto
    this.auto = { ...settings, source: { ...settings.source } }
    const actions: TriggerAction[] = []
    const stopOn = (layer: LayerId) => {
      if (this.voices.get(layer)?.padId !== AUTO_PAD_ID) return
      this.voices.delete(layer)
      actions.push({ type: 'stop', layer, padId: AUTO_PAD_ID })
    }
    if (!settings.enabled) {
      stopOn(was.layer)
      this.autoNextPos = null
      this.autoNext = null
      this.autoNextStartMs = null
      this.autoYielding = false
    } else {
      if (was.layer !== settings.layer) stopOn(was.layer)
      const sourceChanged = JSON.stringify(was.source) !== JSON.stringify(settings.source)
      if (!was.enabled || sourceChanged || was.order !== settings.order) {
        this.autoDeck = []
        this.autoNext = null
        this.autoNextStartMs = null
      }
      // Switching on (or moving layers) shows the first clip on the next beat.
      if (!was.enabled || was.layer !== settings.layer || this.autoNextPos === null)
        this.autoNextPos = this.firePosition(clock.position(nowMs), 'beat', clock)
      if (this.autoNext === null) {
        this.autoNext = this.autoPick()
        this.autoNextStartMs = null
      }
      this.autoCueNext(clock)
    }
    this.changed()
    return actions
  }

  /** True once after stopAll / stopLayer switched auto-play off (so the UI can follow). */
  takeAutoInterrupted(): boolean {
    const was = this.autoInterrupted
    this.autoInterrupted = false
    return was
  }

  private autoOff(): void {
    if (!this.auto.enabled) return
    this.auto = { ...this.auto, enabled: false }
    this.autoNextPos = null
    this.autoNext = null
    this.autoNextStartMs = null
    this.autoYielding = false
    this.autoInterrupted = true
  }

  /** The clip after `after` (the current or upcoming one), per the order. Starts it loading. */
  private autoPick(after: string | null = this.autoLast): string | null {
    const list = this.clips.autoCandidates?.(this.auto.source) ?? []
    if (list.length === 0) return null
    let id: string
    if (this.auto.order === 'inOrder') {
      const i = after !== null ? list.indexOf(after) : -1
      id = list[(i + 1) % list.length]!
    } else {
      const have = new Set(list)
      this.autoDeck = this.autoDeck.filter((c) => have.has(c))
      if (this.autoDeck.length === 0) {
        const deck = [...list]
        for (let i = deck.length - 1; i > 0; i--) {
          const j = Math.floor(this.rand() * (i + 1))
          ;[deck[i], deck[j]] = [deck[j]!, deck[i]!]
        }
        // A new round never starts with the clip that just played.
        if (deck.length > 1 && deck[0] === after) deck.push(deck.shift()!)
        this.autoDeck = deck
      }
      id = this.autoDeck.shift()!
    }
    this.clips.prepare(id)
    return id
  }

  /** How long the clip stays up, and whether it's stretched to fit. */
  private autoPlan(clipId: string, clock: ClockView): AutoStepPlan {
    const step = this.auto.step
    if (step !== 'auto') return { beats: step, syncBeats: null }
    return autoStepPlan(
      this.clips.durationMs?.(clipId) ?? null,
      clock.beatsPerMs * 60000,
      this.auto.longBeats ?? 16,
    )
  }

  /**
   * Where in the clip to start, ms, for a clip that plays at normal speed and is longer than
   * its step: the beginning, a random spot, or where it left off ('videoStart'). Null while its
   * length isn't known yet (not loaded).
   */
  private autoStartMs(clipId: string, clock: ClockView): number | null {
    const durationMs = this.clips.durationMs?.(clipId) ?? null
    if (durationMs === null) return null
    const plan = this.autoPlan(clipId, clock)
    const shownMs = plan.beats / clock.beatsPerMs
    const mode = this.auto.videoStart ?? 'start'
    if (plan.syncBeats !== null || mode === 'start' || durationMs <= shownMs) return 0
    // Whole milliseconds (a cue and its start must match exactly).
    const room = Math.floor(durationMs - shownMs)
    if (mode === 'random') return Math.round(this.rand() * room)
    const from = this.autoResume.get(clipId) ?? 0
    return from <= room ? from : 0
  }

  /** Decide where the upcoming clip starts as soon as its length is known, and cue it there. */
  private autoCueNext(clock: ClockView): void {
    if (this.autoNext === null || this.autoNextStartMs !== null) return
    const startMs = this.autoStartMs(this.autoNext, clock)
    if (startMs === null) return
    this.autoNextStartMs = startMs
    if (startMs > 0) this.clips.cue?.(this.autoNext, startMs)
  }

  private autoSpec(clipId: string, plan: AutoStepPlan): PadSpec {
    return {
      source: { kind: 'clip', clipId },
      mode: 'toggle',
      quantize: 'beat',
      lengthBeats: plan.beats,
      retriggerEvery: 'beat',
      fadeInBeats: 0,
      fadeOutBeats: 0,
      // With the 'auto' step a short clip plays through exactly once (or loops within a beat).
      syncBeats: plan.syncBeats,
      layer: this.auto.layer,
      placement: { ...DEFAULT_PLACEMENT, fit: this.auto.fit },
      key: DEFAULT_KEY,
    }
  }

  /**
   * When the clip that went up at `at` gives way: `beats` later, except that changes of a bar
   * or more land on bar lines (the first one may come sooner, to get onto the grid).
   */
  private autoAfter(at: number, beats: number, clock: ClockView): number {
    const unit: GridUnit = beats >= BEATS_PER_BAR ? 'bar' : 'beat'
    const grid = unit === 'bar' ? BEATS_PER_BAR : 1
    return clock.boundaryAfter(at + beats - grid + 1e-6, unit)
  }

  private autoStatus(pos: number): AutoPlayStatus {
    const v = this.voices.get(this.auto.layer)
    return {
      enabled: this.auto.enabled,
      clipId: v?.padId === AUTO_PAD_ID ? v.clipId : null,
      nextClipId: this.auto.enabled ? this.autoNext : null,
      beatsToNext: this.autoNextPos !== null ? Math.max(0, this.autoNextPos - pos) : null,
      yielding: this.autoYielding,
    }
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

    const start = (
      padId: string,
      spec: PadSpec,
      clipId: string,
      startPos: number,
      gain = 1,
      decided: number | null = null,
    ) => {
      const startMs = decided ?? this.padStartMs(spec, clipId, clock) ?? 0
      const loop = loopBeatsOf(spec)
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
          loop !== null
            ? startPos + loop
            : spec.mode === 'retrigger'
              ? clock.boundaryAfter(startPos + 1e-6, spec.retriggerEvery)
              : null,
        gain,
        startMs,
      }
      if (v.endPos !== null && spec.fadeOutBeats > 0) {
        v.fadeFromPos = Math.max(startPos, v.endPos - spec.fadeOutBeats)
      }
      this.voices.set(spec.layer, v)
      actions.push({
        type: 'start',
        layer: spec.layer,
        padId,
        clipId,
        spec,
        startPos,
        ...(startMs > 0 ? { startMs } : {}),
      })
      this.changed()
    }

    // The drop: every armed pad fires together, each on its own layer.
    if (this.dropPos !== null && due(this.dropPos)) {
      const at = this.dropPos
      for (const [padId, a] of this.armed) {
        if (a.clipId) {
          this.pending.delete(padId)
          start(padId, a.spec, a.clipId, at, 1, a.startMs)
        }
      }
      this.armed.clear()
      this.dropPos = null
      this.changed()
    }

    for (const [padId, p] of [...this.pending]) {
      if (!due(p.firePos)) continue
      this.pending.delete(padId)
      if (p.kind === 'start' && p.clipId)
        start(padId, p.spec, p.clipId, Math.max(p.firePos, pos), p.gain, p.startMs)
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
        const loop = loopBeatsOf(v.spec)
        if (loop !== null) {
          // Beat loop: back to the same spot, exactly `loop` beats on.
          v.nextRetriggerPos += loop
        } else {
          // Retrigger: a new spot each time with a random start.
          if (v.spec.startAt === 'random') v.startMs = this.padStartMs(v.spec, v.clipId, clock) ?? 0
          v.nextRetriggerPos = clock.boundaryAfter(v.nextRetriggerPos + 1e-6, v.spec.retriggerEvery)
        }
        actions.push({
          type: 'restart',
          layer,
          padId: v.padId,
          ...(v.startMs > 0 ? { startMs: v.startMs } : {}),
        })
      }
    }
    // Auto-play last, so a pad that ended on this frame hands its layer straight back.
    if (this.auto.enabled && this.autoNextPos !== null && due(this.autoNextPos)) {
      const at = this.autoNextPos
      const layer = this.auto.layer
      const occupant = this.voices.get(layer)
      const padQueued = [...this.pending.values()].some(
        (p) => p.kind === 'start' && p.spec.layer === layer,
      )
      const nextBeat = () => clock.boundaryAfter(Math.max(at, pos) + 1e-6, 'beat')
      if ((occupant && occupant.padId !== AUTO_PAD_ID) || padQueued) {
        // A pad has the layer: hold, and look again on the next beat.
        this.autoYielding = true
        this.autoNextPos = nextBeat()
      } else {
        this.autoYielding = false
        const list = this.clips.autoCandidates?.(this.auto.source) ?? []
        const keep = this.autoNext !== null && list.includes(this.autoNext)
        const clipId = keep ? this.autoNext : this.autoPick()
        if (clipId) {
          const plan = this.autoPlan(clipId, clock)
          const startMs =
            (keep ? this.autoNextStartMs : null) ?? this.autoStartMs(clipId, clock) ?? 0
          // A clock that jumped ahead (or a long frame) shouldn't leave the grid behind.
          const startPos = pos - at > 1 ? clock.boundaryAtOrBefore(pos, 'beat') : at
          // The same still again (a one-clip source) just stays up; anything else restarts.
          const still = (this.clips.durationMs?.(clipId) ?? null) === null
          if (!(still && occupant?.padId === AUTO_PAD_ID && occupant.clipId === clipId)) {
            start(AUTO_PAD_ID, this.autoSpec(clipId, plan), clipId, startPos, 1, startMs)
          }
          if (plan.syncBeats === null)
            this.autoResume.set(clipId, Math.round(startMs + plan.beats / clock.beatsPerMs))
          this.autoLast = clipId
          this.autoNextPos = this.autoAfter(startPos, plan.beats, clock)
          this.autoNext = this.autoPick(clipId)
          this.autoNextStartMs = null
          this.autoCueNext(clock)
        } else {
          // Nothing to show yet (no clips, or they failed): look again on the next beat.
          this.autoNext = null
          this.autoNextStartMs = null
          this.autoNextPos = nextBeat()
        }
      }
      this.changed()
    } else if (this.auto.enabled) {
      // The upcoming clip finished loading: decide where it starts and cue it there.
      this.autoCueNext(clock)
    }
    return actions
  }

  /** Opacity of the pad on `layer` at `nowMs` (fades in and out in beats); 1 if none. */
  opacity(layer: LayerId, nowMs: number, clock: ClockView): number {
    const v = this.voices.get(layer)
    if (!v) return 1
    const pos = clock.position(nowMs)
    let a = v.gain
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
    // The auto-play voice isn't a pad.
    delete pads[AUTO_PAD_ID]
    return {
      pads,
      drop,
      settings: { ...this.settings },
      auto: this.autoStatus(clock.position(nowMs)),
    }
  }
}
