// Builds the optional Ableton Link native module into native/abletonlink.node.
//
//   npm run build:link
//
// Link support is optional: without the module, Veejus runs normally and the "Ableton Link"
// clock source says it isn't installed. The module is built from the @ktamas77/abletonlink
// Node-API binding (MIT), which bundles the Ableton Link SDK (GPL-2.0-or-later, or a
// proprietary license from Ableton). The SDK source is downloaded at build time and never
// committed. See docs/PROGRESS.md (Phase 7) for the licensing note.
//
// Windows needs Visual Studio Build Tools (C++); macOS needs the Xcode command line tools
// (xcode-select --install). The published binding.gyp defines the macOS platform
// unconditionally and asks for C++14, so it is patched before building. The module is native
// code, so build it on the platform you'll run on; on a Mac, `npm run build:link -- --arch=x64`
// builds for the other CPU.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const PACKAGE = '@ktamas77/abletonlink@1.2.3'
const root = resolve(import.meta.dirname, '..')
const work = join(root, 'native', 'build') // inside the project: MSBuild dislikes %TEMP% paths
const out = join(root, 'native', 'abletonlink.node')

const sh = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

console.log(`Fetching ${PACKAGE}…`)
sh('npm', ['pack', PACKAGE, '--silent'], work)
const tgz = execFileSync('npm', ['pack', PACKAGE, '--dry-run', '--json', '--silent'], {
  cwd: work,
  shell: process.platform === 'win32',
}).toString()
const filename = JSON.parse(tgz)[0].filename
sh('tar', ['xzf', filename], work)
const pkg = join(work, 'package')

console.log('Patching binding.gyp…')
const gypPath = join(pkg, 'binding.gyp')
let gyp = readFileSync(gypPath, 'utf8')
gyp = gyp
  .replace('"LINK_PLATFORM_MACOSX=1",\n        "ASIO_STANDALONE=1"', '"ASIO_STANDALONE=1"')
  .replace('"AdditionalOptions": [ "/std:c++14" ]', '"AdditionalOptions": [ "/std:c++20" ]')
  .replace(
    '"_WIN32_WINNT=0x0601"\n          ]',
    '"_WIN32_WINNT=0x0601",\n            "NOMINMAX"\n          ],\n          "libraries": [ "ws2_32.lib", "iphlpapi.lib", "winmm.lib" ]',
  )
  .replace('"CLANG_CXX_LANGUAGE_STANDARD": "c++14"', '"CLANG_CXX_LANGUAGE_STANDARD": "c++20"')
  .replaceAll('"-std=c++14"', '"-std=c++20"')
  .replaceAll('10.11', '13.0') // macOS deployment target: Electron 44 itself needs 13 or later
if (gyp.includes('"LINK_PLATFORM_MACOSX=1",\n        "ASIO') || gyp.includes('c++14'))
  throw new Error('binding.gyp patch failed')
writeFileSync(gypPath, gyp)

console.log('Installing build dependencies…')
sh('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--silent'], pkg)

// npm's own node-gyp knows the newest Visual Studio versions; a separately installed one may not.
const npmDir = dirname(dirname(process.env.npm_execpath ?? ''))
const bundledGyp = join(npmDir, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
const gypArgs = ['rebuild', ...process.argv.slice(2).filter((a) => a.startsWith('--arch='))]
console.log('Building (this takes a minute)…')
if (existsSync(bundledGyp))
  execFileSync(process.execPath, [bundledGyp, ...gypArgs], { cwd: pkg, stdio: 'inherit' })
else sh('npx', ['node-gyp', ...gypArgs], pkg)

copyFileSync(join(pkg, 'build', 'Release', 'abletonlink.node'), out)
console.log(`Ableton Link module written to ${out}`)
