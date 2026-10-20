import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isOutputToControl,
  type ControlToOutput,
  type FrameStatsSnapshot,
  type OutputWindowState,
  type Rgb,
} from '@shared/protocol'
import { bridge, request } from './bridge'

const PING_INTERVAL_MS = 1000

export interface OutputLink {
  connected: boolean
  state: OutputWindowState
  stats: FrameStatsSnapshot | null
  /** Last control -> output -> control round trip, in ms. */
  pingMs: number | null
  /** Time from sending a background color until the output drew it, in ms. */
  backgroundLatencyMs: number | null
  send(msg: ControlToOutput): void
  setBackground(color: Rgb): void
}

/** Keeps a live link to the output window: state, frame stats and latency measurements. */
export function useOutputLink(): OutputLink {
  const [connected, setConnected] = useState(false)
  const [state, setState] = useState<OutputWindowState>({
    displayId: null,
    fullscreen: false,
    visible: false,
  })
  const [stats, setStats] = useState<FrameStatsSnapshot | null>(null)
  const [pingMs, setPingMs] = useState<number | null>(null)
  const [backgroundLatencyMs, setBackgroundLatencyMs] = useState<number | null>(null)

  const pings = useRef(new Map<number, number>())
  const nextPingId = useRef(1)
  const backgroundSentAt = useRef<number | null>(null)

  useEffect(() => {
    const offMsg = bridge.onOutputMessage((msg) => {
      if (!isOutputToControl(msg)) return
      switch (msg.type) {
        case 'outputReady':
          setConnected(true)
          break
        case 'pong': {
          const sentAt = pings.current.get(msg.id)
          if (sentAt !== undefined) {
            pings.current.delete(msg.id)
            setPingMs(performance.now() - sentAt)
            setConnected(true)
          }
          break
        }
        case 'frameStats':
          setStats(msg.stats)
          setConnected(true)
          break
        case 'backgroundApplied':
          if (backgroundSentAt.current !== null) {
            setBackgroundLatencyMs(performance.now() - backgroundSentAt.current)
            backgroundSentAt.current = null
          }
          break
      }
    })
    const offState = bridge.onOutputState(setState)
    request({ type: 'getOutputState' }, 'outputState')
      .then((res) => setState(res.state))
      .catch(console.error)

    const ping = () => {
      const id = nextPingId.current++
      pings.current.set(id, performance.now())
      // Forget pings that never came back so the map cannot grow.
      for (const [oldId, t] of pings.current) {
        if (performance.now() - t > 5000) pings.current.delete(oldId)
      }
      bridge.sendToOutput({ type: 'ping', id })
    }
    ping()
    const timer = setInterval(ping, PING_INTERVAL_MS)

    return () => {
      offMsg()
      offState()
      clearInterval(timer)
    }
  }, [])

  const send = useCallback((msg: ControlToOutput) => bridge.sendToOutput(msg), [])
  const setBackground = useCallback((color: Rgb) => {
    backgroundSentAt.current = performance.now()
    bridge.sendToOutput({ type: 'setBackground', color })
  }, [])

  return { connected, state, stats, pingMs, backgroundLatencyMs, send, setBackground }
}
