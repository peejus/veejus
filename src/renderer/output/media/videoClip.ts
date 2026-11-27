import { MIN_TRIM_MS, type ClipInfo, type ClipTrim } from '@shared/protocol'

const LOAD_TIMEOUT_MS = 20_000

function mediaErrorMessage(err: MediaError | null): string {
  switch (err?.code) {
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'Unsupported format or codec'
    case MediaError.MEDIA_ERR_DECODE:
      return 'Could not decode video (corrupt file?)'
    case MediaError.MEDIA_ERR_NETWORK:
      return 'Could not read file'
    case MediaError.MEDIA_ERR_ABORTED:
      return 'Loading was aborted'
    default:
      return err?.message || 'Could not load video'
  }
}

/**
 * A preloaded, muted video kept paused on its first frame (the trim's in-point) so it can
 * start instantly. Not attached to the DOM; frames are uploaded to WebGL straight from the
 * element.
 *
 * With a trim, everything is relative to the in-point: `durationMs` is the trimmed length,
 * start offsets count from the in-point, and looping jumps from the out-point back to it.
 */
export class VideoClip {
  readonly kind = 'video'
  readonly el: HTMLVideoElement
  /** Set whenever the element has presented a new frame since the last upload. */
  hasNewFrame = true
  private disposed = false
  private trimValue: ClipTrim | null
  /** Loop setting from the layer (the element's own loop can't loop a trimmed part). */
  private looping = false
  /** A non-looping play reached the out-point. */
  private reachedOut = false

  private constructor(readonly info: ClipInfo) {
    this.trimValue = info.trim ?? null
    const v = document.createElement('video')
    v.crossOrigin = 'anonymous'
    v.muted = true
    v.defaultMuted = true
    v.playsInline = true
    v.preload = 'auto'
    v.disableRemotePlayback = true
    this.el = v
  }

  static async load(info: ClipInfo): Promise<VideoClip> {
    const clip = new VideoClip(info)
    const v = clip.el
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Timed out loading video')), LOAD_TIMEOUT_MS)
      const finish = (err?: Error) => {
        clearTimeout(timer)
        v.removeEventListener('canplaythrough', onReady)
        v.removeEventListener('error', onError)
        if (err) reject(err)
        else resolve()
      }
      const onReady = () => finish()
      const onError = () => finish(new Error(mediaErrorMessage(v.error)))
      v.addEventListener('canplaythrough', onReady)
      v.addEventListener('error', onError)
      v.src = info.url
      v.load()
    }).catch((err: unknown) => {
      clip.dispose()
      throw err
    })
    if (v.videoWidth === 0 || v.videoHeight === 0) {
      clip.dispose()
      throw new Error('Video has no picture track')
    }
    clip.watchFrames()
    return clip
  }

  private watchFrames(): void {
    const onFrame = () => {
      if (this.disposed) return
      this.hasNewFrame = true
      this.el.requestVideoFrameCallback(onFrame)
    }
    this.el.requestVideoFrameCallback(onFrame)
  }

  get width(): number {
    return this.el.videoWidth
  }

  get height(): number {
    return this.el.videoHeight
  }

  /** Length of the whole file, ms (0 if unknown). */
  get naturalDurationMs(): number {
    return Number.isFinite(this.el.duration) ? this.el.duration * 1000 : 0
  }

  /** The part that plays, ms from the file's start, clamped to the file. */
  private get range(): { inMs: number; outMs: number } {
    const natural = this.naturalDurationMs
    const t = this.trimValue
    if (!t || !(natural > 0)) return { inMs: 0, outMs: natural }
    const inMs = Math.min(Math.max(0, t.inMs), natural)
    const outMs = Math.min(t.outMs ?? natural, natural)
    // A trim that no longer fits the file (it changed) plays all of it.
    return outMs - inMs >= MIN_TRIM_MS ? { inMs, outMs } : { inMs: 0, outMs: natural }
  }

  private get trimmed(): boolean {
    const r = this.range
    return r.inMs > 0 || r.outMs < this.naturalDurationMs
  }

  /** Length of the part that plays, ms (the trimmed length; 0 if unknown). */
  get durationMs(): number {
    const r = this.range
    return r.outMs - r.inMs
  }

  get trim(): ClipTrim | null {
    return this.trimValue
  }

  /** Change the trim (the library changed). A paused clip moves to the new in-point. */
  setTrim(trim: ClipTrim | null): void {
    const same =
      (trim === null && this.trimValue === null) ||
      (trim !== null &&
        this.trimValue !== null &&
        trim.inMs === this.trimValue.inMs &&
        trim.outMs === this.trimValue.outMs)
    if (same) return
    this.trimValue = trim ? { ...trim } : null
    if (this.el.paused) this.seekTo(0)
  }

  /** True when the current frame can be uploaded. */
  get frameAvailable(): boolean {
    return this.el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  }

  get ended(): boolean {
    return this.el.ended || this.reachedOut
  }

  /** Rough decoded-memory cost for budgeting (a few decoded frames held by the player). */
  get estimatedBytes(): number {
    return this.width * this.height * 4 * 4
  }

  /** Seconds a start offset may be from the current time and still count as already there. */
  private static readonly SEEK_TOLERANCE_S = 0.001

  /** Seek to `startMs` from the in-point (kept inside the part that plays). */
  private seekTo(startMs: number): void {
    const v = this.el
    const { inMs, outMs } = this.range
    const endMs = outMs > 0 ? Math.max(inMs, outMs - 50) : Infinity
    const t = Math.min(endMs, inMs + Math.max(0, startMs)) / 1000
    // Only seek if needed: a seek, even to the current time, briefly drops the decoded frame.
    if (Math.abs(v.currentTime - t) > VideoClip.SEEK_TOLERANCE_S) {
      v.currentTime = t
      this.hasNewFrame = true
    }
  }

  /**
   * Seek ahead of time while paused, so a later `start(…, startMs)` with the same offset
   * begins on the next frame instead of waiting for the seek to decode.
   */
  cue(startMs: number): void {
    if (this.el.paused) this.seekTo(startMs)
  }

  start(loop: boolean, speed: number, startMs = 0): void {
    const v = this.el
    this.looping = loop
    this.reachedOut = false
    v.loop = loop && !this.trimmed
    v.playbackRate = speed
    this.seekTo(startMs)
    this.hasNewFrame = true
    void v.play().catch(() => {
      // play() rejects if interrupted by stop(); nothing to do.
    })
  }

  /** Call once per rendered frame while playing: speed, loop, and the trim's out-point. */
  update(loop: boolean, speed: number): void {
    const v = this.el
    this.looping = loop
    const trimmed = this.trimmed
    v.loop = loop && !trimmed
    // Media elements accept 0.0625-16; tempo sync can ask for more extreme rates.
    const rate = Math.min(16, Math.max(0.0625, speed))
    if (Math.abs(v.playbackRate - rate) > 1e-3) v.playbackRate = rate
    if (!trimmed || this.reachedOut) return
    if (v.currentTime * 1000 >= this.range.outMs - 1 || v.ended) {
      if (this.looping) {
        this.seekTo(0)
        if (v.paused) void v.play().catch(() => {})
      } else {
        this.reachedOut = true
        v.pause()
      }
    }
  }

  /** Jump to `startMs` from the in-point while playing (retrigger, beat loop). */
  restart(startMs: number, play: boolean): void {
    this.reachedOut = false
    this.seekTo(startMs)
    this.hasNewFrame = true
    if (play && this.el.paused) void this.el.play().catch(() => {})
  }

  /** Pause, and rewind to the in-point so the next start from there is instant again. */
  stop(rewind = true): void {
    this.el.pause()
    this.reachedOut = false
    if (rewind) this.seekTo(0)
  }

  dispose(): void {
    this.disposed = true
    this.el.pause()
    this.el.removeAttribute('src')
    this.el.load()
  }
}
