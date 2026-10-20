import { AudioAnalyzer, type Onset } from './analyzer'
import type { AnalysisSettings, OnsetBand } from '@shared/audio'

export interface OnsetScore {
  truth: number
  detected: number
  hits: number
  misses: number
  falsePositives: number
  recall: number
  /** False positives as a fraction of detections. */
  falsePositiveRate: number
  /** Mean and worst (detected - true) time offset of hits, ms. */
  meanOffsetMs: number
  maxAbsOffsetMs: number
}

/**
 * Match detected onset times to ground-truth times (both sorted, seconds). Each truth onset
 * matches at most one detection within `toleranceS`.
 */
export function scoreOnsets(detected: number[], truth: number[], toleranceS = 0.015): OnsetScore {
  let i = 0
  let j = 0
  let hits = 0
  let offsetSum = 0
  let maxAbs = 0
  while (i < detected.length && j < truth.length) {
    const d = detected[i]! - truth[j]!
    if (Math.abs(d) <= toleranceS) {
      hits++
      offsetSum += d
      maxAbs = Math.max(maxAbs, Math.abs(d))
      i++
      j++
    } else if (d < 0) i++
    else j++
  }
  const falsePositives = detected.length - hits
  return {
    truth: truth.length,
    detected: detected.length,
    hits,
    misses: truth.length - hits,
    falsePositives,
    recall: truth.length ? hits / truth.length : 1,
    falsePositiveRate: detected.length ? falsePositives / detected.length : 0,
    meanOffsetMs: hits ? (offsetSum / hits) * 1000 : 0,
    maxAbsOffsetMs: maxAbs * 1000,
  }
}

export interface OfflineAnalysis {
  onsets: Record<OnsetBand, Onset[]>
  /** Band envelope values per frame (frames x bands). */
  bandFrames: Float32Array[]
  frameTimes: number[]
  maxPeak: number
}

/** Run the analyzer over a whole buffer, optionally in fixed-size blocks like the live engine. */
export function analyzeOffline(
  samples: Float32Array,
  sampleRate: number,
  settings: AnalysisSettings,
  blockSize = 128,
): OfflineAnalysis {
  const analyzer = new AudioAnalyzer(sampleRate, settings)
  const result: OfflineAnalysis = {
    onsets: { low: [], high: [] },
    bandFrames: [],
    frameTimes: [],
    maxPeak: 0,
  }
  for (let start = 0; start < samples.length; start += blockSize) {
    analyzer.process(samples.subarray(start, Math.min(samples.length, start + blockSize)), (f) => {
      for (const o of f.onsets) result.onsets[o.band].push(o)
      result.bandFrames.push(Float32Array.from(f.bands))
      result.frameTimes.push(f.time)
      result.maxPeak = Math.max(result.maxPeak, f.peak)
    })
  }
  return result
}
