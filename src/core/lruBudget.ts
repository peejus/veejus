/**
 * Least-recently-used bookkeeping against a cost budget (bytes, player count, ...).
 * It holds no resources itself: callers add entries with a cost and dispose whatever
 * keys `add` reports as evicted. Pinned entries (e.g. the clip on screen) are never evicted.
 */
export class LruBudget<K> {
  // Map iteration order is insertion order; re-inserting on touch keeps it oldest-first.
  private readonly entries = new Map<K, { cost: number; pins: number }>()
  private usedCost = 0

  constructor(public limit: number) {}

  get used(): number {
    return this.usedCost
  }

  get size(): number {
    return this.entries.size
  }

  has(key: K): boolean {
    return this.entries.has(key)
  }

  /** Oldest first. */
  keys(): K[] {
    return [...this.entries.keys()]
  }

  /** Mark as most recently used. */
  touch(key: K): void {
    const e = this.entries.get(key)
    if (!e) return
    this.entries.delete(key)
    this.entries.set(key, e)
  }

  /**
   * Add (or re-cost) an entry as most recently used, then evict least-recently-used,
   * unpinned entries until the budget fits. The new entry itself is never evicted, so a
   * single entry larger than the budget is allowed. Returns the evicted keys.
   */
  add(key: K, cost: number): K[] {
    const existing = this.entries.get(key)
    if (existing) {
      this.usedCost -= existing.cost
      this.entries.delete(key)
    }
    this.entries.set(key, { cost, pins: existing?.pins ?? 0 })
    this.usedCost += cost
    return this.evict(key)
  }

  /** Evict until within budget (e.g. after lowering `limit`). */
  evict(protect?: K): K[] {
    const evicted: K[] = []
    if (this.usedCost <= this.limit) return evicted
    for (const [k, e] of this.entries) {
      if (this.usedCost <= this.limit) break
      if (k === protect || e.pins > 0) continue
      this.entries.delete(k)
      this.usedCost -= e.cost
      evicted.push(k)
    }
    return evicted
  }

  remove(key: K): boolean {
    const e = this.entries.get(key)
    if (!e) return false
    this.entries.delete(key)
    this.usedCost -= e.cost
    return true
  }

  pin(key: K): void {
    const e = this.entries.get(key)
    if (e) e.pins++
  }

  unpin(key: K): void {
    const e = this.entries.get(key)
    if (e && e.pins > 0) e.pins--
  }

  isPinned(key: K): boolean {
    return (this.entries.get(key)?.pins ?? 0) > 0
  }
}
