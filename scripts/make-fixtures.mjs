// Generates test media with ffmpeg.
//
//   node scripts/make-fixtures.mjs           small committed set in fixtures/media
//   node scripts/make-fixtures.mjs --stress  50 mixed clips in fixtures/stress (gitignored)
//
// ffmpeg is found via the FFMPEG env var, then PATH, then the winget install location.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return 'ffmpeg'
  } catch {
    // fall through
  }
  const pkgs = join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Packages')
  if (existsSync(pkgs)) {
    for (const dir of readdirSync(pkgs).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
      for (const build of readdirSync(join(pkgs, dir))) {
        const exe = join(pkgs, dir, build, 'bin', 'ffmpeg.exe')
        if (existsSync(exe)) return exe
      }
    }
  }
  throw new Error('ffmpeg not found. Install it or set FFMPEG=/path/to/ffmpeg')
}

const ffmpeg = findFfmpeg()

function run(args) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
}

/** Deterministic pseudo-random bytes, so corrupt fixtures are stable across runs. */
function junk(size, seed) {
  const buf = Buffer.alloc(size)
  let x = seed
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    buf[i] = x & 0xff
  }
  return buf
}

// Opaque left half, transparent right half.
const HALF_ALPHA = "a='if(lt(X,W/2),255,0)'"

function gif(out, src, alphaExpr) {
  const alpha = alphaExpr ? `,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':${alphaExpr}` : ''
  run([
    '-f',
    'lavfi',
    '-i',
    src,
    '-vf',
    `${alpha.slice(1) || 'null'},split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128`,
    '-loop',
    '0',
    out,
  ])
}

function makeBasic() {
  const dir = join(root, 'fixtures/media')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const f = (name) => join(dir, name)

  // H.264 MP4, 2 s, 320x180.
  run([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x180:r=30:d=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    f('countdown.mp4'),
  ])

  // VP9 WebM with alpha: an orange ball moving over full transparency.
  run([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=256x256:r=30:d=2',
    '-vf',
    "format=rgba,geq=r='255':g='160':b='0':a='if(lt(hypot(X-(48+T*80),Y-128),40),255,0)'",
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-b:v',
    '300k',
    '-auto-alt-ref',
    '0',
    f('alpha-ball.webm'),
  ])

  // Animated GIF, left half opaque, right half transparent.
  gif(f('half-alpha.gif'), 'testsrc=s=160x120:r=10:d=1', HALF_ALPHA)

  // Animated WebP and APNG.
  run([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=160x120:r=10:d=1',
    '-c:v',
    'libwebp_anim',
    '-loop',
    '0',
    '-lossless',
    '0',
    '-q:v',
    '70',
    f('wave.webp'),
  ])
  run([
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=128x128:r=10:d=1',
    '-plays',
    '0',
    '-f',
    'apng',
    f('bounce.png'),
  ])

  // Static PNG with alpha (red, left half opaque) and a JPEG.
  run([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=64x64:d=1',
    '-frames:v',
    '1',
    '-vf',
    `format=rgba,geq=r='255':g='0':b='0':${HALF_ALPHA}`,
    f('half-alpha-still.png'),
  ])
  run(['-f', 'lavfi', '-i', 'testsrc=s=320x240:d=1', '-frames:v', '1', f('photo.jpg')])

  // ProRes MOV: Chromium cannot decode ProRes, so this exercises the "unsupported" error path.
  run(['-f', 'lavfi', '-i', 'testsrc=s=160x120:r=10:d=1', '-c:v', 'prores_ks', f('prores.mov')])

  // Corrupt files with valid extensions, plus a file that should be ignored.
  writeFileSync(f('corrupt.mp4'), junk(4096, 1))
  writeFileSync(f('corrupt.gif'), Buffer.concat([Buffer.from('GIF89a'), junk(512, 2)]))
  writeFileSync(f('notes.txt'), 'Not media; the importer should skip this.\n')

  console.log(`Basic fixtures written to ${dir}`)
}

function makeStress() {
  const dir = join(root, 'fixtures/stress')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const sources = ['testsrc', 'testsrc2', 'smptebars', 'rgbtestsrc', 'mandelbrot', 'life']
  const src = (i, size, rate, dur) => {
    const s = sources[i % sources.length]
    const extra = s === 'life' ? ':mold=10:ratio=0.1:death_color=#c83232:life_color=#00ff00' : ''
    return `${s}=s=${size}:r=${rate}${extra},trim=duration=${dur}`
  }
  const pad = (i) => String(i).padStart(2, '0')
  let n = 0
  for (let i = 0; i < 20; i++, n++) {
    run([
      '-f',
      'lavfi',
      '-i',
      src(i, '640x360', 30, 3),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      join(dir, `clip-${pad(n)}.mp4`),
    ])
  }
  for (let i = 0; i < 15; i++, n++) {
    gif(
      join(dir, `gif-${pad(n)}.gif`),
      src(i + 1, '240x136', 15, 2),
      i % 3 === 0 ? HALF_ALPHA : null,
    )
  }
  for (let i = 0; i < 10; i++, n++) {
    run([
      '-f',
      'lavfi',
      '-i',
      src(i + 2, '240x136', 15, 2),
      '-c:v',
      'libwebp_anim',
      '-loop',
      '0',
      '-q:v',
      '60',
      join(dir, `webp-${pad(n)}.webp`),
    ])
  }
  for (let i = 0; i < 5; i++, n++) {
    run([
      '-f',
      'lavfi',
      '-i',
      src(i + 3, '480x270', 30, 2),
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      '500k',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      join(dir, `vp9-${pad(n)}.webm`),
    ])
  }
  console.log(`${n} stress clips written to ${dir}`)
}

if (process.argv.includes('--stress')) makeStress()
else makeBasic()
