// Packages Veejus for macOS from any OS, as dist/Veejus-<version>-mac-<arch>.zip.
//
//   npm run dist:mac-zip                 both Apple silicon (arm64) and Intel (x64)
//   npm run dist:mac-zip -- --arch=arm64 just one
//
// electron-builder only builds macOS apps on a Mac (npm run dist:mac gives a .dmg there). This
// script needs no Mac: it takes the official macOS Electron zip and rewrites it into
// Veejus.app, copying every entry byte for byte so the framework symlinks and executable bits
// survive (unpacking on Windows would lose both). It can't code-sign, so on the Mac the app is
// re-signed ad hoc once after unzipping (see README, "Installing (macOS)"). The Ableton Link
// module is native code and isn't included; build it on the Mac with npm run build:link.

import { createPackage } from '@electron/asar'
import { downloadArtifact } from '@electron/get'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'
import plist from 'plist'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const electronVersion = JSON.parse(
  readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version
const archArg = process.argv.find((a) => a.startsWith('--arch='))?.slice('--arch='.length)
const arches = archArg ? [archArg] : ['arm64', 'x64']

const APP = 'Veejus.app'
const NAME = 'Veejus'
const APP_ID = 'com.veejus.app'

/** The app's code as an asar archive: the built out/ folder and a trimmed package.json. */
async function buildAsar() {
  const stage = join(tmpdir(), `veejus-mac-${process.pid}`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  cpSync(join(root, 'out'), join(stage, 'out'), { recursive: true })
  const { name, version, description, main, author, license } = pkg
  const appPkg = { name, productName: NAME, version, description, main, author, license }
  writeFileSync(join(stage, 'package.json'), JSON.stringify(appPkg, null, 2))
  const asar = `${stage}.asar`
  await createPackage(stage, asar)
  rmSync(stage, { recursive: true, force: true })
  const data = readFileSync(asar)
  rmSync(asar, { force: true })
  return data
}

/** An .icns holding the 512 px PNG (macOS scales it for smaller sizes). */
function buildIcns() {
  const png = readFileSync(join(root, 'build', 'icon.png'))
  const chunk = (type) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([head, png])
  }
  const body = Buffer.concat([chunk('ic09'), chunk('ic14')]) // 512x512 and 256x256@2x
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

function patchInfoPlist(xml) {
  const info = plist.parse(xml.toString('utf8'))
  Object.assign(info, {
    CFBundleName: NAME,
    CFBundleDisplayName: NAME,
    CFBundleIdentifier: APP_ID,
    CFBundleShortVersionString: pkg.version,
    CFBundleVersion: pkg.version,
    LSApplicationCategoryType: 'public.app-category.entertainment',
    NSMicrophoneUsageDescription: 'Veejus listens to your audio input to find the beat.',
    NSLocalNetworkUsageDescription:
      'Veejus uses the local network to sync tempo with Ableton Link.',
    NSBonjourServices: ['_ableton-link._udp'],
    NSHighResolutionCapable: true,
  })
  return Buffer.from(plist.build(info))
}

// ---- Minimal zip reading and writing (no zip64; Electron's zips don't need it) ----

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_END = 0x06054b50

function readCentralDirectory(zip) {
  let end = zip.length - 22
  while (end >= 0 && zip.readUInt32LE(end) !== SIG_END) end--
  if (end < 0) throw new Error('Not a zip file')
  const count = zip.readUInt16LE(end + 10)
  let p = zip.readUInt32LE(end + 16)
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 archives are not supported')
  const entries = []
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('Corrupt central directory')
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const local = zip.readUInt32LE(p + 42)
    const localNameLen = zip.readUInt16LE(local + 26)
    const localExtraLen = zip.readUInt16LE(local + 28)
    const compressedSize = zip.readUInt32LE(p + 20)
    const dataStart = local + 30 + localNameLen + localExtraLen
    entries.push({
      name: zip.toString('utf8', p + 46, p + 46 + nameLen),
      madeBy: zip.readUInt16LE(p + 4),
      needed: zip.readUInt16LE(p + 6),
      flags: zip.readUInt16LE(p + 8) & ~0x0008, // sizes go in the header, not a descriptor
      method: zip.readUInt16LE(p + 10),
      time: zip.readUInt16LE(p + 12),
      date: zip.readUInt16LE(p + 14),
      crc: zip.readUInt32LE(p + 16),
      compressedSize,
      size: zip.readUInt32LE(p + 24),
      externalAttrs: zip.readUInt32LE(p + 38),
      data: zip.subarray(dataStart, dataStart + compressedSize),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** A new regular file entry (mode 644), deflated. */
function fileEntry(name, content, like) {
  const data = deflateRawSync(content, { level: 9 })
  return {
    name,
    madeBy: (3 << 8) | 30, // Unix, zip 3.0: the mode in externalAttrs is honoured
    needed: 20,
    flags: 0x0800,
    method: 8,
    time: like.time,
    date: like.date,
    crc: crc32(content),
    compressedSize: data.length,
    size: content.length,
    externalAttrs: (0o100644 << 16) >>> 0,
    data,
  }
}

function writeZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(e.needed, 4)
    local.writeUInt16LE(e.flags | 0x0800, 6)
    local.writeUInt16LE(e.method, 8)
    local.writeUInt16LE(e.time, 10)
    local.writeUInt16LE(e.date, 12)
    local.writeUInt32LE(e.crc, 14)
    local.writeUInt32LE(e.compressedSize, 18)
    local.writeUInt32LE(e.size, 22)
    local.writeUInt16LE(name.length, 26)
    chunks.push(local, name, e.data)

    const c = Buffer.alloc(46)
    c.writeUInt32LE(SIG_CENTRAL, 0)
    c.writeUInt16LE(e.madeBy, 4)
    c.writeUInt16LE(e.needed, 6)
    c.writeUInt16LE(e.flags | 0x0800, 8)
    c.writeUInt16LE(e.method, 10)
    c.writeUInt16LE(e.time, 12)
    c.writeUInt16LE(e.date, 14)
    c.writeUInt32LE(e.crc, 16)
    c.writeUInt32LE(e.compressedSize, 20)
    c.writeUInt32LE(e.size, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt32LE(e.externalAttrs >>> 0, 38)
    c.writeUInt32LE(offset, 42)
    central.push(c, name)
    offset += 30 + name.length + e.data.length
    if (offset > 0xffffffff) throw new Error('Archive too large for a non-zip64 zip')
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(SIG_END, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, ...central, end])
}

const inflate = (entry) => (entry.method === 0 ? entry.data : inflateRawSync(entry.data))

// ---- Build ----

const asar = await buildAsar()
const icns = buildIcns()
mkdirSync(join(root, 'dist'), { recursive: true })

for (const arch of arches) {
  console.log(`Fetching Electron ${electronVersion} for macOS ${arch}…`)
  const electronZip = await downloadArtifact({
    version: electronVersion,
    platform: 'darwin',
    arch,
    artifactName: 'electron',
  })
  const source = readCentralDirectory(readFileSync(electronZip))
  const out = []
  let infoPlist = null
  for (const e of source) {
    if (!e.name.startsWith('Electron.app/')) {
      // LICENSE and LICENSES.chromium.html travel next to the app; "version" isn't needed.
      if (e.name.startsWith('LICENSE')) out.push(e)
      continue
    }
    const name = APP + e.name.slice('Electron.app'.length)
    if (name === `${APP}/Contents/Resources/default_app.asar`) continue
    if (name === `${APP}/Contents/Info.plist`) {
      infoPlist = fileEntry(name, patchInfoPlist(inflate(e)), e)
      out.push(infoPlist)
    } else if (name === `${APP}/Contents/Resources/electron.icns`) {
      out.push(fileEntry(name, icns, e))
    } else {
      out.push({ ...e, name })
    }
  }
  if (!infoPlist) throw new Error('Electron.app/Contents/Info.plist not found in the Electron zip')
  out.push(fileEntry(`${APP}/Contents/Resources/app.asar`, asar, infoPlist))

  const target = join(root, 'dist', `Veejus-${pkg.version}-mac-${arch}.zip`)
  writeFileSync(target, writeZip(out))
  console.log(`Wrote ${target}`)
}
