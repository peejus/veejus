/** True in the macOS build: shortcut labels use ⌘, and system-audio capture is unavailable. */
export const isMac = /Mac/i.test(navigator.platform)

/** The save/open modifier as shown in labels: "Ctrl+" on Windows, "⌘" on macOS. */
export const MOD = isMac ? '⌘' : 'Ctrl+'

/** How the output window's fullscreen toggle is labelled. */
export const FULLSCREEN_KEY = isMac ? '⌃⌘F' : 'F11'

/** Shift as shown in labels. */
export const SHIFT = isMac ? '⇧' : 'Shift+'
