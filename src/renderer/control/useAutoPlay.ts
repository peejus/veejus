import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_AUTO_PLAY,
  isAutoPlaySettings,
  type AutoPlaySettings,
  type AutoSource,
} from '@shared/autoplay'
import { isOutputToControl, type ClipInfo } from '@shared/protocol'
import { bridge } from './bridge'

const STORAGE_KEY = 'veejus.autoPlay'

export interface AutoPlayLink {
  settings: AutoPlaySettings
  set(patch: Partial<AutoPlaySettings>): void
  setEnabled(enabled: boolean): void
  /** Replace the settings (opening a set). */
  load(settings: AutoPlaySettings): void
}

function stored(): AutoPlaySettings {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    // Remembered settings, but never switched on by itself: a set (or the restored session)
    // decides that.
    if (isAutoPlaySettings(v)) return { ...v, enabled: false }
  } catch {
    // Fall through to the defaults.
  }
  return { ...DEFAULT_AUTO_PLAY }
}

/** Clips an auto-play source covers (the output applies the same rule). */
export function autoClips(clips: readonly ClipInfo[], source: AutoSource): ClipInfo[] {
  return clips.filter((c) => {
    switch (source.kind) {
      case 'images':
        return c.kind === 'image'
      case 'videos':
        return c.kind === 'video'
      case 'all':
        return true
      case 'collection':
        return c.tags.includes(source.tag)
      case 'favorites':
        return c.favorite
    }
  })
}

/** Auto-play settings, owned here and mirrored to the output (which does the stepping). */
export function useAutoPlay(): AutoPlayLink {
  const [settings, setSettings] = useState<AutoPlaySettings>(stored)
  const latest = useRef(settings)

  const apply = useCallback((next: AutoPlaySettings) => {
    latest.current = next
    setSettings(next)
    bridge.sendToOutput({ type: 'setAutoPlay', settings: next })
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Not remembered between runs; the set still has it.
    }
  }, [])

  useEffect(() => {
    const off = bridge.onOutputMessage((msg) => {
      if (!isOutputToControl(msg)) return
      if (msg.type === 'outputReady')
        bridge.sendToOutput({ type: 'setAutoPlay', settings: latest.current })
      else if (msg.type === 'autoPlayStopped' && latest.current.enabled) {
        // Stop all (Esc), or stopping its layer, switched it off in the output.
        const next = { ...latest.current, enabled: false }
        latest.current = next
        setSettings(next)
      }
    })
    bridge.sendToOutput({ type: 'setAutoPlay', settings: latest.current })
    return off
  }, [])

  const set = useCallback(
    (patch: Partial<AutoPlaySettings>) => apply({ ...latest.current, ...patch }),
    [apply],
  )
  const setEnabled = useCallback((enabled: boolean) => set({ enabled }), [set])

  return { settings, set, setEnabled, load: apply }
}
