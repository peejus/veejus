import { describe, expect, it } from 'vitest'
import {
  isControlToOutput,
  isMainRequest,
  isOutputCommand,
  isOutputToControl,
  isRgb,
} from '@shared/protocol'
import { hexToRgb, rgbToHex } from '@shared/color'

describe('protocol guards', () => {
  it('accepts well-formed control -> output messages', () => {
    expect(isControlToOutput({ type: 'setBackground', color: [1, 0.5, 0] })).toBe(true)
    expect(isControlToOutput({ type: 'ping', id: 3 })).toBe(true)
    expect(isControlToOutput({ type: 'setDebugOverlay', visible: false })).toBe(true)
  })

  it('rejects malformed control -> output messages', () => {
    expect(isControlToOutput(null)).toBe(false)
    expect(isControlToOutput('ping')).toBe(false)
    expect(isControlToOutput({ type: 'nope' })).toBe(false)
    expect(isControlToOutput({ type: 'setBackground', color: [1, 2, 0] })).toBe(false)
    expect(isControlToOutput({ type: 'setBackground', color: [1, 0] })).toBe(false)
    expect(isControlToOutput({ type: 'setBackground', color: [NaN, 0, 0] })).toBe(false)
    expect(isControlToOutput({ type: 'ping', id: '1' })).toBe(false)
    expect(isControlToOutput({ type: 'setDebugOverlay', visible: 1 })).toBe(false)
  })

  it('validates output -> control messages', () => {
    expect(isOutputToControl({ type: 'outputReady' })).toBe(true)
    expect(isOutputToControl({ type: 'pong', id: 1 })).toBe(true)
    expect(isOutputToControl({ type: 'backgroundApplied', color: [0, 0, 0] })).toBe(true)
    expect(
      isOutputToControl({
        type: 'frameStats',
        stats: { fps: 60, frameTimeAvgMs: 16.7, frameTimeMaxMs: 20, droppedFrames: 0 },
      }),
    ).toBe(true)
    expect(isOutputToControl({ type: 'frameStats', stats: { fps: 60 } })).toBe(false)
  })

  it('validates output commands', () => {
    expect(isOutputCommand({ type: 'exitFullscreen' })).toBe(true)
    expect(isOutputCommand({ type: 'toggleFullscreen' })).toBe(true)
    expect(isOutputCommand({ type: 'closeApp' })).toBe(false)
    expect(isOutputCommand(undefined)).toBe(false)
  })

  it('validates main requests', () => {
    expect(isMainRequest({ type: 'listDisplays' })).toBe(true)
    expect(isMainRequest({ type: 'moveOutputToDisplay', displayId: 2 })).toBe(true)
    expect(isMainRequest({ type: 'moveOutputToDisplay' })).toBe(false)
    expect(isMainRequest({ type: 'setOutputFullscreen', fullscreen: 'yes' })).toBe(false)
    expect(isMainRequest({ type: 'quit' })).toBe(false)
  })
})

describe('color helpers', () => {
  it('round-trips hex colors', () => {
    for (const hex of ['#000000', '#ffffff', '#ff2bd6', '#1a6bff']) {
      const rgb = hexToRgb(hex)
      expect(rgb && isRgb(rgb)).toBe(true)
      expect(rgbToHex(rgb!)).toBe(hex)
    }
  })

  it('rejects invalid hex', () => {
    expect(hexToRgb('red')).toBeNull()
    expect(hexToRgb('#fff')).toBeNull()
    expect(hexToRgb('#gg0000')).toBeNull()
  })
})
