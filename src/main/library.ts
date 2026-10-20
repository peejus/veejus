import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { ClipInfo, ImportResult } from '@shared/protocol'
import { clipUrl, mediaTypeFor } from '@shared/mediaTypes'

/** Folder scans stop here so an accidental drop of a whole drive cannot hang the app. */
const MAX_SCAN_DEPTH = 8
const MAX_FILES_PER_IMPORT = 2000

const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare

/** Stable id for a file path, so the same file keeps its id across sessions. */
export function clipIdForPath(path: string): string {
  const normalized = resolve(path)
  const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  return createHash('sha1').update(key).digest('hex').slice(0, 16)
}

/**
 * The clip library: every media file the user has imported. Only files registered here can
 * be served through the media protocol.
 */
export class Library {
  private readonly clips = new Map<string, ClipInfo>()

  list(): ClipInfo[] {
    return [...this.clips.values()]
  }

  pathFor(id: string): string | undefined {
    return this.clips.get(id)?.path
  }

  get(id: string): ClipInfo | undefined {
    return this.clips.get(id)
  }

  remove(ids: string[]): number {
    let n = 0
    for (const id of ids) if (this.clips.delete(id)) n++
    return n
  }

  async importPaths(paths: string[]): Promise<ImportResult> {
    const files: string[] = []
    let skipped = 0
    for (const p of paths) {
      skipped += await this.collect(resolve(p), files, 0)
    }

    let added = 0
    for (const file of files) {
      const type = mediaTypeFor(file)
      if (!type) {
        skipped++
        continue
      }
      const id = clipIdForPath(file)
      if (this.clips.has(id)) {
        skipped++
        continue
      }
      let sizeBytes: number
      try {
        sizeBytes = (await stat(file)).size
      } catch {
        skipped++
        continue
      }
      this.clips.set(id, {
        id,
        name: basename(file),
        path: file,
        kind: type.kind,
        mime: type.mime,
        sizeBytes,
        url: clipUrl(id),
      })
      added++
    }
    return { added, skipped }
  }

  /** Collect files under `path` into `out`. Returns how many entries were skipped. */
  private async collect(path: string, out: string[], depth: number): Promise<number> {
    if (out.length >= MAX_FILES_PER_IMPORT) return 1
    let info
    try {
      info = await stat(path)
    } catch {
      return 1
    }
    if (info.isFile()) {
      out.push(path)
      return 0
    }
    if (!info.isDirectory() || depth >= MAX_SCAN_DEPTH) return 1

    let skipped = 0
    const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => naturalCompare(a.name, b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const child = join(path, entry.name)
      if (entry.isDirectory()) skipped += await this.collect(child, out, depth + 1)
      else if (entry.isFile()) {
        if (mediaTypeFor(child)) {
          if (out.length < MAX_FILES_PER_IMPORT) out.push(child)
          else skipped++
        } else skipped++
      }
    }
    return skipped
  }
}
