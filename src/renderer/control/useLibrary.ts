import { useCallback, useEffect, useRef, useState } from 'react'
import { isOutputToControl, type ClipInfo, type ClipLoadState } from '@shared/protocol'
import { bridge, request } from './bridge'
import { ProbeQueue, type ProbeResult } from './probe'

export interface LastStart {
  id: string
  waitFrames: number
  /** Time from sending playClip until the output reported the first drawn frame. */
  latencyMs: number | null
}

export interface LibraryState {
  clips: ClipInfo[]
  probes: Record<string, ProbeResult>
  outputStates: Record<string, { state: ClipLoadState; error?: string }>
  playingId: string | null
  lastStart: LastStart | null
  /** Record that a play request was just sent, for latency measurement. */
  markPlayRequested(id: string): void
  remove(ids: string[]): void
}

/** Library contents (from main), probe results (thumbnails/meta) and output-side load states. */
export function useLibrary(): LibraryState {
  const [clips, setClips] = useState<ClipInfo[]>([])
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({})
  const [outputStates, setOutputStates] = useState<LibraryState['outputStates']>({})
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [lastStart, setLastStart] = useState<LastStart | null>(null)
  const playRequestedAt = useRef(new Map<string, number>())

  const [queue] = useState(
    () => new ProbeQueue((id, result) => setProbes((prev) => ({ ...prev, [id]: result }))),
  )

  useEffect(() => {
    const applyLibrary = (next: ClipInfo[]) => {
      setClips(next)
      const ids = new Set(next.map((c) => c.id))
      // Drop probe results (and their thumbnail URLs) for removed clips.
      setProbes((prev) => {
        const kept: Record<string, ProbeResult> = {}
        for (const [id, r] of Object.entries(prev)) {
          if (ids.has(id)) kept[id] = r
          else {
            queue.forget(id)
            if (r.ok) URL.revokeObjectURL(r.meta.thumbUrl)
          }
        }
        return kept
      })
      queue.enqueue(next)
    }

    const offLib = bridge.onLibrary(applyLibrary)
    const offMsg = bridge.onOutputMessage((msg) => {
      if (!isOutputToControl(msg)) return
      switch (msg.type) {
        case 'clipState':
          setOutputStates((prev) => ({
            ...prev,
            [msg.id]: { state: msg.state, ...(msg.error ? { error: msg.error } : {}) },
          }))
          break
        case 'clipStarted': {
          const sentAt = playRequestedAt.current.get(msg.id)
          playRequestedAt.current.delete(msg.id)
          setPlayingId(msg.id)
          setLastStart({
            id: msg.id,
            waitFrames: msg.waitFrames,
            latencyMs: sentAt !== undefined ? performance.now() - sentAt : null,
          })
          break
        }
        case 'clipEnded':
          setPlayingId((cur) => (cur === msg.id ? null : cur))
          break
        case 'outputReady':
          bridge.sendToOutput({ type: 'requestStatus' })
          break
      }
    })

    request({ type: 'getLibrary' }, 'library')
      .then((res) => applyLibrary(res.clips))
      .catch(console.error)
    bridge.sendToOutput({ type: 'requestStatus' })

    return () => {
      offLib()
      offMsg()
    }
  }, [queue])

  const markPlayRequested = useCallback((id: string) => {
    playRequestedAt.current.set(id, performance.now())
  }, [])

  const remove = useCallback((ids: string[]) => {
    request({ type: 'removeClips', ids }, 'library').catch(console.error)
  }, [])

  return { clips, probes, outputStates, playingId, lastStart, markPlayRequested, remove }
}
