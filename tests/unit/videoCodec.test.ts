import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hardwareDecodeFor, readAppSettings, writeAppSettings } from '../../src/main/appSettings'
import {
  readVideoCodec,
  videoCodecInMoov,
  videoCodecProblem,
  type ReadBytes,
} from '../../src/shared/videoCodec'

const FIXTURES = resolve(__dirname, '../../fixtures')

function fileReader(path: string): { read: ReadBytes; size: number; reads: number[] } {
  const buf = new Uint8Array(readFileSync(path))
  const reads: number[] = []
  return {
    size: buf.length,
    reads,
    read: async (offset, length) => {
      reads.push(length)
      return buf.subarray(offset, offset + length)
    },
  }
}

const codecOf = async (path: string) => {
  const f = fileReader(path)
  return readVideoCodec(f.read, f.size)
}

/** A box: 32-bit size, type, contents. */
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(8 + body)
  new DataView(out.buffer).setUint32(0, 8 + body)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  let at = 8
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))
const zeros = (n: number) => new Uint8Array(n)
/** hdlr: version/flags, pre_defined, handler type. */
const hdlr = (handler: string) => box('hdlr', zeros(8), bytes(handler), zeros(12))
/** stsd: version/flags, count 1, then one entry of the given type. */
const stsd = (entry: string) =>
  box('stsd', zeros(4), Uint8Array.of(0, 0, 0, 1), box(entry, zeros(8)))
const trak = (handler: string, entry: string) =>
  box('trak', box('mdia', hdlr(handler), box('minf', box('stbl', stsd(entry)))))

describe('video codec from the file header', () => {
  it('finds the video track, skipping an audio track before it', () => {
    const moov = box('moov', trak('soun', 'mp4a'), trak('vide', 'hvc1'))
    expect(videoCodecInMoov(moov.subarray(8))).toBe('hvc1')
  })

  it('returns null with no video track, or for a broken header', () => {
    expect(videoCodecInMoov(box('moov', trak('soun', 'mp4a')).subarray(8))).toBeNull()
    expect(videoCodecInMoov(Uint8Array.of(0, 0, 0, 99, 1, 2))).toBeNull()
  })

  it('reads real files, with the header at the end, without reading the media', async () => {
    expect(await codecOf(join(FIXTURES, 'codecs/hevc-audio.mov'))).toBe('hvc1')
    expect(await codecOf(join(FIXTURES, 'media/countdown.mp4'))).toBe('avc1')
    expect(await codecOf(join(FIXTURES, 'media/prores.mov'))).toBe('ap4h')
    const f = fileReader(join(FIXTURES, 'codecs/hevc-audio.mov'))
    await readVideoCodec(f.read, f.size)
    // Box headers plus the moov itself: far less than the whole file.
    expect(f.reads.reduce((a, b) => a + b, 0)).toBeLessThan(f.size / 4)
  })

  it('gives up on files that are not MP4/MOV', async () => {
    expect(await codecOf(join(FIXTURES, 'media/corrupt.mp4'))).toBeNull()
    expect(await codecOf(join(FIXTURES, 'media/alpha-ball.webm'))).toBeNull()
  })

  it('explains HEVC and ProRes, and nothing else', () => {
    expect(videoCodecProblem('hvc1')).toMatch(/HEVC.*hardware decoding.*H\.264/)
    expect(videoCodecProblem('hev1')).toMatch(/HEVC/)
    expect(videoCodecProblem('apcn')).toMatch(/ProRes/)
    expect(videoCodecProblem('avc1')).toBeNull()
    expect(videoCodecProblem(null)).toBeNull()
  })
})

describe('hardware video decoding setting', () => {
  it('is off by default and remembered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'veejus-settings-'))
    expect(readAppSettings(dir)).toEqual({ hardwareVideoDecode: false })
    writeAppSettings(dir, { hardwareVideoDecode: true })
    expect(readAppSettings(dir)).toEqual({ hardwareVideoDecode: true })
  })

  it('VEEJUS_HW_VIDEO_DECODE overrides the saved setting', () => {
    const on = { hardwareVideoDecode: true }
    const off = { hardwareVideoDecode: false }
    expect(hardwareDecodeFor(off, undefined)).toEqual({ on: false, forced: false })
    expect(hardwareDecodeFor(on, undefined)).toEqual({ on: true, forced: false })
    expect(hardwareDecodeFor(off, '1')).toEqual({ on: true, forced: true })
    expect(hardwareDecodeFor(on, '0')).toEqual({ on: false, forced: true })
  })
})
