import { DEFAULT_ANALYSIS_SETTINGS, type AnalysisSettings } from '@shared/audio'
import {
  DEFAULT_BEAT_SETTINGS,
  type BeatCommand,
  type BeatEvent,
  type BeatSettings,
} from '@shared/beat'
import { AudioAnalyzer, HOP_SIZE } from '../audio/analyzer'
import { BeatEngine } from './beatEngine'

/**
 * Runs audio through the analyzer and the beat engine the way the live app does, in simulated
 * time: 128-sample audio blocks, flux delivered to the engine in batches of 8 hops with
 * message-delivery jitter, and the clock updated at 60 fps. Used by tests and the harness.
 */

export interface SimulationOptions {
  analysis?: AnalysisSettings
  beat?: BeatSettings
  /** performance.now() at analysis time 0. */
  startMs?: number
  /** Max random message delay, ms. */
  jitterMs?: number
  frameMs?: number
  /** Commands to issue at given analysis-relative times (ms). */
  commands?: { atMs: number; command: BeatCommand }[]
  /** Called every simulated frame. */
  onFrame?: (engine: BeatEngine, nowMs: number) => void
  seed?: number
}

export interface SimulationResult {
  beats: BeatEvent[]
  /** Engine tempo sampled every 0.5 s: [time since start (s), bpm]. */
  bpmTrace: [number, number][]
  engine: BeatEngine
  startMs: number
}

const BATCH_HOPS = 8
const BLOCK = 128

export function simulateBeatTracking(
  samples: Float32Array,
  sampleRate: number,
  opts: SimulationOptions = {},
): SimulationResult {
  const startMs = opts.startMs ?? 10_000
  const jitter = opts.jitterMs ?? 3
  const frameMs = opts.frameMs ?? 1000 / 60
  let seed = opts.seed ?? 7
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }

  const analyzer = new AudioAnalyzer(sampleRate, opts.analysis ?? DEFAULT_ANALYSIS_SETTINGS)
  const engine = new BeatEngine(HOP_SIZE / sampleRate, startMs, opts.beat ?? DEFAULT_BEAT_SETTINGS)
  const commands = [...(opts.commands ?? [])].sort((a, b) => a.atMs - b.atMs)

  // Messages produced by the audio thread, delivered at `deliverAt`.
  type Msg = { deliverAt: number; apply: () => void }
  const queue: Msg[] = []
  let hops = 0
  let batchLow: number[] = []
  let batchHigh: number[] = []

  const beats: BeatEvent[] = []
  const bpmTrace: [number, number][] = []
  let nextFrame = startMs
  let nextTrace = 0

  const runUntil = (perfMs: number) => {
    while (nextFrame <= perfMs) {
      queue.sort((a, b) => a.deliverAt - b.deliverAt)
      while (queue.length && queue[0]!.deliverAt <= nextFrame) queue.shift()!.apply()
      while (commands.length && startMs + commands[0]!.atMs <= nextFrame) {
        engine.command(commands.shift()!.command, nextFrame)
      }
      beats.push(...engine.update(nextFrame))
      opts.onFrame?.(engine, nextFrame)
      const t = (nextFrame - startMs) / 1000
      if (t >= nextTrace) {
        bpmTrace.push([t, engine.bpm])
        nextTrace += 0.5
      }
      nextFrame += frameMs
    }
  }

  for (let start = 0; start < samples.length; start += BLOCK) {
    const block = samples.subarray(start, Math.min(samples.length, start + BLOCK))
    const blockEndS = (start + block.length) / sampleRate
    const deliverAt = startMs + blockEndS * 1000 + rand() * jitter
    analyzer.process(block, (f) => {
      for (const o of f.onsets) {
        const { band, time, strength, flux } = o
        queue.push({ deliverAt, apply: () => engine.pushOnset(band, time, strength, flux) })
      }
      batchLow.push(f.flux.low)
      batchHigh.push(f.flux.high)
      if (++hops % BATCH_HOPS === 0) {
        const low = batchLow
        const high = batchHigh
        batchLow = []
        batchHigh = []
        queue.push({
          deliverAt,
          apply: () => {
            engine.observeSync(blockEndS, deliverAt)
            for (let i = 0; i < low.length; i++) engine.pushFlux(low[i]!, high[i]!)
          },
        })
      }
    })
    runUntil(startMs + blockEndS * 1000)
  }
  runUntil(startMs + (samples.length / sampleRate) * 1000 + 50)
  return { beats, bpmTrace, engine, startMs }
}

/**
 * Score beat events against true beat times (seconds from audio start). Only beats after
 * `fromS` count. Returns the fraction of true beats with an event within `tolMs`, plus timing.
 */
export function scoreBeats(result: SimulationResult, truthS: number[], fromS: number, tolMs = 15) {
  const eventTimes = result.beats.map((b) => (b.atMs - result.startMs) / 1000)
  const truth = truthS.filter((t) => t >= fromS && t <= eventTimes[eventTimes.length - 1]!)
  let hits = 0
  let worst = 0
  let sum = 0
  for (const t of truth) {
    let best = Infinity
    for (const e of eventTimes) if (Math.abs(e - t) < Math.abs(best)) best = e - t
    if (Math.abs(best) * 1000 <= tolMs) {
      hits++
      sum += best * 1000
      worst = Math.max(worst, Math.abs(best) * 1000)
    }
  }
  const extra = eventTimes.filter(
    (e) => e >= fromS && !truth.some((t) => Math.abs(e - t) * 1000 <= tolMs),
  ).length
  return {
    truth: truth.length,
    hits,
    recall: truth.length ? hits / truth.length : 1,
    extraBeats: extra,
    meanErrorMs: hits ? sum / hits : 0,
    worstErrorMs: worst,
  }
}
