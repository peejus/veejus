# Veejus UX review (after Phase 6)

Reviewed 2026-10-20 by running the control window at its default size (1280×820) with clips loaded, the test beat running and pads firing. Screenshots are in `tmp/ux-*.png`; they're local and gitignored.

## Who it's for and what they need

A DJ or VJ, live, in a dark room, often while mixing music with the other hand. In order of priority, they need to:

1. **Glance** at what the audience sees and whether the beat is locked.
2. **Hit** a clip at the right moment (keys, mouse, later MIDI).
3. **Tweak** a few things quickly: layer levels, an effect, blackout.
4. **Prepare** before the set: load clips, assign pads, set placement and effects, pick the audio input and output display.

The app is strong at 1 and 2, but everything for 3 and 4 is in one long sidebar where all the panels look equally important. Performing and preparing are mixed together, and diagnostics sit among the controls.

## Findings, most important first

### Serious (affect a live show)

1. **The output starts with the debug overlay on.**
   - The overlay shows FPS, frame times, media budgets and layer lists over the picture. It's visible to the audience until someone unticks **Debug overlay**, which is at the bottom of the sidebar.
   - Fix: the overlay should start off, and only be shown deliberately from a diagnostics menu.
2. **Clicking a library clip silently replaces the live Background layer.**
   - Browsing your clips mid-set changes the show. Hovering already gives a preview in the tile, so a click doesn't need to go live.
3. **"Clear" empties the whole library with one click and no undo.**
   - It sits right next to "Add folder…".
4. **The pad editor opens off-screen.**
   - Right-click a pad and the editor appears in the sidebar, below the beat panel. At the default window size only its first two rows show, so nothing seems to happen.
   - The editor is about 650 px tall, so you have to scroll the sidebar away from the preview and beat panel to use it.
5. **There's no first-run guidance, and audio starts off.**
   - On a fresh launch the tempo panel says "listening…" at 120 BPM even though no audio source is selected.
   - **Audio input** is the 8th panel down. Without it, beat sync (the core feature) silently does nothing.
   - The same goes for choosing the output display: the 10th panel down.

### Structural (make everything feel harder than it is)

6. **The sidebar has 11 stacked panels.** In order: preview, beat, pad editor, layers, effects, library preview, audio input, background color, output window, frame timing. The fully expanded sidebar is about 3,000 px tall:
   - Only the preview and beat panel are visible without scrolling.
   - Layers and effects (the things you tweak live) are never on screen together with the pads.
   - Every panel has the same visual weight, so nothing tells you where to look.
7. **Performing, preparing and diagnosing are mixed.**
   - Setup-only panels (audio device, analysis settings, displays, background color) sit between live controls.
   - Developer numbers are always on screen:
     - the top bar shows IPC ping, MB of decoded images and warm video counts
     - "Output frame timing"
     - "Last change drawn in 0.3 ms"
8. **Duplicate and competing concepts:**
   - **"Library preview"** has its own loop/speed/fit controls. They only apply to library clicks, and they duplicate the pad's own fit.
   - **Quantize** is set in three places:
     - global, in the pad toolbar
     - per pad, in the editor
     - drop timing, in a second toolbar dropdown labelled only "Drop"
   - **Edit pads** mode plus right-click to edit: two ways in, and neither is obvious.
9. **Jargon and cryptic labels:**
   - Pad badges read `1×·A`, `loop·BG`, `4b·B`.
   - Effects tabs are `BG / A / B / TO / Master`.
   - Other examples:
     - "Resync 1"
     - unlabeled ◀ ▶ nudge buttons
     - "Under takeover"
     - "Plays: Auto (Overlay A; drops: Takeover)"
     - "Restart every"
   - The keyboard help is a single dense 160-character line.
10. **Effects aren't connected to the layers they belong to.**
    - The Layers panel and the Effects panel are separate, with different names for the same layers.
    - A layer row doesn't show that it has effects, so you can't see why a layer looks strange.

### Polish

11. **Library tiles show no name until scrolled.** At the default size, the name row is below each thumbnail and gets cut off.
    - Broken clips show only ⚠ and a truncated "Unsupported format or co…".
    - The tile with the error has an ✕ on hover, but there's no "Remove broken clips".
12. **Small, low-contrast text in a dark room.**
    - Much of the UI is 11–12 px in a muted gray on near-black: hints, labels, badges, slider values.
    - The narrow sidebar (≈340 px) squeezes the sliders.
13. **Colors don't carry meaning consistently.** Magenta marks:
    - the selected bank
    - the beat light
    - the active effects tab
    - preset "on" states
    - an 'output here' display tag
14. **Number entry:** effect sliders have no way to type a value, reset to default (for example by double-clicking), or fine-tune with a modifier key.

## Proposal

### Principle: one screen for the show, a drawer for everything else

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ VEEJUS   ● Output: DELL U2717D · fullscreen ▾   ● Audio: Mixer In 1 ▾   ⚙   ☰ Setup  │  status bar
├────────────────────────────────────────────────┬─────────────────────────────────────┤
│ [A][B][C][D]  Quantize: Beat ▾        STOP ALL │  ┌───────────────────────────────┐  │
│ ┌────┬────┬────┬────┬────┬────┬────┬────┐      │  │       OUTPUT PREVIEW          │  │
│ │ 1  │ 2  │ 3  │ ...                    │      │  │                               │  │
│ ├────┼────┼                              │      │  └───────────────────────────────┘  │
│ │ Q  │ ...  32 pads, bigger tiles, clear │      │  124.0 BPM  ● ● ○ ○   Bar 3/8  🔒   │  beat strip
│ │    │      icons for mode / layer       │      │  [ TAP ] [ Beat 1 ] [ ◀ −10ms ][ ▶ ]│
│ └────┴────┴────┴────┴────┴────┴────┴────┘      │─────────────────────────────────────│
│  DROP ▸ armed: Q, W  — fires in 2 bars         │  LAYERS (mixer)                     │
│────────────────────────────────────────────────│  Takeover  ▮▮▮▮▮▮▯ 100%  Normal  FX•│
│ LIBRARY  [search…]  [All|Video|GIF|Stills]  +  │  Overlay B ▮▮▮▮▮▮▮ 100%  Screen   FX │
│ ┌──┐┌──┐┌──┐┌──┐┌──┐┌──┐  (names always shown, │  Overlay A ▮▮▮▮▮▮▮ 100%  Normal  FX•│
│ └──┘└──┘└──┘└──┘└──┘└──┘   drag to a pad)      │  Background▮▮▮▮▮▯▯  80%  Normal   FX │
│                                                │  Master    ▮▮▮▮▮▮▮      [BLACKOUT]   │
│                                                │─────────────────────────────────────│
│                                                │  Context panel: the selected pad,   │
│                                                │  or the selected layer's effects    │
└────────────────────────────────────────────────┴─────────────────────────────────────┘
```

**Perform view (always visible):**

- **Status bar.** Two pills, **Output** and **Audio**, each green, amber or red, and each opens a small menu: display, fullscreen and show; input device and gain. A ⚙ opens **Setup**.
- **Pads**, the drop banner and the library on the left.
- **Right column:**
  - The preview and a compact beat strip, both always visible.
  - A **mixer** with one line per layer and the master.
  - A **context panel** below the mixer that shows whatever you selected:
    - Selecting a pad shows its settings.
    - Clicking **FX** on a layer row shows that layer's effects and presets.
    - A small **FX•** dot means the layer has active effects.

**Setup drawer** (⚙, slides over the right column). It has tabs:

- **Audio:** device, gain, meters, analysis settings.
- **Output:** displays, fullscreen, background color.
- **Clock:** latency offset, phrase length, tempo range, phase correction.
- **Diagnostics:** FPS, frame timing, IPC, media memory, and the output's debug overlay toggle.

### First run: a three-step checklist

The first launch, with an empty library, shows a short checklist where the pad grid will be. It disappears once all three are done, and the same items stay reachable from the status pills.

1. **Add clips:** drop a folder here, or pick one.
2. **Choose your audio:** mixer input, system audio, or the test beat.
3. **Choose the output screen:** with a "Go fullscreen" button.

### Specific changes

**Safety and live behavior**

- Debug overlay **off** by default; the toggle moves to Setup → Diagnostics.
- **Library click = select** (and show a big preview in the context panel), not "play live".
  - Live preview of a library clip becomes an explicit **"Play on Background"** button, or **double-click** while the Setup drawer is closed.
  - The separate **Library preview** panel goes away. Its loop/speed/fit become per-clip defaults, used when a clip is assigned to a pad.
- **Clear library** moves into a "…" menu, needs confirming, and gets a 10-second **Undo** toast.
  - Removing a single clip that's assigned to pads also asks before going ahead.
- **Esc = Stop all** stays.
- Keyboard shortcuts no longer fire while a text or number field has focus (already true for most). Add a visible "keys active" indicator so a focused field never silently swallows pad keys mid-set.

**Pads**

- **Selecting a pad** (click when not playing, or right-click) opens its settings in the **context panel**, which is always on screen. Drop the separate **Edit pads** mode: a pad's settings are one right-click away and also listed in a pad "…" menu.
- The pad editor gets **Basic** and **Advanced** sections:
  - **Basic:** clip, mode, layer, position. Shown by default.
  - **Advanced:** quantize override, fades, tempo sync, offsets and rotation, entrance, keying. Collapsed by default.
- Replace badge jargon with small icons plus plain words in the tooltip:
  - ▶︎1 for one-shot
  - ⟳ for loop
  - ⏱4 for 4 beats
  - ✋ for hold
  - ↻ for retrigger
  - A small colored stripe on the tile's left edge shows the layer, using the same color as that layer's row in the mixer.
- Bigger tiles: the pad grid can use the width that the library preview panel and part of the sidebar give back.
- Move the long key-help line into a **"?" keyboard sheet** (an overlay listing every shortcut). Pressing **?** opens it.
- **Drop:** a single **"Drop timing"** control in the drop banner (next phrase, or in N bars), shown only when something is armed. The idle toolbar gets simpler.

**Beat strip**

- Rename the controls:
  - "Resync 1" becomes **"Beat 1"** (tooltip: "Mark now as the downbeat — Enter").
  - ◀ ▶ become **−10 ms / +10 ms** (tooltip: "Nudge the beat grid earlier or later").
- Show **"No audio input"** with a link to pick one when no source is selected, instead of "listening…".
- **Lock** becomes a padlock toggle. ÷2 ×2 and the typed BPM stay, more compact.
- Clock settings move to Setup → Clock.

**Mixer (Layers + master)**

- One compact line per layer:
  - color stripe and name
  - what's playing
  - a fader that can be typed into
  - blend mode
  - M, S and ■ buttons
  - an **FX** button with a dot when effects are active
- "Under takeover" becomes **"While Takeover plays: other layers [Dim ▾] [70%]"**, shown under the Takeover row.
- Master row: brightness fader and a large **BLACKOUT** button. The button turns red and pulses while active; the backquote shortcut is shown on it.

**Effects (in the context panel, per layer)**

- Opened from a layer's **FX** button, so the layer is always clear. The panel title says "Effects — Overlay A" (no BG/A/B/TO tabs).
- Presets come first, as big toggle tiles with a one-line description.
- **Add effect** shows a menu of effect cards (name and a tiny icon) instead of a dropdown plus a button.
- Modulators are shown **inside the parameter they drive**: every slider gets a small "~" button that attaches an LFO, envelope or audio source to it.
  - This removes the target dropdown and makes it obvious what moves.
  - A modulated slider shows a live "ghost" thumb that moves with the modulation.
- Sliders: double-click resets to default, Shift-drag fine-tunes, and clicking the value lets you type one.

**Library**

- Names are always visible, overlaid on the thumbnail's lower edge so they never fall off-screen.
- A **search box** and type filters (All / Video / GIF / Stills / Broken).
- Broken clips:
  - grouped under the **Broken** filter
  - the full reason shown in the tooltip
  - a **"Remove broken (3)"** action
- "**Assigned**" marker: a small corner number shows how many pads use a clip.

**Visual design**

- Base text 13 px (hints 12 px), and raise the muted-gray contrast to at least 4.5:1 for anything readable.
- **One accent color per meaning:**

  | Meaning                | Color                                        |
  | ---------------------- | -------------------------------------------- |
  | live / playing         | green                                        |
  | armed / pending        | amber                                        |
  | beat and selection     | magenta (brand)                              |
  | destructive / blackout | red                                          |
  | layers                 | four fixed hues, used everywhere they appear |

- Panel hierarchy: preview and mixer get headers; context content gets lighter cards, so the eye lands on the show first.
- Reflow at narrower widths: below about 1100 px wide, the library collapses to a strip under the pads.

## Decisions (2026-10-20)

The recommended answers to the questions at the end were accepted:

1. A library click **selects** the clip.
2. The layout targets a **laptop-width** screen (≈1366–1920 px) first.
3. Modulators **attach to sliders**.
4. UX work goes **before Phase 7**.

**UX-1 to UX-4 are done.** See `docs/PROGRESS.md` for what changed.

UX-2 differs from the proposal above in two places, both to fit a 1366×768 laptop screen:

- **The mixer sits under the pads**, as a row of five strips, rather than in the right column. That leaves the right column for the preview, the tempo panel and a usable context panel.
- **The Output and Audio pills open Setup at that tab** rather than separate pop-up menus, so there is one place for each setting. A **Fullscreen** button next to the pills covers the live action.

## Suggested implementation order

Each step is a self-contained, testable change. The existing end-to-end tests drive the UI by accessible names, so each step updates those tests with it.

| Step                                | What                                                                                                                                                                                                           | Effort |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **UX-1: Live-safety quick wins**    | Debug overlay off by default. Library click selects instead of playing live (plus explicit Play). Confirm and undo on Clear. Remove dev metrics from the top bar. "No audio input" state. Rename beat buttons. | Small  |
| **UX-2: Layout restructure**        | Status bar with Output and Audio pills. Setup drawer (Audio / Output / Clock / Diagnostics). Right column = preview, beat strip, mixer, context panel. Remove the Library preview panel and Edit pads mode.    | Large  |
| **UX-3: Pads and context editing**  | Pad editor in the context panel with Basic/Advanced. Icon badges with layer color stripes. "?" keyboard sheet. Drop timing in the banner.                                                                      | Medium |
| **UX-4: Effects in the mixer**      | FX buttons and dots on layer rows. Modulation attached to sliders with a ghost thumb. Effect cards. Slider reset / fine-tune / type-in.                                                                        | Medium |
| **UX-5: Library and visual polish** | Search, filters, names on tiles, broken-clip handling, assigned counts. Typography and contrast pass. Color semantics. First-run checklist. Responsive reflow.                                                 | Medium |

UX-1 is worth doing regardless of anything else: it removes the ways the current UI can embarrass a performer in front of an audience. UX-2 is the change that most affects how simple the app feels; UX-3 to UX-5 build on its layout.

## Questions for you

1. **Library click:** should it select the clip (my recommendation, safe), or keep playing it live on the Background like now?
2. **Screen size:** do you perform on a laptop screen (≈1366–1920 px wide) or a large external monitor? This decides how much fits on the perform view at once.
3. **Modulation on sliders:** are you happy for modulators to attach directly to sliders (simpler), with the separate modulator list kept only as an "all modulators" overview?
4. **Order:** should UX-1 and UX-2 happen before Phase 7 (MIDI)? MIDI learn will need the final layout of controls to point at, which argues for doing UX-2 first.
