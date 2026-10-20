import type { OnsetBand } from '@shared/audio'

/** Messages from the analysis worklet to the output main thread. */
export type WorkletMessage =
  | {
      type: 'onset'
      band: OnsetBand
      strength: number
      /** Raw flux at the onset. */
      flux: number
      /** Onset time in analysis seconds. */
      time: number
      /** Seconds between the onset and the end of the block it was detected in. */
      delayS: number
    }
  /** Onset-strength signal for tempo tracking, one value per hop, in batches. */
  | { type: 'flux'; low: number[]; high: number[]; endTime: number }
  | { type: 'bands'; bands: number[]; rms: number }
  | {
      type: 'meters'
      bands: number[]
      rms: number
      peak: number
      clipped: boolean
      spectrum: number[]
      latencyMs: number
    }
