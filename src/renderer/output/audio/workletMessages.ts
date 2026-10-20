import type { OnsetBand } from '@shared/audio'

/** Messages from the analysis worklet to the output main thread. */
export type WorkletMessage =
  | {
      type: 'onset'
      band: OnsetBand
      strength: number
      /** Seconds between the onset and the end of the block it was detected in. */
      delayS: number
    }
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
