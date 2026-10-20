import { describe, expect, it } from 'vitest'
import { LruBudget } from '@core/lruBudget'

describe('LruBudget', () => {
  it('tracks cost and evicts least recently used entries over budget', () => {
    const b = new LruBudget<string>(100)
    expect(b.add('a', 40)).toEqual([])
    expect(b.add('b', 40)).toEqual([])
    expect(b.used).toBe(80)
    expect(b.add('c', 40)).toEqual(['a'])
    expect(b.used).toBe(80)
    expect(b.keys()).toEqual(['b', 'c'])
  })

  it('touch protects recently used entries', () => {
    const b = new LruBudget<string>(100)
    b.add('a', 40)
    b.add('b', 40)
    b.touch('a')
    expect(b.add('c', 40)).toEqual(['b'])
    expect(b.keys()).toEqual(['a', 'c'])
  })

  it('evicts several entries if needed', () => {
    const b = new LruBudget<string>(100)
    b.add('a', 30)
    b.add('b', 30)
    b.add('c', 30)
    expect(b.add('d', 80)).toEqual(['a', 'b', 'c'])
    expect(b.used).toBe(80)
  })

  it('never evicts pinned entries', () => {
    const b = new LruBudget<string>(100)
    b.add('a', 60)
    b.pin('a')
    b.add('b', 30)
    expect(b.add('c', 30)).toEqual(['b'])
    expect(b.has('a')).toBe(true)
    b.unpin('a')
    expect(b.add('d', 30)).toEqual(['a'])
  })

  it('supports nested pins', () => {
    const b = new LruBudget<string>(10)
    b.add('a', 10)
    b.pin('a')
    b.pin('a')
    b.unpin('a')
    expect(b.isPinned('a')).toBe(true)
    b.unpin('a')
    expect(b.isPinned('a')).toBe(false)
  })

  it('allows one entry larger than the whole budget', () => {
    const b = new LruBudget<string>(100)
    b.add('a', 50)
    expect(b.add('huge', 500)).toEqual(['a'])
    expect(b.keys()).toEqual(['huge'])
    expect(b.used).toBe(500)
  })

  it('re-adding an entry updates its cost and recency', () => {
    const b = new LruBudget<string>(100)
    b.add('a', 40)
    b.add('b', 40)
    b.add('a', 10)
    expect(b.used).toBe(50)
    expect(b.keys()).toEqual(['b', 'a'])
  })

  it('remove frees cost; evict() applies a lowered limit', () => {
    const b = new LruBudget<string>(100)
    b.add('a', 40)
    b.add('b', 40)
    expect(b.remove('a')).toBe(true)
    expect(b.remove('a')).toBe(false)
    expect(b.used).toBe(40)
    b.add('c', 40)
    b.limit = 50
    expect(b.evict()).toEqual(['b'])
    expect(b.used).toBe(40)
  })

  it('works as a count budget (cost 1 each)', () => {
    const b = new LruBudget<number>(3)
    for (let i = 0; i < 5; i++) b.add(i, 1)
    expect(b.keys()).toEqual([2, 3, 4])
  })
})
