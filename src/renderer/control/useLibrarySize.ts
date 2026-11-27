import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'

const STORAGE_KEY = 'veejus.libraryHeight'
/** Never smaller than about one row of clips (matches the CSS min-height). */
export const LIBRARY_MIN_HEIGHT = 210
/** Arrow keys on the grip resize by this much. */
const KEY_STEP = 40

function stored(): number | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    return typeof v === 'number' && Number.isFinite(v) && v >= LIBRARY_MIN_HEIGHT ? v : null
  } catch {
    return null
  }
}

function remember(height: number | null): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(height))
  } catch {
    // Not remembered between runs; it still works now.
  }
}

function scrollToLibrary(col: HTMLElement): void {
  col.scrollTop = col.scrollHeight
}

/**
 * The library's height in the left column. By default (null) it fills what the pads and mixer
 * leave. Dragging its grip up (or Expand) makes it taller, up to the whole column: the column
 * then scrolls, so the pads and mixer slide up out of view and the library stays in sight.
 */
export function useLibrarySize() {
  const ref = useRef<HTMLElement>(null)
  const [height, setHeightState] = useState<number | null>(stored)
  const drag = useRef<{ y: number; h: number } | null>(null)
  /** Height of the column the library sits in (for Expand, and the upper limit). */
  const [columnHeight, setColumnHeight] = useState(0)

  useEffect(() => {
    const col = ref.current?.parentElement
    if (!col) return
    const ro = new ResizeObserver(() => setColumnHeight(col.clientHeight))
    ro.observe(col)
    // A size remembered from last time: show the library, not the pads above it.
    const frame = stored() !== null ? requestAnimationFrame(() => scrollToLibrary(col)) : 0
    return () => {
      ro.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])

  /** The scrolling column the library sits in. */
  const column = () => ref.current?.parentElement ?? null
  const maxHeight = () => Math.max(LIBRARY_MIN_HEIGHT, column()?.clientHeight ?? Infinity)

  const setHeight = useCallback((h: number | null) => {
    const col = ref.current?.parentElement
    const max = Math.max(LIBRARY_MIN_HEIGHT, col?.clientHeight ?? Infinity)
    const next = h === null ? null : Math.round(Math.min(max, Math.max(LIBRARY_MIN_HEIGHT, h)))
    setHeightState(next)
    remember(next)
    // Once it has rendered, keep the library's bottom at the bottom of the column, so growing
    // it pushes the pads and mixer up instead of pushing the library down out of view.
    if (col)
      requestAnimationFrame(() => {
        if (next === null) col.scrollTop = 0
        else scrollToLibrary(col)
      })
  }, [])

  const expanded = height !== null && columnHeight > 0 && height >= columnHeight - 1

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !ref.current) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, h: ref.current.offsetHeight }
  }
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (d) setHeight(d.h + (d.y - e.clientY))
  }
  const onPointerUp = () => {
    drag.current = null
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const cur = ref.current?.offsetHeight ?? LIBRARY_MIN_HEIGHT
    let next: number | null | undefined
    if (e.key === 'ArrowUp') next = cur + KEY_STEP
    else if (e.key === 'ArrowDown') next = cur - KEY_STEP
    else if (e.key === 'Home') next = maxHeight()
    else if (e.key === 'End' || e.key === 'Escape') next = null
    if (next === undefined) return
    e.preventDefault()
    e.stopPropagation()
    setHeight(next)
  }

  const style: CSSProperties | undefined = height === null ? undefined : { height, flex: 'none' }

  return {
    ref,
    style,
    expanded,
    toggleExpanded: () => setHeight(expanded ? null : maxHeight()),
    gripProps: {
      role: 'separator',
      'aria-orientation': 'horizontal' as const,
      'aria-label': 'Resize library',
      title: 'Drag up to make the library bigger (double-click to reset)',
      tabIndex: 0,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onDoubleClick: () => setHeight(null),
      onKeyDown,
    },
  }
}
