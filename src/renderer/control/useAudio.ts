import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_ANALYSIS_SETTINGS,
  type AnalysisSettings,
  type AudioDevice,
  type AudioMeters,
  type AudioSource,
  type AudioStatus,
  type OnsetBand,
} from '@shared/audio'
import { isOutputToControl } from '@shared/protocol'
import { bridge } from './bridge'

export type OnsetListener = (band: OnsetBand, strength: number) => void

export interface AudioLink {
  status: AudioStatus
  devices: AudioDevice[]
  settings: AnalysisSettings
  /** Latest meter snapshot. Read from animation frames; it does not trigger renders. */
  meters: React.RefObject<AudioMeters | null>
  setSource(source: AudioSource | null): void
  setSettings(settings: AnalysisSettings): void
  refreshDevices(): void
  /** Subscribe to onsets without re-rendering. Returns an unsubscribe function. */
  onOnset(listener: OnsetListener): () => void
}

/** Audio status, devices and settings as React state; meters and onsets via refs/listeners. */
export function useAudio(): AudioLink {
  const [status, setStatus] = useState<AudioStatus>({ state: 'off', source: null })
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const [settings, setSettingsState] = useState<AnalysisSettings>(DEFAULT_ANALYSIS_SETTINGS)
  const meters = useRef<AudioMeters | null>(null)
  const listeners = useRef(new Set<OnsetListener>())

  useEffect(() => {
    const off = bridge.onOutputMessage((msg) => {
      if (!isOutputToControl(msg)) return
      switch (msg.type) {
        case 'audioStatus':
          setStatus(msg.status)
          if (msg.status.state !== 'running') meters.current = null
          break
        case 'audioDevices':
          setDevices(msg.devices)
          break
        case 'audioMeters':
          meters.current = msg.meters
          break
        case 'audioOnset':
          for (const l of listeners.current) l(msg.band, msg.strength)
          break
        case 'outputReady':
          bridge.sendToOutput({ type: 'requestAudioDevices' })
          break
      }
    })
    bridge.sendToOutput({ type: 'requestAudioDevices' })
    return off
  }, [])

  const setSource = useCallback((source: AudioSource | null) => {
    bridge.sendToOutput({ type: 'setAudioSource', source })
  }, [])

  const setSettings = useCallback((next: AnalysisSettings) => {
    setSettingsState(next)
    bridge.sendToOutput({ type: 'setAnalysisSettings', settings: next })
  }, [])

  const refreshDevices = useCallback(() => {
    bridge.sendToOutput({ type: 'requestAudioDevices' })
  }, [])

  const onOnset = useCallback((listener: OnsetListener) => {
    listeners.current.add(listener)
    return () => listeners.current.delete(listener)
  }, [])

  return { status, devices, settings, meters, setSource, setSettings, refreshDevices, onOnset }
}
