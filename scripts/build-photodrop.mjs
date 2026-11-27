// Builds the macOS Photos drop helper into native/photodrop.node.
//
//   npm run build:photodrop
//
// Optional, macOS only: without it Veejus runs normally, but a video dragged in from the Photos
// app imports as its preview still (see native-src/photodrop/photodrop.mm). Needs the Xcode
// command line tools (xcode-select --install). `-- --arch=x64` builds for Intel Macs.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

if (process.platform !== 'darwin') {
  console.log('The Photos drop helper is macOS only; nothing to build here.')
  process.exit(0)
}

const root = resolve(import.meta.dirname, '..')
const src = join(root, 'native-src', 'photodrop')
const out = join(root, 'native', 'photodrop.node')

rmSync(join(src, 'build'), { recursive: true, force: true })

// npm's own node-gyp, as in build-link.mjs.
const npmDir = dirname(dirname(process.env.npm_execpath ?? ''))
const bundledGyp = join(npmDir, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
const gypArgs = ['rebuild', ...process.argv.slice(2).filter((a) => a.startsWith('--arch='))]
console.log('Building the Photos drop helper…')
if (existsSync(bundledGyp))
  execFileSync(process.execPath, [bundledGyp, ...gypArgs], { cwd: src, stdio: 'inherit' })
else execFileSync('npx', ['node-gyp', ...gypArgs], { cwd: src, stdio: 'inherit' })

mkdirSync(dirname(out), { recursive: true })
copyFileSync(join(src, 'build', 'Release', 'photodrop.node'), out)
rmSync(join(src, 'build'), { recursive: true, force: true })
console.log(`Photos drop helper written to ${out}`)
