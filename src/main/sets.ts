import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { checkSet, type SetClip, type VeejusSet } from '@shared/set'
import type { RecentSet } from '@shared/protocol'

const RECENT_MAX = 10
const SEARCH_MAX_DEPTH = 8
const SEARCH_MAX_ENTRIES = 50_000

/** Write a file so a crash mid-write never leaves a half-written set behind. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/** Fill in each clip's path relative to the set file (when it can be expressed that way). */
export function withRelativePaths(set: VeejusSet, setPath: string): VeejusSet {
  const dir = dirname(setPath)
  return {
    ...set,
    clips: set.clips.map((c) => {
      const rel = relative(dir, c.path)
      // Different drive (Windows) or no common root: keep only the absolute path.
      return { ...c, relPath: rel && !isAbsolute(rel) ? rel.replaceAll('\\', '/') : null }
    }),
  }
}

/** Where a set's clip is now: next to the set file first (the folder moved), then its old path. */
export function locateClip(clip: SetClip, setPath: string | null): string | null {
  if (setPath && clip.relPath) {
    const p = resolve(dirname(setPath), clip.relPath)
    if (existsSync(p)) return p
  }
  return existsSync(clip.path) ? clip.path : null
}

export async function readSetFile(
  path: string,
): Promise<{ ok: true; set: VeejusSet } | { ok: false; reason: string }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    return { ok: false, reason: `Couldn’t read the file: ${(err as Error).message}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'The file isn’t valid JSON (damaged or not a set)' }
  }
  return checkSet(parsed)
}

/**
 * Look for files by name under `folder` (case-insensitive), for relinking moved media.
 * Returns name (lower case) -> first path found.
 */
export async function findFilesByName(
  folder: string,
  names: string[],
): Promise<Map<string, string>> {
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  const found = new Map<string, string>()
  let seen = 0
  const walk = async (dir: string, depth: number) => {
    if (depth > SEARCH_MAX_DEPTH || found.size === wanted.size || seen > SEARCH_MAX_ENTRIES) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      seen++
      if (e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p, depth + 1)
      else if (e.isFile()) {
        const key = e.name.toLowerCase()
        if (wanted.has(key) && !found.has(key)) found.set(key, p)
      }
    }
  }
  await walk(folder, 0)
  return found
}

/** The autosave and recent-sets files in the app profile. */
export class SetStore {
  constructor(private readonly dir: string) {}

  private get autosavePath() {
    return join(this.dir, 'autosave.json')
  }
  private get recentPath() {
    return join(this.dir, 'recent-sets.json')
  }

  async writeAutosave(data: {
    set: VeejusSet
    path: string | null
    dirty: boolean
  }): Promise<void> {
    await writeAtomic(this.autosavePath, JSON.stringify(data))
  }

  async readAutosave(): Promise<{ set: VeejusSet; path: string | null; dirty: boolean } | null> {
    try {
      const raw = JSON.parse(await readFile(this.autosavePath, 'utf8')) as {
        set: unknown
        path: unknown
        dirty: unknown
      }
      const check = checkSet(raw.set)
      if (!check.ok) return null
      return {
        set: check.set,
        path: typeof raw.path === 'string' ? raw.path : null,
        dirty: raw.dirty === true,
      }
    } catch {
      return null
    }
  }

  async recent(): Promise<RecentSet[]> {
    try {
      const list = JSON.parse(await readFile(this.recentPath, 'utf8')) as unknown
      if (!Array.isArray(list)) return []
      return list
        .filter((p): p is string => typeof p === 'string')
        .map((path) => ({ path, name: basename(path), exists: existsSync(path) }))
    } catch {
      return []
    }
  }

  async addRecent(path: string): Promise<void> {
    const list = (await this.recent()).map((r) => r.path).filter((p) => p !== path)
    list.unshift(path)
    await writeAtomic(this.recentPath, JSON.stringify(list.slice(0, RECENT_MAX)))
  }
}
