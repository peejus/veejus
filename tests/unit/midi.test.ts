import { describe, expect, it } from 'vitest'
import {
  LED,
  apcMiniPadNote,
  ccDelta,
  continuousValue,
  describeMessage,
  isMidiBinding,
  isMidiSettings,
  isPress,
  matchBindings,
  padLed,
  parseMidi,
  targetKey,
  targetLabel,
  templateBindings,
  type MidiBinding,
} from '@shared/midi'

const binding = (over: Partial<MidiBinding> = {}): MidiBinding => ({
  id: 'b1',
  device: 'APC MINI',
  type: 'note',
  channel: 0,
  number: 36,
  target: { kind: 'pad', index: 0 },
  ccMode: 'absolute',
  velocity: true,
  ...over,
})

describe('MIDI messages', () => {
  it('parses note on/off (velocity 0 is off) and CC on any channel', () => {
    expect(parseMidi([0x90, 36, 100])).toEqual({
      kind: 'note',
      channel: 0,
      number: 36,
      velocity: 100,
      on: true,
    })
    expect(parseMidi([0x93, 36, 0])).toMatchObject({ channel: 3, on: false })
    expect(parseMidi([0x80, 36, 64])).toMatchObject({ on: false, velocity: 0 })
    expect(parseMidi([0xb1, 7, 127])).toEqual({ kind: 'cc', channel: 1, number: 7, value: 127 })
    expect(parseMidi([0xf8])).toBeNull() // clock
    expect(parseMidi([0xe0, 0, 64])).toBeNull() // pitch bend
    expect(describeMessage(parseMidi([0xb0, 48, 12])!)).toBe('CC 48 = 12 · ch 1')
  })

  it('treats note on and high CC values as presses', () => {
    expect(isPress(parseMidi([0x90, 1, 1])!)).toBe(true)
    expect(isPress(parseMidi([0x80, 1, 0])!)).toBe(false)
    expect(isPress(parseMidi([0xb0, 1, 127])!)).toBe(true)
    expect(isPress(parseMidi([0xb0, 1, 0])!)).toBe(false)
  })
})

describe('bindings', () => {
  it('match by device (or any), type, channel and number', () => {
    const list = [
      binding(),
      binding({ id: 'b2', device: null, number: 37 }),
      binding({ id: 'b3', type: 'cc', number: 36 }),
    ]
    const note36 = parseMidi([0x90, 36, 90])!
    expect(matchBindings(list, 'APC MINI', note36).map((b) => b.id)).toEqual(['b1'])
    expect(matchBindings(list, 'Other', note36)).toHaveLength(0)
    expect(matchBindings(list, 'Other', parseMidi([0x90, 37, 90])!).map((b) => b.id)).toEqual([
      'b2',
    ])
    expect(matchBindings(list, 'APC MINI', parseMidi([0x91, 36, 90])!)).toHaveLength(0) // ch 2
  })

  it('maps absolute and relative (endless) CCs onto 0..1', () => {
    expect(continuousValue('absolute', 0, 0.5)).toBe(0)
    expect(continuousValue('absolute', 127, 0.5)).toBe(1)
    // Two's complement: 1 = +1 step, 127 = -1 step.
    expect(ccDelta('relative', 1)).toBe(1)
    expect(ccDelta('relative', 127)).toBe(-1)
    expect(ccDelta('relative', 65)).toBe(-63)
    expect(ccDelta('relativeOffset', 66)).toBe(2)
    expect(ccDelta('relativeOffset', 63)).toBe(-1)
    expect(continuousValue('relative', 3, 0.5)).toBeCloseTo(0.5 + 3 / 127)
    expect(continuousValue('relative', 127, 0)).toBe(0) // clamped
    expect(continuousValue('relativeOffset', 127, 0.99)).toBe(1)
  })

  it('guards stored settings', () => {
    expect(isMidiBinding(binding())).toBe(true)
    expect(isMidiBinding(binding({ number: 128 }))).toBe(false)
    expect(isMidiBinding(binding({ target: { kind: 'pad', index: 40 } }))).toBe(false)
    expect(
      isMidiBinding(
        binding({
          target: { kind: 'effectParam', scope: 'overlayA', effectId: 'e1', param: 'amount' },
        }),
      ),
    ).toBe(true)
    expect(isMidiSettings({ version: 1, bindings: [binding()], feedbackOutput: null })).toBe(true)
    expect(isMidiSettings({ version: 2, bindings: [], feedbackOutput: null })).toBe(false)
  })

  it('labels targets for the UI and keys them stably', () => {
    expect(targetLabel({ kind: 'pad', index: 4 })).toBe('Pad 5')
    expect(targetLabel({ kind: 'layerOpacity', layer: 'overlayB' })).toBe('Overlay B opacity')
    expect(targetKey({ kind: 'tap' })).toBe(targetKey({ kind: 'tap' }))
  })
})

describe('APC mini template and LEDs', () => {
  it('maps the top four grid rows to the 32 pads, faders to layers, scene buttons to banks', () => {
    const t = templateBindings('apcMini', 'APC MINI')
    expect(apcMiniPadNote(0)).toBe(56) // top-left
    expect(apcMiniPadNote(7)).toBe(63)
    expect(apcMiniPadNote(31)).toBe(39) // fourth row down, right
    const pads = t.filter((b) => b.target.kind === 'pad')
    expect(pads).toHaveLength(32)
    expect(new Set(pads.map((b) => b.number)).size).toBe(32)
    expect(pads.every((b) => b.velocity)).toBe(true)
    expect(t.find((b) => b.type === 'cc' && b.number === 48)!.target).toEqual({
      kind: 'layerOpacity',
      layer: 'background',
    })
    expect(t.find((b) => b.number === 82 && b.type === 'note')!.target).toEqual({
      kind: 'bank',
      bank: 0,
    })
    expect(t.every(isMidiBinding)).toBe(true)
    // No two controls collide.
    expect(new Set(t.map((b) => `${b.type}${b.number}`)).size).toBe(t.length)
  })

  it('pad LEDs: empty off, ready yellow, queued blinking green, playing green, armed blinking red', () => {
    expect(padLed(true, 'idle')).toBe(LED.off)
    expect(padLed(false, 'idle')).toBe(LED.yellow)
    expect(padLed(false, 'queued')).toBe(LED.greenBlink)
    expect(padLed(false, 'playing')).toBe(LED.green)
    expect(padLed(false, 'armed')).toBe(LED.redBlink)
    expect(padLed(false, 'stopping')).toBe(LED.yellowBlink)
  })
})
