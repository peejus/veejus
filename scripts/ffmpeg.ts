import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** ffmpeg via the FFMPEG env var, then PATH, then the winget install location. */
export function findFfmpeg(): string | null {
  if (process.env['FFMPEG']) return process.env['FFMPEG']
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return 'ffmpeg'
  } catch {
    // fall through
  }
  const pkgs = join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft/WinGet/Packages')
  if (existsSync(pkgs)) {
    for (const dir of readdirSync(pkgs).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
      for (const build of readdirSync(join(pkgs, dir))) {
        const exe = join(pkgs, dir, build, 'bin', 'ffmpeg.exe')
        if (existsSync(exe)) return exe
      }
    }
  }
  return null
}

/** Decode any audio file to mono float samples at `sampleRate` with ffmpeg. */
export function decodeWithFfmpeg(ffmpeg: string, path: string, sampleRate: number): Float32Array {
  const raw = execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-f',
      'f32le',
      '-',
    ],
    { maxBuffer: 1024 * 1024 * 1024 },
  )
  // Copy: the Buffer may sit at an offset that isn't 4-byte aligned.
  const bytes = Math.floor(raw.byteLength / 4) * 4
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + bytes))
}
