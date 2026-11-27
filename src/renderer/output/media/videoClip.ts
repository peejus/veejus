import type { ClipInfo } from '@shared/protocol'

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
 * A preloaded, muted video kept paused on frame 0 so it can start instantly.
 * Not attached to the DOM; frames are uploaded to WebGL straight from the element.
 */
export class VideoClip {
  readonly kind = 'video'
  readonly el: HTMLVideoElement
  /** Set whenever the element has presented a new frame since the last upload. */
  hasNewFrame = true
  private disposed = false

  private constructor(readonly info: ClipInfo) {
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

  get durationMs(): number {
    return Number.isFinite(this.el.duration) ? this.el.duration * 1000 : 0
  }

  /** True when the current frame can be uploaded. */
  get frameAvailable(): boolean {
    return this.el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  }

  get ended(): boolean {
    return this.el.ended
  }

  /** Rough decoded-memory cost for budgeting (a few decoded frames held by the player). */
  get estimatedBytes(): number {
    return this.width * this.height * 4 * 4
  }

  /** Seconds a start offset may be from the current time and still count as already there. */
  private static readonly SEEK_TOLERANCE_S = 0.001

  private seekTo(startMs: number): void {
    const v = this.el
    const end = Number.isFinite(v.duration) ? Math.max(0, v.duration - 0.05) : Infinity
    const t = Math.min(end, Math.max(0, startMs / 1000))
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
    v.loop = loop
    v.playbackRate = speed
    this.seekTo(startMs)
    this.hasNewFrame = true
    void v.play().catch(() => {
      // play() rejects if interrupted by stop(); nothing to do.
    })
  }

  update(loop: boolean, speed: number): void {
    this.el.loop = loop
    // Media elements accept 0.0625-16; tempo sync can ask for more extreme rates.
    const rate = Math.min(16, Math.max(0.0625, speed))
    if (Math.abs(this.el.playbackRate - rate) > 1e-3) this.el.playbackRate = rate
  }

  /** Pause, and rewind so the next start from the beginning is instant again. */
  stop(rewind = true): void {
    this.el.pause()
    if (rewind && this.el.currentTime !== 0) this.el.currentTime = 0
  }

  dispose(): void {
    this.disposed = true
    this.el.pause()
    this.el.removeAttribute('src')
    this.el.load()
  }
}
