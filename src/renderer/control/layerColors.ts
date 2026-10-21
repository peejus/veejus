import type { LayerId } from '@shared/layers'

/** One color per layer, used wherever a layer is shown. */
export const LAYER_COLORS: Record<LayerId, string> = {
  background: '#4f8cff',
  overlayA: '#ff9f1a',
  overlayB: '#2bd6ff',
  takeover: '#b46bff',
}
