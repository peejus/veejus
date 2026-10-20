import { LruBudget } from '@core/lruBudget'
import type { ClipInfo, ClipLoadState, MediaStats } from '@shared/protocol'
import { ImageClip } from './imageClip'
import { VideoClip } from './videoClip'

export type LoadedClip = VideoClip | ImageClip

/** Decoded image frames may use this much memory before least-recently-used clips are dropped. */
export const DEFAULT_IMAGE_BUDGET_BYTES = 768 * 1024 * 1024
/** Preloaded video players kept warm. Each holds a decoder, so keep this modest. */
export const DEFAULT_WARM_VIDEO_LIMIT = 16
/** Background preloads running at once. */
const PRELOAD_CONCURRENCY = 2

interface Entry {
  info: ClipInfo
  state: ClipLoadState
  clip?: LoadedClip
  error?: string
  loading?: Promise<LoadedClip>
  /** A play request is waiting on the current load, so it must be kept even over budget. */
  wanted?: boolean
}

export type ClipStateListener = (id: string, state: ClipLoadState, error?: string) => void

/**
 * Loads, preloads and evicts clips for the output. Keeps decoded images within a byte budget
 * and warm video players within a count budget, evicting least-recently-used clips that are
 * not on screen. Background preloading never evicts anything; only play requests do.
 */
export class MediaManager {
  private readonly entries = new Map<string, Entry>()
  private readonly imageBudget = new LruBudget<string>(DEFAULT_IMAGE_BUDGET_BYTES)
  private readonly videoBudget = new LruBudget<string>(DEFAULT_WARM_VIDEO_LIMIT)
  private readonly preloadQueue: string[] = []
  private activePreloads = 0

  constructor(private readonly onState: ClipStateListener) {}

  /** Bring the known clip set in line with the library: add new clips, drop removed ones. */
  sync(clips: readonly ClipInfo[]): void {
    const ids = new Set(clips.map((c) => c.id))
    for (const [id, entry] of this.entries) {
      if (!ids.has(id)) {
        this.unload(id, entry)
        this.entries.delete(id)
      }
    }
    for (const info of clips) {
      if (this.entries.has(info.id)) continue
      this.entries.set(info.id, { info, state: 'cold' })
      this.preloadQueue.push(info.id)
      this.onState(info.id, 'cold')
    }
    this.pumpPreloads()
  }

  state(id: string): ClipLoadState | undefined {
    return this.entries.get(id)?.state
  }

  states(): Record<string, ClipLoadState> {
    const out: Record<string, ClipLoadState> = {}
    for (const [id, e] of this.entries) out[id] = e.state
    return out
  }

  /** The loaded clip, if it is ready right now. Marks it recently used. */
  getReady(id: string): LoadedClip | undefined {
    const e = this.entries.get(id)
    if (e?.state !== 'ready' || !e.clip) return undefined
    this.budgetFor(e.clip).touch(id)
    return e.clip
  }

  /** Load a clip for playback, evicting least-recently-used clips if the budget requires. */
  async load(id: string): Promise<LoadedClip> {
    const e = this.entries.get(id)
    if (!e) throw new Error('Unknown clip')
    const ready = this.getReady(id)
    if (ready) return ready
    e.wanted = true
    return this.startLoad(e, false)
  }

  /** Prevent eviction while the clip is on screen. */
  pin(id: string): void {
    const clip = this.entries.get(id)?.clip
    if (clip) this.budgetFor(clip).pin(id)
  }

  unpin(id: string): void {
    const clip = this.entries.get(id)?.clip
    if (clip) this.budgetFor(clip).unpin(id)
  }

  stats(): MediaStats {
    let ready = 0
    let loading = 0
    for (const e of this.entries.values()) {
      if (e.state === 'ready') ready++
      else if (e.state === 'loading') loading++
    }
    return {
      readyClips: ready,
      loadingClips: loading,
      imageBytes: this.imageBudget.used,
      imageBudgetBytes: this.imageBudget.limit,
      warmVideos: this.videoBudget.size,
      warmVideoLimit: this.videoBudget.limit,
    }
  }

  private budgetFor(clip: LoadedClip): LruBudget<string> {
    return clip.kind === 'video' ? this.videoBudget : this.imageBudget
  }

  private startLoad(e: Entry, isPreload: boolean): Promise<LoadedClip> {
    if (e.loading) return e.loading
    const id = e.info.id
    this.setState(e, 'loading')
    const promise = (e.info.kind === 'video' ? VideoClip.load(e.info) : ImageClip.load(e.info))
      .then((clip) => {
        if (this.entries.get(id) !== e) {
          // Removed from the library while loading.
          clip.dispose()
          throw new Error('Clip was removed')
        }
        const budget = this.budgetFor(clip)
        const cost = clip.kind === 'video' ? 1 : clip.estimatedBytes
        const wanted = e.wanted
        e.wanted = false
        if (isPreload && !wanted && budget.used + cost > budget.limit) {
          // Preloads only fill free space; leave it cold until someone plays it.
          clip.dispose()
          e.loading = undefined
          this.setState(e, 'cold')
          return clip
        }
        e.clip = clip
        e.loading = undefined
        for (const evictedId of budget.add(id, cost)) {
          const victim = this.entries.get(evictedId)
          if (victim) this.unload(evictedId, victim)
        }
        this.setState(e, 'ready')
        return clip
      })
      .catch((err: unknown) => {
        e.loading = undefined
        e.wanted = false
        if (this.entries.get(id) === e) {
          this.setState(e, 'error', err instanceof Error ? err.message : String(err))
        }
        throw err
      })
    e.loading = promise
    return promise
  }

  private unload(id: string, e: Entry): void {
    if (e.clip) {
      this.budgetFor(e.clip).remove(id)
      e.clip.dispose()
      e.clip = undefined
    }
    if (e.state === 'ready') this.setState(e, 'cold')
  }

  private setState(e: Entry, state: ClipLoadState, error?: string): void {
    e.state = state
    e.error = error
    this.onState(e.info.id, state, error)
  }

  private pumpPreloads(): void {
    while (this.activePreloads < PRELOAD_CONCURRENCY && this.preloadQueue.length > 0) {
      const id = this.preloadQueue.shift()!
      const e = this.entries.get(id)
      if (!e || e.state !== 'cold' || e.loading) continue
      if (e.info.kind === 'video' && this.videoBudget.size >= this.videoBudget.limit) continue
      this.activePreloads++
      this.startLoad(e, true)
        .catch(() => {
          // Error state is already recorded on the entry.
        })
        .finally(() => {
          this.activePreloads--
          this.pumpPreloads()
        })
    }
  }
}
