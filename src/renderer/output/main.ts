import { FrameStats } from '@core/frameStats'
import { isControlToOutput, type OutputBridge, type Rgb } from '@shared/protocol'
import { rgbToHex } from '@shared/color'
import { Stage } from './stage'

const bridge = (window as unknown as { veejus: OutputBridge }).veejus

const OVERLAY_INTERVAL_MS = 250
const STATS_INTERVAL_MS = 500

const stage = new Stage(document.getElementById('stage') as HTMLCanvasElement)
const overlay = document.getElementById('debug-overlay') as HTMLDivElement
const frameStats = new FrameStats()

let background: Rgb = [0, 0, 0]
let pendingBackgroundAck = false
let frameCount = 0
let lastOverlayAt = 0
let lastStatsAt = 0

bridge.onControlMessage((msg) => {
  if (!isControlToOutput(msg)) return
  switch (msg.type) {
    case 'setBackground':
      background = msg.color
      pendingBackgroundAck = true
      break
    case 'ping':
      bridge.sendToControl({ type: 'pong', id: msg.id })
      break
    case 'setDebugOverlay':
      overlay.hidden = !msg.visible
      break
  }
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') bridge.command({ type: 'exitFullscreen' })
  else if (e.key === 'F11') {
    e.preventDefault()
    bridge.command({ type: 'toggleFullscreen' })
  }
})

function updateOverlay(): void {
  if (overlay.hidden) return
  const s = frameStats.snapshot()
  const { width, height } = stage.size
  overlay.textContent =
    `VEEJUS OUTPUT\n` +
    `fps    ${s.fps.toFixed(1)}\n` +
    `frame  ${s.frameTimeAvgMs.toFixed(2)} ms avg / ${s.frameTimeMaxMs.toFixed(2)} ms max\n` +
    `drops  ${s.droppedFrames} (last 1s)\n` +
    `size   ${width}x${height}\n` +
    `bg     ${rgbToHex(background)}`
}

function frame(now: number): void {
  frameStats.push(now)
  frameCount++
  stage.draw(background)

  if (pendingBackgroundAck) {
    pendingBackgroundAck = false
    bridge.sendToControl({ type: 'backgroundApplied', color: background })
  }
  if (now - lastOverlayAt >= OVERLAY_INTERVAL_MS) {
    lastOverlayAt = now
    updateOverlay()
  }
  if (now - lastStatsAt >= STATS_INTERVAL_MS) {
    lastStatsAt = now
    bridge.sendToControl({ type: 'frameStats', stats: frameStats.snapshot() })
  }
  requestAnimationFrame(frame)
}

// Read-only hook for end-to-end tests.
;(window as unknown as { __veejusOutput: unknown }).__veejusOutput = {
  getState: () => ({ background, frameCount, overlayVisible: !overlay.hidden }),
}

requestAnimationFrame(frame)
bridge.sendToControl({ type: 'outputReady' })
