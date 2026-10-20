import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_LAYERS_CONFIG,
  DEFAULT_MASTER,
  LAYER_IDS,
  type LayerConfig,
  type LayerId,
  type LayersConfig,
  type MasterSettings,
} from '@shared/layers'
import { isOutputToControl, type LayerShowing } from '@shared/protocol'
import { bridge } from './bridge'

export interface PreviewFrame {
  width: number
  height: number
  pixels: Uint8Array
}

export interface LayersLink {
  config: LayersConfig
  setLayer(id: LayerId, patch: Partial<LayerConfig>): void
  setTakeover(patch: Partial<Pick<LayersConfig, 'takeoverMode' | 'takeoverDim'>>): void
  master: MasterSettings
  setMaster(patch: Partial<MasterSettings>): void
  showing: Record<LayerId, LayerShowing>
  stopLayer(id: LayerId): void
  previewEnabled: boolean
  setPreviewEnabled(enabled: boolean): void
  /** Subscribe to preview frames without re-rendering. */
  onPreview(listener: (frame: PreviewFrame) => void): () => void
}

const NOTHING = Object.fromEntries(
  LAYER_IDS.map((id) => [id, { clipId: null, padId: null }]),
) as Record<LayerId, LayerShowing>

/** Layer mix, master and preview state (owned here, mirrored to the output). */
export function useLayers(): LayersLink {
  const [config, setConfig] = useState<LayersConfig>(DEFAULT_LAYERS_CONFIG)
  const [master, setMasterState] = useState<MasterSettings>(DEFAULT_MASTER)
  const [showing, setShowing] = useState(NOTHING)
  const [previewEnabled, setPreviewState] = useState(true)
  const listeners = useRef(new Set<(f: PreviewFrame) => void>())
  const latest = useRef({ config, master, previewEnabled })
  useEffect(() => {
    latest.current = { config, master, previewEnabled }
  })

  useEffect(() => {
    const push = () => {
      bridge.sendToOutput({ type: 'setLayers', config: latest.current.config })
      bridge.sendToOutput({ type: 'setMaster', master: latest.current.master })
      bridge.sendToOutput({ type: 'setPreview', enabled: latest.current.previewEnabled })
    }
    const off = bridge.onOutputMessage((msg) => {
      if (!isOutputToControl(msg)) return
      if (msg.type === 'layerState') setShowing(msg.layers)
      else if (msg.type === 'previewFrame') for (const l of listeners.current) l(msg)
      else if (msg.type === 'outputReady') push()
    })
    push()
    return off
  }, [])

  const setLayer = useCallback((id: LayerId, patch: Partial<LayerConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, layers: { ...prev.layers, [id]: { ...prev.layers[id], ...patch } } }
      bridge.sendToOutput({ type: 'setLayers', config: next })
      return next
    })
  }, [])

  const setTakeover = useCallback(
    (patch: Partial<Pick<LayersConfig, 'takeoverMode' | 'takeoverDim'>>) => {
      setConfig((prev) => {
        const next = { ...prev, ...patch }
        bridge.sendToOutput({ type: 'setLayers', config: next })
        return next
      })
    },
    [],
  )

  const setMaster = useCallback((patch: Partial<MasterSettings>) => {
    setMasterState((prev) => {
      const next = { ...prev, ...patch }
      bridge.sendToOutput({ type: 'setMaster', master: next })
      return next
    })
  }, [])

  const setPreviewEnabled = useCallback((enabled: boolean) => {
    setPreviewState(enabled)
    bridge.sendToOutput({ type: 'setPreview', enabled })
  }, [])

  const stopLayer = useCallback(
    (id: LayerId) => bridge.sendToOutput({ type: 'stopLayer', layer: id }),
    [],
  )

  const onPreview = useCallback((l: (f: PreviewFrame) => void) => {
    listeners.current.add(l)
    return () => listeners.current.delete(l)
  }, [])

  return {
    config,
    setLayer,
    setTakeover,
    master,
    setMaster,
    showing,
    stopLayer,
    previewEnabled,
    setPreviewEnabled,
    onPreview,
  }
}

/** Backquote (`) toggles blackout, unless typing in a field. */
export function useBlackoutShortcut(layers: LayersLink): void {
  const { setMaster, master } = layers
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName))
      )
        return
      if (e.code !== 'Backquote' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      e.preventDefault()
      setMaster({ blackout: !master.blackout })
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [setMaster, master.blackout])
}
