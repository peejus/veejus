import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * App settings that must be known before the windows open (Chromium switches), kept in
 * settings.json in the profile folder. Read synchronously at startup.
 */
export interface AppSettings {
  /** Decode video on the GPU. Needed for HEVC on a Mac; can hitch as clips preload. */
  hardwareVideoDecode: boolean
}

const DEFAULTS: AppSettings = { hardwareVideoDecode: false }

export function settingsPath(userData: string): string {
  return join(userData, 'settings.json')
}

export function readAppSettings(userData: string): AppSettings {
  try {
    const v: unknown = JSON.parse(readFileSync(settingsPath(userData), 'utf8'))
    if (typeof v !== 'object' || v === null) return { ...DEFAULTS }
    const o = v as Record<string, unknown>
    return {
      hardwareVideoDecode:
        typeof o['hardwareVideoDecode'] === 'boolean'
          ? o['hardwareVideoDecode']
          : DEFAULTS.hardwareVideoDecode,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeAppSettings(userData: string, settings: AppSettings): void {
  const path = settingsPath(userData)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

/**
 * Whether hardware decoding is on for this run. VEEJUS_HW_VIDEO_DECODE=1 or 0 overrides the
 * saved setting (`forced`).
 */
export function hardwareDecodeFor(
  saved: AppSettings,
  env: string | undefined,
): { on: boolean; forced: boolean } {
  if (env === '1') return { on: true, forced: true }
  if (env === '0') return { on: false, forced: true }
  return { on: saved.hardwareVideoDecode, forced: false }
}
