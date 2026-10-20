// Offline analysis harness: runs the same analyzer as the live engine over an audio file.
//
//   npm run analyze -- <file> [--truth truth.json] [--csv out.csv] [--gain dB]
//                             [--kick-sensitivity 0..1] [--high-sensitivity 0..1]
//
// WAV files are read directly; anything else (MP3, FLAC, AAC, ...) is decoded with ffmpeg.
// A truth file is JSON { "kick": [seconds...], "high": [seconds...] } (as written by
// `npm run fixtures:audio`); with one, the harness scores detection accuracy.

import { readFileSync, writeFileSync } from 'node:fs'
import { extname } from 'node:path'
import { DEFAULT_ANALYSIS_SETTINGS, type AnalysisSettings } from '../src/shared/audio'
import { analyzeOffline, scoreOnsets } from '../src/core/audio/evaluate'
import { decodeWav, mixToMono } from '../src/core/audio/wav'
import { decodeWithFfmpeg, findFfmpeg } from './ffmpeg'

const SAMPLE_RATE = 48000

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const file = process.argv
  .slice(2)
  .find((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'))
if (!file) {
  console.error('Usage: npm run analyze -- <audio file> [--truth truth.json] [--csv out.csv]')
  process.exit(1)
}

let samples: Float32Array
let sampleRate: number
if (extname(file).toLowerCase() === '.wav') {
  const wav = decodeWav(readFileSync(file))
  samples = mixToMono(wav.channels)
  sampleRate = wav.sampleRate
} else {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) {
    console.error('This format needs ffmpeg (winget install Gyan.FFmpeg), or convert to WAV first.')
    process.exit(1)
  }
  samples = decodeWithFfmpeg(ffmpeg, file, SAMPLE_RATE)
  sampleRate = SAMPLE_RATE
}

const settings: AnalysisSettings = {
  ...DEFAULT_ANALYSIS_SETTINGS,
  inputGainDb: Number(arg('--gain') ?? 0),
  kickSensitivity: Number(arg('--kick-sensitivity') ?? DEFAULT_ANALYSIS_SETTINGS.kickSensitivity),
  highSensitivity: Number(arg('--high-sensitivity') ?? DEFAULT_ANALYSIS_SETTINGS.highSensitivity),
}

const started = performance.now()
const result = analyzeOffline(samples, sampleRate, settings)
const elapsedMs = performance.now() - started
const durationS = samples.length / sampleRate
const kicks = result.onsets.low.map((o) => o.time)
const highs = result.onsets.high.map((o) => o.time)

/** Rough tempo from the median kick interval, folded into 80-180 BPM. */
function roughBpm(times: number[]): number | null {
  const gaps = times
    .slice(1)
    .map((t, i) => t - times[i]!)
    .filter((g) => g > 0.2 && g < 2)
  if (gaps.length < 4) return null
  gaps.sort((a, b) => a - b)
  let bpm = 60 / gaps[gaps.length >> 1]!
  while (bpm < 80) bpm *= 2
  while (bpm > 180) bpm /= 2
  return bpm
}

const peakDb = 20 * Math.log10(result.maxPeak || 1e-9)
const bpm = roughBpm(kicks)
console.log(`File        ${file}`)
console.log(
  `Duration    ${durationS.toFixed(1)} s @ ${sampleRate} Hz, peak ${peakDb.toFixed(1)} dBFS`,
)
console.log(
  `Analyzed    in ${elapsedMs.toFixed(0)} ms (${(durationS / (elapsedMs / 1000)).toFixed(0)}x real time)`,
)
console.log(
  `Kicks       ${kicks.length} (${((kicks.length / durationS) * 60).toFixed(0)}/min)` +
    (bpm ? `, kick spacing suggests ~${bpm.toFixed(1)} BPM` : ''),
)
console.log(`Snare/hat   ${highs.length} (${((highs.length / durationS) * 60).toFixed(0)}/min)`)
console.log(
  `First kicks ${kicks
    .slice(0, 8)
    .map((t) => t.toFixed(3))
    .join('  ')}`,
)

const truthPath = arg('--truth')
if (truthPath) {
  const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as { kick?: number[]; high?: number[] }
  for (const [name, detected, expected] of [
    ['Kick', kicks, truth.kick],
    ['Snare/hat', highs, truth.high],
  ] as const) {
    if (!expected) continue
    const s = scoreOnsets(detected, expected, 0.015)
    console.log(
      `${name.padEnd(11)} recall ${(s.recall * 100).toFixed(1)}%, false positives ` +
        `${(s.falsePositiveRate * 100).toFixed(1)}%, timing ${s.meanOffsetMs.toFixed(1)} ms mean / ` +
        `${s.maxAbsOffsetMs.toFixed(1)} ms worst (+-15 ms window)`,
    )
  }
}

const csv = arg('--csv')
if (csv) {
  const rows = [
    'time_s,band,strength',
    ...[...result.onsets.low, ...result.onsets.high]
      .sort((a, b) => a.time - b.time)
      .map(
        (o) =>
          `${o.time.toFixed(4)},${o.band === 'low' ? 'kick' : 'snare_hat'},${o.strength.toFixed(3)}`,
      ),
  ]
  writeFileSync(csv, rows.join('\n') + '\n')
  console.log(`Onsets written to ${csv}`)
}
