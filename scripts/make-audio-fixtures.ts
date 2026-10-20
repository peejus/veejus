// Writes the synthetic drum patterns as WAV files plus ground-truth JSON into fixtures/audio,
// for the analyze harness and for listening/testing elsewhere.
//
//   npm run fixtures:audio

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PATTERNS, renderPattern } from '../src/core/audio/synth'
import { encodeWav } from '../src/core/audio/wav'

const dir = resolve(import.meta.dirname, '../fixtures/audio')
mkdirSync(dir, { recursive: true })

for (const [name, pattern] of Object.entries(PATTERNS)) {
  const r = renderPattern(pattern, 48000)
  writeFileSync(join(dir, `${name}.wav`), encodeWav([r.samples], r.sampleRate, 16))
  const high = [...r.truth.snare, ...r.truth.hat, ...r.truth.kick]
    .sort((a, b) => a - b)
    .filter((t, i, all) => i === 0 || t - all[i - 1]! > 0.001)
  writeFileSync(
    join(dir, `${name}.truth.json`),
    JSON.stringify({ bpm: pattern.bpm, kick: r.truth.kick, high }, null, 0),
  )
  console.log(`${name}.wav  ${r.durationS.toFixed(1)} s, ${r.truth.kick.length} kicks`)
}
console.log(`Written to ${dir}`)
