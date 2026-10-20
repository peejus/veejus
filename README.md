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

| Command                     | What it does                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run dev`               | Start the app with hot reload (control window + output window)                             |
| `npm run build`             | Production build into `out/`                                                               |
| `npm run preview`           | Run the production build                                                                   |
| `npm test`                  | Unit tests (Vitest), then build + end-to-end tests (Playwright)                            |
| `npm run test:unit`         | Unit tests only                                                                            |
| `npm run test:e2e`          | Build, then end-to-end tests that launch the real app                                      |
| `npm run typecheck`         | TypeScript checks for main/preload and renderer code                                       |
| `npm run lint`              | ESLint                                                                                     |
| `npm run format`            | Prettier                                                                                   |
| `npm run fixtures`          | Regenerate the small committed test media in `fixtures/media`                              |
| `npm run fixtures:stress`   | Generate 50 clips in `fixtures/stress` for the stress test                                 |
| `npm run fixtures:perf`     | Generate 1080p clips in `fixtures/perf` for the 4-layer performance test                   |
| `npm run fixtures:audio`    | Write synthetic drum patterns + ground truth to `fixtures/audio`                           |
| `npm run analyze -- <file>` | Run onset detection and beat tracking over an audio file (WAV, or MP3/FLAC/... via ffmpeg) |

The stress test is skipped until `npm run fixtures:stress` has been run once.

## Using it

- **Pads:**
  - **Load:** drag library clips onto the 4×8 pad grid (4 banks), or click **Auto-fill**.
  - **Fire:** keys `1–8`, `Q–I`, `A–K`, `Z–,` fire pads on the next beat, bar or phrase (global **Quantize**, with a per-pad override).
  - **Edit:** right-click a pad to set its play mode (one-shot, for N beats, while held, toggle loop, retrigger), fades, tempo sync, or a random clip from a folder.
  - **Drop:** **Shift+key** arms a pad; the **DROP in N bars** banner counts down to the next phrase.
  - **Banks and stop:** **F1–F4** switch banks; **Esc** stops everything.
- **Layers:**
  - **The four layers:** Background, Overlay A, Overlay B and Takeover. Each has opacity, a blend mode (normal, add, screen, multiply, difference), mute (M), solo (S) and stop (■).
  - **Where pads play:** a pad picks its layer itself (**Auto**: loops to Background, quick hits to the overlays, drops to Takeover), or you can choose one in the pad editor.
  - **Placement and keying:** the pad editor also sets placement (full screen, center, corners, lower third, left or right half, random spot; size, offset, rotation; pop or slide entrances in beats) and keying (green screen, blue screen, custom color, or luma).
  - **Under a takeover:** the lower layers keep playing, dim, pause or hide.
  - **Master:** brightness and **Blackout** (`` ` `` key). The **Output preview** at the top of the sidebar mirrors what the audience sees.
- **Effects & modulation:** pick a layer (or Master) in the **Effects & modulation** panel.
  - **Presets:** one click turns on **Kick Bump**, **Snare Strobe**, **Bar Shake** or **Drop Flash**.
  - **Effects:** strobe/flash, RGB split, kaleidoscope, mirror, pixelate, zoom bump, shake, invert, hue rotate and feedback trails, applied in order (↑/↓ to reorder).
  - **Modulators:** drive any number (opacity, scale, rotation, position, or any effect parameter) from a beat-synced **LFO** (sine, triangle, saw, square, random step; 1/16 note to 8 bars), a **beat envelope** (every beat, beats 2 & 4, bar, phrase, detected kick or snare/hat), or an **audio band** level. Each has an amount, a min..max range and invert.
- **Library:** drop clips or folders onto the library, or use **Add files…** / **Add folder…**. Supported: MP4, WebM (including alpha), MOV (H.264), GIF, animated WebP, APNG, PNG, JPEG. Hover a clip for a live preview, click it to play it on the output immediately (unquantized preview). The dot on each pad shows whether the output has the clip loaded (green ready, amber loading, grey not loaded yet, red error).
- **Clip layer:** loop or one-shot, speed (0.25×–4×), and fit (contain, cover, stretch, original size). Changes apply live. **Stop** clears the layer.
- **Tempo:** the BPM is detected from the audio and the beat lights follow the kicks. **Space** taps tempo, **Enter** marks "now is beat 1", **← / →** nudge the grid 10 ms. You can also type a BPM, use ×2 / ÷2, or lock the tempo. **Clock settings** has phase correction, a latency offset (raise it if the visuals land after the kick you hear), phrase length and tempo range. The output's debug overlay shows a 4-light metronome.
- **Audio input:** pick your mixer or audio-interface input, **System audio** (whatever this PC is playing), or the silent built-in **Test beat**. Watch the level meter, band bars and spectrum, and the **Kick** and **Snare / hat** lamps. Set **Input gain** so the level sits mostly green without lighting CLIP. **Analysis settings** has sensitivities, envelope times, crossovers and band gains. Veejus never plays audio itself.
- **Output window:** what the audience sees. Closing it only hides it ("Show output" brings it back). In the output window, **Esc** exits fullscreen and **F11** toggles it.

### Video decoding

Veejus decodes video in software by default, because starting hardware decoders stalls the output for a frame or more each time a clip preloads. To try hardware decoding, start it with the environment variable `VEEJUS_HW_VIDEO_DECODE=1`.
