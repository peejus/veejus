import { placeClip, type Transform } from '@core/placement'
import { DEFAULT_PLACEMENT, type BlendMode, type KeySettings, type Placement } from '@shared/layers'
import type { LayerSettings } from '@shared/protocol'
import type { LoadedClip, MediaManager } from './media/mediaManager'
import type { Stage, StageTexture } from './stage'

/** Longest time step applied in one frame, so a stall doesn't make clips jump ahead. */
const MAX_STEP_MS = 100

export type EndReason = 'finished' | 'replaced' | 'stopped'

export interface ClipLayerEvents {
  onStarted(id: string, waitFrames: number): void
  /** `owner` is the pad that started the clip (null for a library preview). */
  onEnded(id: string, owner: string | null, reason: EndReason): void
  onError(id: string, message: string): void
}

/** How a pad wants its clip shown; library previews use none of these. */
export interface PlayOptions {
  owner?: string | null
  /** Loop setting fixed by the pad's mode, overriding the layer setting. */
  loop?: boolean | null
  placement?: Placement | null
  key?: KeySettings | null
}

/** Per-frame compositing inputs for this layer. */
export interface RenderOptions {
  opacity: number
  blend: BlendMode
  /** 0..1 progress of the entrance animation (1 = done). */
  entranceProgress: number
}

interface Playing {
  id: string
  clip: LoadedClip
  /** Clip time elapsed, in ms, scaled by speed (image clips). */
  elapsedMs: number
  /** Frame index currently in the texture (image clips), -1 if none. */
  uploadedFrame: number
  /** Whether the texture holds a frame of this clip yet. */
  hasTexture: boolean
  started: boolean
  requestedAtFrame: number
  owner: string | null
  loop: boolean | null
  placement: Placement | null
  key: KeySettings | null
  /** Random spot for the 'random' anchor, chosen when the clip starts. */
  random: [number, number]
}

/** One compositing layer: plays a single clip at a time. */
export class ClipLayer {
  private playing: Playing | null = null
  private texture: StageTexture | null = null
  private textureGeneration = -1
  /** Incremented per play/stop request; stale async loads compare against it. */
  private requestToken = 0
  /** Playback speed forced by tempo sync; null uses the layer setting. */
  speedOverride: number | null = null
  /** Where the clip was last drawn (for tests and diagnostics). */
  lastTransform: Transform | null = null
  private paused = false

  constructor(
    private readonly stage: Stage,
    private readonly media: MediaManager,
    private readonly events: ClipLayerEvents,
    public settings: LayerSettings,
  ) {}

  get current(): Readonly<Playing> | null {
    return this.playing
  }

  /** Start `id`. A ready clip begins on the next rendered frame; otherwise it loads first. */
  play(id: string, settings: LayerSettings, frameNumber: number, options: PlayOptions = {}): void {
    const token = ++this.requestToken
    this.settings = settings
    this.speedOverride = null
    const ready = this.media.getReady(id)
    if (ready) {
      this.begin(id, ready, frameNumber, options)
      return
    }
    this.media
      .load(id)
      .then((clip) => {
        if (token === this.requestToken) this.begin(id, clip, frameNumber, options)
      })
      .catch((err: unknown) => {
        if (token === this.requestToken) {
          this.events.onError(id, err instanceof Error ? err.message : String(err))
        }
      })
  }

  stop(): void {
    this.requestToken++
    this.end('stopped')
  }

  /** Jump back to the first frame (retrigger). */
  restart(): void {
    const p = this.playing
    if (!p) return
    if (p.clip.kind === 'video') {
      p.clip.el.currentTime = 0
      p.clip.hasNewFrame = true
      if (p.clip.el.paused && !this.paused) void p.clip.el.play().catch(() => {})
    } else {
      p.elapsedMs = 0
      p.uploadedFrame = -1
    }
  }

  /** Freeze or resume playback (the layer keeps drawing its current frame). */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return
    this.paused = paused
    const c = this.playing?.clip
    if (c?.kind === 'video') {
      if (paused) c.el.pause()
      else void c.el.play().catch(() => {})
    }
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** Natural length of the current clip at speed 1, ms (0 if unknown). */
  get durationMs(): number {
    const c = this.playing?.clip
    if (!c) return 0
    return c.kind === 'video' ? c.durationMs : c.timeline.totalMs
  }

  setSettings(settings: LayerSettings): void {
    this.settings = settings
  }

  private begin(id: string, clip: LoadedClip, frameNumber: number, o: PlayOptions): void {
    this.end('replaced')
    this.media.pin(id)
    const loop = o.loop ?? null
    if (clip.kind === 'video') {
      clip.start(loop ?? this.settings.loop, this.settings.speed)
      if (this.paused) clip.el.pause()
    }
    this.playing = {
      id,
      clip,
      elapsedMs: 0,
      uploadedFrame: -1,
      hasTexture: false,
      started: false,
      requestedAtFrame: frameNumber,
      owner: o.owner ?? null,
      loop,
      placement: o.placement ?? null,
      key: o.key ?? null,
      random: [Math.random(), Math.random()],
    }
  }

  private end(reason: EndReason): void {
    const p = this.playing
    if (!p) return
    this.playing = null
    this.lastTransform = null
    if (p.clip.kind === 'video') p.clip.stop()
    this.media.unpin(p.id)
    this.events.onEnded(p.id, p.owner, reason)
  }

  private ensureTexture(): StageTexture | null {
    if (!this.texture || this.textureGeneration !== this.stage.generation) {
      this.texture = this.stage.createTexture()
      this.textureGeneration = this.stage.generation
      if (this.playing) {
        this.playing.hasTexture = false
        this.playing.uploadedFrame = -1
      }
    }
    return this.texture
  }

  /** Advance and composite. Call once per rendered frame, bottom layer first. */
  render(dtMs: number, frameNumber: number, o: RenderOptions): void {
    const p = this.playing
    if (!p || !this.stage.ready) return
    const tex = this.ensureTexture()
    if (!tex) return
    const loop = p.loop ?? this.settings.loop
    const speed = this.speedOverride ?? this.settings.speed
    const clip = p.clip

    if (clip.kind === 'video') {
      clip.update(loop, speed)
      if (!loop && clip.ended) {
        this.end('finished')
        return
      }
      if (clip.frameAvailable && (clip.hasNewFrame || !p.hasTexture)) {
        this.stage.upload(tex, clip.el, clip.width, clip.height)
        clip.hasNewFrame = false
        p.hasTexture = true
      }
    } else {
      // The first frame is shown at time 0; time advances from the frame after.
      if (p.started && !this.paused) p.elapsedMs += Math.min(dtMs, MAX_STEP_MS) * speed
      const pos = clip.timeline.frameAt(p.elapsedMs, loop)
      if (pos.done) {
        this.end('finished')
        return
      }
      if (pos.index !== p.uploadedFrame) {
        this.stage.upload(tex, clip.frames[pos.index]!, clip.width, clip.height)
        p.uploadedFrame = pos.index
        p.hasTexture = true
      }
    }

    if (!p.hasTexture) return
    const { width, height } = this.stage.size
    const placement = p.placement ?? { ...DEFAULT_PLACEMENT, fit: this.settings.fit }
    const t = placeClip(tex.width, tex.height, width, height, placement, {
      entranceProgress: o.entranceProgress,
      random: p.random,
    })
    this.lastTransform = t
    this.stage.drawLayer(tex, t, { opacity: o.opacity, blend: o.blend, key: p.key })
    if (!p.started) {
      p.started = true
      this.events.onStarted(p.id, frameNumber - p.requestedAtFrame)
    }
  }
}
