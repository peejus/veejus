import { useEffect, useState } from 'react'
import type { VideoDecodeState } from '@shared/protocol'
import { request } from './bridge'

/**
 * Hardware video decoding (Setup → Diagnostics). Off by default because it can hitch the
 * output as clips preload, but HEVC (H.265) videos only play with it on. Chromium reads it at
 * startup, so a change applies after a restart.
 */
export function VideoDecodeSetting() {
  const [state, setState] = useState<VideoDecodeState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    request({ type: 'getVideoDecode' }, 'videoDecode')
      .then((r) => live && setState(r.state))
      .catch((e: unknown) => live && setError(String(e)))
    return () => {
      live = false
    }
  }, [])

  if (!state) return error ? <p className="error-text">{error}</p> : null

  const set = (hardware: boolean) => {
    // Show the change at once; main's answer confirms it (or puts it back if saving failed).
    const before = state
    setState({ ...state, saved: hardware })
    request({ type: 'setVideoDecode', hardware }, 'videoDecode')
      .then((r) => setState(r.state))
      .catch((e: unknown) => {
        setState(before)
        setError(String(e))
      })
  }
  const pending = !state.forced && state.saved !== state.active

  return (
    <div className="video-decode" data-testid="video-decode">
      <label className="check">
        <input
          type="checkbox"
          checked={state.forced ? state.active : state.saved}
          disabled={state.forced}
          onChange={(e) => set(e.target.checked)}
        />{' '}
        Hardware video decoding
      </label>
      <p className="hint">
        Needed for HEVC (H.265) videos, such as iPhone footage. It can cause small hitches on the
        output as videos load, so leave it off if your videos are H.264.
      </p>
      {state.forced && (
        <p className="hint" data-testid="video-decode-forced">
          Set by VEEJUS_HW_VIDEO_DECODE for this run ({state.active ? 'on' : 'off'}).
        </p>
      )}
      {pending && (
        <p className="hint" data-testid="video-decode-pending">
          {state.saved ? 'Turns on' : 'Turns off'} when Veejus restarts.{' '}
          <button
            type="button"
            onClick={() => {
              void request({ type: 'relaunch' }, 'ok').catch((e: unknown) => setError(String(e)))
            }}
          >
            Restart now
          </button>
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
