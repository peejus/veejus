import { useState } from 'react'

const DISMISSED_KEY = 'veejus.firstRun.dismissed'

interface Step {
  done: boolean
  label: string
  action: string
  onAction(): void
}

/**
 * "Get ready" strip for a fresh setup: add clips, choose the audio input, choose the output
 * screen. It disappears once all three are done, or when hidden (remembered).
 */
export function FirstRun({ steps }: { steps: Step[] }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === '1'
    } catch {
      return false
    }
  })
  if (dismissed || steps.every((s) => s.done)) return null
  const hide = () => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISSED_KEY, '1')
    } catch {
      // Not remembered; it just comes back next time.
    }
  }
  return (
    <section className="first-run" aria-label="Get ready" data-testid="first-run">
      <span className="first-run-title">Get ready</span>
      <ol>
        {steps.map((s, i) => (
          <li key={s.label} className={s.done ? 'done' : ''}>
            <span className="first-run-num" aria-hidden="true">
              {s.done ? '✓' : i + 1}
            </span>
            {s.done ? (
              <span>{s.label}</span>
            ) : (
              <button className="link" onClick={s.onAction}>
                {s.action}
              </button>
            )}
          </li>
        ))}
      </ol>
      <button className="subtle compact" onClick={hide} title="Don't show this again">
        Hide
      </button>
    </section>
  )
}
