# Veejus

A desktop VJ app for firing short, silly video clips and GIFs in sync with the music's beats and drops.

The build follows the phased plan in [VEEJUS_AGENT_PROMPT.md](VEEJUS_AGENT_PROMPT.md). Progress and per-phase test scripts are in [docs/PROGRESS.md](docs/PROGRESS.md); the module map is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Current status:** Phase 5 (layers, compositing, placement and keying).

## Requirements

- Node.js 20.11+ (developed on Node 24)
- Windows 10/11 (macOS should work but is untested)
- ffmpeg, only for regenerating test fixtures (`winget install Gyan.FFmpeg`)

## Setup

```bash
npm install
```

If Electron's binary did not download during install, run `node node_modules/electron/install.js`.

## Starting the app

Double-click **`Start-Veejus.bat`** in the project folder:

- It installs dependencies on first run.
- It builds the latest code (a few seconds), then opens Veejus without leaving a console window open.
- `Start-Veejus.bat dev` starts development mode with hot reload instead.

To start it from the desktop or taskbar, right-click `Start-Veejus.bat` → **Show more options** → **Create shortcut**, then move the shortcut there.

## Commands

| Command                     | What it does                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `npm run dev`               | Start the app with hot reload (control window + output window)                              |
| `npm run build`             | Production build into `out/`                                                                |
| `npm run preview`           | Run the production build                                                                    |
| `npm test`                  | Unit tests (Vitest), then build + end-to-end tests (Playwright)                             |
| `npm run test:unit`         | Unit tests only                                                                             |
| `npm run test:e2e`          | Build, then end-to-end tests that launch the real app                                       |
| `npm run typecheck`         | TypeScript checks for main/preload and renderer code                                        |
| `npm run lint`              | ESLint                                                                                      |
| `npm run format`            | Prettier                                                                                    |
| `npm run fixtures`          | Regenerate the small committed test media in `fixtures/media`                               |
| `npm run fixtures:stress`   | Generate 50 clips in `fixtures/stress` for the stress test                                  |
| `npm run fixtures:perf`     | Generate 1080p clips in `fixtures/perf` for the 4-layer performance test                    |
| `npm run fixtures:audio`    | Write synthetic drum patterns + ground truth to `fixtures/audio`                            |
| `npm run analyze -- <file>` | Run onset detection and beat tracking over an audio file (WAV, or MP3/FLAC/... via ffmpeg)  |
| `npm run build:link`        | Build the optional Ableton Link module into `native/` (needs Visual Studio C++ Build Tools) |

The stress test is skipped until `npm run fixtures:stress` has been run once.

## Using it

- **First run:** a **Get ready** strip at the top lists three steps: add clips, choose the audio input, choose the output screen. It disappears when all three are done, or when you press **Hide**.
- **Colors mean the same thing everywhere:**
  - green: playing
  - amber: queued or armed (and the drop countdown)
  - magenta: the beat and whatever you selected
  - red: destructive actions and errors
  - the four layer colors: blue, orange, cyan, purple
- **Screen layout:**
  - **Top bar:** **Output** and **Audio** status pills (click one to set it up), a **Fullscreen** toggle, output fps, and **⚙ Setup**.
  - **Left column:** the pads, the **mixer** (one strip per layer plus Master) and the library.
  - **Right column:** the output preview, the tempo panel, and a **context panel** that shows whatever you selected: a pad, a layer's effects, or a library clip.
  - **⚙ Setup** (a drawer) holds everything you set before the show: **Audio**, **Output** (display, fullscreen, background color), **Clock** and **Diagnostics** (stats and the output's debug overlay).

- **Pads:**
  - **Load:** drag library clips onto the 4×8 pad grid (4 banks), or click **Auto-fill**.
  - **Fire:** keys `1–8`, `Q–I`, `A–K`, `Z–,` fire pads on the next beat, bar or phrase (global **Quantize**, with a per-pad override).
  - **Read a pad at a glance:** the corner icon is its mode (▶ one-shot, ⏱N for N beats, ✋ while held, ⟳ toggle loop, ↻ retrigger, ⚄ random clip). The colored left edge is the layer it plays on, in the same color as that layer's mixer strip. Hover for the details in words.
  - **Edit:** right-click a pad (or hover it and press ✎) to edit it in the context panel. The basics are up front: clip (or a random clip from a folder), play mode, layer, position. **More settings** holds quantize, fades, tempo sync, offsets, rotation, entrance and keying, and its title lists any you've changed.
  - **Drop:** **Shift+key** (or Shift+click) arms a pad. The **DROP in N bars** banner counts down, and its **Lands** menu picks when: next phrase, or in 1–8 bars. Changing it retargets the armed drop.
  - **Banks and stop:** **F1–F4** switch banks; **Esc** stops everything.
  - **All shortcuts:** press **?** (or the **?** button in the top bar) for the keyboard sheet. While it's open, Esc closes the sheet instead of stopping the show.
- **Layers (the mixer):**
  - **The four layers:** Background, Overlay A, Overlay B and Takeover. Each has opacity, a blend mode (normal, add, screen, multiply, difference), mute (M), solo (S) and stop (■).
  - **Where pads play:** a pad picks its layer itself (**Auto**: loops to Background, quick hits to the overlays, drops to Takeover), or you can choose one in the pad editor.
  - **Placement and keying:** the pad editor also sets placement (full screen, center, corners, lower third, left or right half, random spot; size, offset, rotation; pop or slide entrances in beats) and keying (green screen, blue screen, custom color, or luma).
  - **Under a takeover:** the lower layers keep playing, dim, pause or hide.
  - **Master:** brightness and **Blackout** (`` ` `` key). The **Output preview** at the top right mirrors what the audience sees.
- **Effects & modulation:** press **FX** on a mixer strip (a green dot means that layer has effects on). Its effects open in the context panel.
  - **Presets:** one click turns on **Kick Bump**, **Snare Strobe**, **Bar Shake** or **Drop Flash**.
  - **Effects:** **+ Add effect** shows a card for each: strobe/flash, RGB split, kaleidoscope, mirror, pixelate, zoom bump, shake, invert, hue rotate, feedback trails. They apply in order (↑/↓ to reorder).
  - **Make anything move with the music:** press **~** next to any effect setting, or under **Layer motion and opacity** for opacity, scale, rotation and position. A modulator opens right there. Its source is one of:
    - a beat-synced **LFO** (sine, triangle, saw, square, random step; 1/16 note to 8 bars)
    - a **beat envelope** (every beat, beats 2 & 4, bar, phrase, detected kick or snare/hat)
    - an **audio band** level

    Each modulator has an amount, a range it adds and invert. A pink **ghost** marker on the slider (and on the mixer fader for opacity) shows where the modulation is taking the value right now. **All modulators** lists them all.

  - **Sliders:** double-click resets to the default, **Shift-drag** fine-tunes at a tenth of the speed, and clicking the number lets you type a value. This also works on the mixer faders.
- **Library:** drop clips or folders onto the library, or use **Add files…** / **Add folder…**. Supported: MP4, WebM (including alpha), MOV (H.264), GIF, animated WebP, APNG, PNG, JPEG. **Search** by name or folder, and filter by type: Video, GIF / animated, Stills or Broken. **Remove N broken** clears unplayable clips in one go, with Undo. Each tile shows its name on the thumbnail, and **▣ N** shows how many pads use it; removing a clip that pads use asks first. Hover a clip for a live preview. A click only **selects** it, so browsing never changes the show. To show it on the Background layer right away (unquantized), use the **▶ Play** button on the selected clip, or double-click it. **Clear library…** asks first and offers **Undo** for 10 seconds. The dot on each pad shows whether the output has the clip loaded (green ready, amber loading, grey not loaded yet, red error).
- **Library plays:** selecting a library clip shows it in the context panel with **▶ Play on Background**, **Stop**, and how library plays look: loop or one-shot, speed (0.25×–4×), and fit (contain, cover, stretch, original size). Changes apply live. **Stop** clears the layer.
- **Tempo:** the BPM is detected from the audio and the beat lights follow the kicks. **Space** taps tempo, **Enter** marks "now is beat 1", **← / →** nudge the grid 10 ms. You can also type a BPM, use ×2 / ÷2, or lock the tempo. **⚙ Setup → Clock** has phase correction, a latency offset (raise it if the visuals land after the kick you hear), phrase length and tempo range. If no audio input is selected, the tempo panel says so and opens **⚙ Setup → Audio**. The output's debug overlay (off by default, because the audience sees it; turn it on under **⚙ Setup → Diagnostics**) shows a 4-light metronome.
- **MIDI controllers:**
  - **MIDI learn:** press **MIDI learn** in the top bar. Every control you can map gets outlined. Click one, then press or move a control on your controller. Repeat for as many as you like, then press **Done**.
  - **What you can map:**
    - pads (with velocity: hit harder for a more opaque clip)
    - banks, quantize, tap, beat 1, nudge, stop all, blackout
    - layer faders and master brightness
    - any effect slider
    - in ⚙ Setup → MIDI: hold-to-arm, fire drop now, next/previous bank
  - **Faders and knobs:** each CC can be absolute or relative (endless encoders).
  - **Templates:** ⚙ Setup → MIDI → **Controller template** maps an **Akai APC mini (mk1)** in one click: grid, faders, buttons, and pad LEDs (yellow ready, green playing, blinking red armed).
  - **Saved:** mappings come back the next time you start.
- **Tempo source** (⚙ Setup → Clock): **Audio detection**, **Tap / manual**, **MIDI clock** (from a DJ mixer, drum machine or DAW; press play on the source to line up bars) or **Ableton Link**.
  - Link shares tempo and bars with Ableton Live, Traktor, Rekordbox, Serato and other Link apps on the network.
  - Link needs the optional module: run `npm run build:link` once. Windows may ask to allow Veejus on the network the first time.
- **Audio input** (⚙ Setup → Audio, or click the Audio pill): pick your mixer or audio-interface input, **System audio** (whatever this PC is playing), or the silent built-in **Test beat**. Watch the level meter, band bars and spectrum, and the **Kick** and **Snare / hat** lamps. Set **Input gain** so the level sits mostly green without lighting CLIP. **Analysis settings** has sensitivities, envelope times, crossovers and band gains. Veejus never plays audio itself.
- **Output window** (⚙ Setup → Output, or click the Output pill): what the audience sees. Pick the display and go fullscreen there. Closing it only hides it ("Show output" brings it back). In the output window, **Esc** exits fullscreen and **F11** toggles it.

### Video decoding

Veejus decodes video in software by default, because starting hardware decoders stalls the output for a frame or more each time a clip preloads. To try hardware decoding, start it with the environment variable `VEEJUS_HW_VIDEO_DECODE=1`.
