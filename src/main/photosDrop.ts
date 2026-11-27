import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'

/** What the native helper reports (native-src/photodrop/photodrop.mm). */
export type PhotosDropEvent =
  | { type: 'promised'; token: string; previewPath: string; fileType: string }
  | { type: 'received'; token: string; path: string }
  | { type: 'failed'; token: string; error: string }

interface PhotosDropAddon {
  install(destinationDir: string, onEvent: (event: PhotosDropEvent) => void): void
}

/** How long a drop's preview path stays matched to its promised video. */
const PENDING_TTL_MS = 30 * 60_000
/** Photos may have to download the video from iCloud first. */
const RECEIVE_TIMEOUT_MS = 10 * 60_000
/** A Photos preview path that arrives before its drop was reported waits this long for it. */
const LATE_PROMISE_WAIT_MS = 1500

const UUID_RE = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i

/** True for files inside a Photos library bundle: what Photos drags out as a video's preview. */
export function isPhotosLibraryPath(path: string): boolean {
  return /\.photoslibrary[\\/]/i.test(path)
}

/** The Photos asset id in a preview's file name ("86442640-…_4_5005_c.jpeg"), if any. */
export function assetIdFromPreview(previewPath: string): string | null {
  return basename(previewPath).match(UUID_RE)?.[0].toUpperCase() ?? null
}

interface Pending {
  token: string
  at: number
  done: Promise<string>
  resolve: (path: string) => void
  reject: (err: Error) => void
}

export interface ResolvedPaths {
  paths: string[]
  /** One line per dropped Photos video that could not be fetched. */
  warnings: string[]
}

/**
 * Swaps the preview still Photos drags out for a video with the video itself.
 *
 * During a drop the native helper reports each promised movie with the preview path the renderer
 * will also see, then reports where Photos wrote the movie. `resolve` maps dropped paths through
 * that: each preview is replaced by its movie, kept in `videosDir/<asset id>/` so dropping the
 * same video again reuses it.
 */
export class PhotosDrop {
  private readonly byPreview = new Map<string, Pending>()
  private readonly byToken = new Map<string, Pending>()
  private readonly waiters = new Map<string, () => void>()

  constructor(
    /** Where finished videos are kept. */
    private readonly videosDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Feed one event from the native helper. */
  handle(event: PhotosDropEvent): void {
    if (event.type === 'promised') {
      let resolve!: (path: string) => void
      let reject!: (err: Error) => void
      const done = new Promise<string>((res, rej) => {
        resolve = res
        reject = rej
      })
      done.catch(() => {}) // a drop nobody imports must not raise an unhandled rejection
      const pending: Pending = { token: event.token, at: this.now(), done, resolve, reject }
      this.prune()
      this.byPreview.set(event.previewPath, pending)
      this.byToken.set(event.token, pending)
      this.waiters.get(event.previewPath)?.()
      return
    }
    const pending = this.byToken.get(event.token)
    if (!pending) return
    this.byToken.delete(event.token)
    if (event.type === 'received') pending.resolve(event.path)
    else pending.reject(new Error(event.error || 'Photos could not export the video'))
  }

  /** Replace dropped Photos previews with their videos; other paths pass through unchanged. */
  async resolve(paths: string[]): Promise<ResolvedPaths> {
    const out: string[] = []
    const warnings: string[] = []
    // The helper normally reports a drop before the renderer's import arrives; give any Photos
    // path that isn't matched yet a moment (all at once, so a drop of many photos waits once).
    const late = [...new Set(paths)].filter((p) => !this.byPreview.has(p) && isPhotosLibraryPath(p))
    await Promise.all(late.map((p) => this.waitForPromise(p)))
    for (const path of paths) {
      const pending = this.byPreview.get(path)
      if (!pending) {
        out.push(path)
        continue
      }
      this.byPreview.delete(path)
      try {
        out.push(await this.finish(path, pending))
      } catch (err) {
        warnings.push(
          `Couldn’t get a video from Photos (${err instanceof Error ? err.message : err}). ` +
            'Drag it to the Desktop first, then drop that file.',
        )
      }
    }
    return { paths: out, warnings }
  }

  private waitForPromise(previewPath: string): Promise<void> {
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer)
        this.waiters.delete(previewPath)
        done()
      }
      const timer = setTimeout(finish, LATE_PROMISE_WAIT_MS)
      this.waiters.set(previewPath, finish)
    })
  }

  /** Wait for the movie, then move it to its asset's folder (or reuse one already there). */
  private async finish(previewPath: string, pending: Pending): Promise<string> {
    const folder = join(this.videosDir, assetIdFromPreview(previewPath) ?? pending.token)
    const existing = await firstFile(folder)

    let received: string
    try {
      received = await withTimeout(pending.done, RECEIVE_TIMEOUT_MS)
    } catch (err) {
      if (existing) return existing // an earlier drop of the same video already has it
      throw err
    }
    if (existing) {
      await rm(dirOf(received), { recursive: true, force: true })
      return existing
    }
    await mkdir(folder, { recursive: true })
    const target = join(folder, basename(received))
    try {
      await rename(received, target)
    } catch {
      await copyFile(received, target) // a different volume
    }
    await rm(dirOf(received), { recursive: true, force: true })
    return target
  }

  private prune(): void {
    const cutoff = this.now() - PENDING_TTL_MS
    for (const [path, p] of this.byPreview) if (p.at < cutoff) this.byPreview.delete(path)
    for (const [token, p] of this.byToken) if (p.at < cutoff) this.byToken.delete(token)
  }
}

function dirOf(path: string): string {
  return join(path, '..')
}

async function firstFile(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const file = entries.find((e) => e.isFile() && !e.name.startsWith('.'))
  return file ? join(dir, file.name) : null
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * Load the native helper and hook drops (macOS only). Returns why it isn't active, or null.
 * Call after the app is ready.
 */
export function installPhotosDrop(
  modulePath: string,
  incomingDir: string,
  drop: PhotosDrop,
): string | null {
  if (process.platform !== 'darwin') return 'macOS only'
  if (!existsSync(modulePath)) return 'not built (run npm run build:photodrop)'
  try {
    const addon = createRequire(__filename)(modulePath) as PhotosDropAddon
    addon.install(incomingDir, (event) => drop.handle(event))
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** native/ at the project root when running from source, resources/native/ when installed. */
export function photosDropModulePath(
  mainDir: string,
  packaged: boolean,
  resourcesPath: string,
): string {
  return packaged
    ? join(resourcesPath, 'native', 'photodrop.node')
    : join(mainDir, '..', '..', 'native', 'photodrop.node')
}
