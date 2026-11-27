# Veejus

A desktop VJ app for firing short, silly video clips and GIFs in sync with the music's beats and drops.

The build follows the phased plan in [VEEJUS_AGENT_PROMPT.md](VEEJUS_AGENT_PROMPT.md). Progress and per-phase test scripts are in [docs/PROGRESS.md](docs/PROGRESS.md); the module map is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Current status:** Phase 5 (layers, compositing, placement and keying).

## Requirements

- Node.js 20.11+ (developed on Node 24)
- Windows 10/11, or macOS 13 (Ventura) or later on Apple silicon or Intel
- ffmpeg, only for regenerating test fixtures (`winget install Gyan.FFmpeg`, or `brew install ffmpeg` on a Mac)

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

On a Mac, double-click **`Start-Veejus.command`** instead (same behaviour; `./Start-Veejus.command dev` for hot reload). The first time, macOS may refuse to open it: right-click it → **Open**.

## Commands

| Command                     | What it does                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run dev`               | Start the app with hot reload (control window + output window)                                |
| `npm run build`             | Production build into `out/`                                                                  |
| `npm run preview`           | Run the production build                                                                      |
| `npm test`                  | Unit tests (Vitest), then build + end-to-end tests (Playwright)                               |
| `npm run test:unit`         | Unit tests only                                                                               |
| `npm run test:e2e`          | Build, then end-to-end tests that launch the real app                                         |
| `npm run typecheck`         | TypeScript checks for main/preload and renderer code                                          |
| `npm run lint`              | ESLint                                                                                        |
| `npm run format`            | Prettier                                                                                      |
| `npm run fixtures`          | Regenerate the small committed test media in `fixtures/media`                                 |
| `npm run fixtures:stress`   | Generate 50 clips in `fixtures/stress` for the stress test                                    |
| `npm run fixtures:perf`     | Generate 1080p clips in `fixtures/perf` for the 4-layer performance test                      |
| `npm run fixtures:audio`    | Write synthetic drum patterns + ground truth to `fixtures/audio`                              |
| `npm run analyze -- <file>` | Run onset detection and beat tracking over an audio file (WAV, or MP3/FLAC/... via ffmpeg)    |
| `npm run build:link`        | Build the optional Ableton Link module into `native/` (needs Visual Studio C++ Build Tools)   |
| `npm run dist`              | Build the Windows installer into `dist/` (unsigned; see Installing below)                     |
| `npm run dist:mac`          | On a Mac: build a `.dmg` and `.zip` for that Mac into `dist/`                                 |
| `npm run dist:mac-zip`      | On any OS: build macOS zips for Apple silicon and Intel into `dist/` (see Installing (macOS)) |
| `npm run soak`              | The 60-minute soak test (memory, frame rate, crashes); `-- --minutes 5` for a short run       |

The stress test is skipped until `npm run fixtures:stress` has been run once.

## Using it

- **Quick start (auto-play):** the fastest way to get visuals on the beat.
  - **Empty library:** a **Start a show in one click** card offers **Choose images, GIFs & videos…** and **Choose a folder…** (or drop files on it). Once they're in, auto-play starts and the output window opens.
  - **▶ Auto-play** in the top bar (or **P**) turns it on and off. It steps through your clips on the beat, one after another, with no pads needed. A small number on the button counts the beats to the next change.
  - **▾** next to it opens the settings: what it plays (everything, images & GIFs, videos, favorites or a collection), how often it changes (**Auto**, or every beat up to every 4 bars), in order or shuffled, how the picture fills the screen, and which layer it uses. Changes of a bar or longer land on bar lines.
  - **Auto** holds stills for a bar. A GIF or short video plays through once, stretched slightly (never more than about 1.4×) so the change lands on the beat (1, 2, 4, 8 or 16 beats). A clip shorter than a beat loops within it. A longer video plays at normal speed for **Long videos** (1–8 bars, 2 by default).
  - **Videos start at:** where a video longer than its turn starts each time: **a random spot** (the default), **where it left off**, or **the beginning**. The next video is cued at its spot while the current one plays, so the change still lands on the beat.
  - **Beat effect:** the settings can also move the picture with the beat: **Pulse**, **Fold**, **Bounce**, **Pixel spin**, **Wave**, **Slice**, **Twirl**, **Mystify lines**, or **Mix** (a different one for each clip). **Effect on** picks what gets it: still photos (the default), photos and videos, or everything (GIFs too).
  - **Pads still work on top:** a pad fired on the same layer takes over until it ends, then auto-play carries on. **Esc** (stop everything) switches auto-play off too.
  - **Tempo:** auto-play follows the clock: tap **Space** on the beat, type a BPM, or turn on audio so it follows the music.
- **Sets:** the set name in the top bar opens **New / Open… / Save / Save as… / Recent sets** (Ctrl+O, Ctrl+S, Ctrl+Shift+S). A dot means unsaved changes.
  - **What a set holds:** everything: the library (with collections and favorites), pads, mix, effects, clock settings, MIDI mappings, audio input, background and output options.
  - **Moving media:** clips are found next to the set file first, so you can move a folder holding the set and its clips. If clips are missing, Veejus offers to search a folder for them by name.
  - **Autosave:** Veejus keeps your work as you go and brings it back when you start it again, or after a crash.
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
  - **Edit:** right-click a pad (or hover it and press ✎) to edit it in the context panel. The basics are up front: clip (or a random clip from a folder), play mode, layer, position. **More settings** holds quantize, fades, tempo sync, start spot, beat loop, offsets, rotation, entrance and keying, and its title lists any you've changed.
  - **Videos on pads:** **Start at** a random spot picks a new place in the clip each time the pad fires (and on each retrigger), leaving room for what plays before the next jump. **Beat loop** (¼ beat to 2 bars) plays that many beats at normal speed and jumps back to where it started, for stutters and held loops; it works with For N beats, While held and Toggle loop. A tempo-synced clip always starts at the top.
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
  - **Presets:** one click turns on **Kick Bump**, **Snare Strobe**, **Bar Shake** or **Drop Flash**, or one of the photo presets: **Photo Pulse**, **Photo Fold**, **Photo Bounce**, **Pixel Spin**, **Photo Wave**, **Photo Slice**, **Photo Twirl** or **Mystify**.
  - **Beat-locked photo effects:** **Pulse** (swells and glows on the beat), **Fold** (one half hinges over onto the other, shut on the beat; side or up, 1–8 panels), **Bounce** (lifts between beats, lands and squashes on them) **Pixel spin** (a wave of spinning tiles that bounces back and forth across the picture), **Wave** (a ripple rolls out from the middle on the beat), **Slice** (strips slide apart on the beat, swapping sides each time) and **Twirl** (the middle twists on the beat, alternating direction, and unwinds). Each has its own beat count (Beats per pulse / fold / bounce / sweep), so it follows whatever clock is running without a modulator, and longer cycles line up with bar 1. They work on any clip, but are made for still photos.
  - **Mystify lines:** two bouncing four-cornered shapes with fading trails, drawn in shifting colors over the picture, in the style of the classic Mystify screensaver. They jump forward on each beat (**Beat punch**; 0 glides evenly) and flash brighter on it. Set Brightness, Trails (1–8) and Speed. Put it on **Master** to draw over everything, even an empty screen.
  - **Effects:** **+ Add effect** shows a card for each: strobe/flash, RGB split, kaleidoscope, mirror, pixelate, zoom bump, shake, invert, hue rotate, feedback trails, pulse, fold, bounce, pixel spin, wave, slice, twirl, Mystify lines. They apply in order (↑/↓ to reorder).
  - **Make anything move with the music:** press **~** next to any effect setting, or under **Layer motion and opacity** for opacity, scale, rotation and position. A modulator opens right there. Its source is one of:
    - a beat-synced **LFO** (sine, triangle, saw, square, random step; 1/16 note to 8 bars)
    - a **beat envelope** (every beat, beats 2 & 4, bar, phrase, detected kick or snare/hat)
    - an **audio band** level

    Each modulator has an amount, a range it adds and invert. A pink **ghost** marker on the slider (and on the mixer fader for opacity) shows where the modulation is taking the value right now. **All modulators** lists them all.

  - **Sliders:** double-click resets to the default, **Shift-drag** fine-tunes at a tenth of the speed, and clicking the number lets you type a value. This also works on the mixer faders.
- **Library:** drop clips or folders onto the library, or use **Add files…** / **Add folder…**. Supported: MP4, WebM (including alpha), MOV (H.264), GIF, animated WebP, APNG, PNG, JPEG. **Collections and favorites:** select a clip to star it or add it to collections ("Air Horns", "Drops"…); filter the library by them, and point a pad at **Random from collection** or **Random from ★ favorites**. **Search** by name or folder, and filter by type: Video, GIF / animated, Stills or Broken. **Remove N broken** clears unplayable clips in one go, with Undo. Each tile shows its name on the thumbnail, and **▣ N** shows how many pads use it; removing a clip that pads use asks first. Hover a clip for a live preview. A click only **selects** it, so browsing never changes the show. To show it on the Background layer right away (unquantized), use the **▶ Play** button on the selected clip, or double-click it. **Clear library…** asks first and offers **Undo** for 10 seconds. The dot on each pad shows whether the output has the clip loaded (green ready, amber loading, grey not loaded yet, red error).
- **Trim:** selecting a video shows a strip of its frames with two handles. Drag them (or focus one and use the arrow keys: 0.1 s, Shift 1 s) to choose the part that plays; the preview above loops it. Pads, auto-play, tempo sync and library plays all use only that part, and the trim is saved with the set. **Reset** plays the whole clip again.
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
- **Output window** (⚙ Setup → Output, or click the Output pill): what the audience sees. Pick the display and go fullscreen there. **Picture** sets the shape (fill, 16:9, 4:3, 1:1, or 9:16 for vertical screens, with black bars) and the render resolution (native, 1080p, 720p). For streaming, capture the output window in OBS (see `docs/STREAMING_PLAN.md`). Closing it only hides it ("Show output" brings it back). In the output window, **Esc** exits fullscreen and **F11** toggles it.

### Video decoding

Veejus decodes video in software by default, because starting hardware decoders stalls the output for a frame or more each time a clip preloads. To try hardware decoding, start it with the environment variable `VEEJUS_HW_VIDEO_DECODE=1`.

## Installing (macOS)

There are two ways to get a Mac app:

- **Built on Windows (no Mac needed):** `npm run dist:mac-zip` writes `dist/Veejus-<version>-mac-arm64.zip` (Apple silicon: M1 and later) and `dist/Veejus-<version>-mac-x64.zip` (Intel Macs). Not sure which Mac you have? Apple menu → About This Mac: "Chip: Apple M…" means arm64. This build has no Ableton Link module.
- **Built on a Mac:** `npm run dist:mac` writes a `.dmg` and a `.zip` for that Mac's CPU into `dist/`. Run `npm run build:link` first (needs `xcode-select --install`) to include Ableton Link.

Either way the app isn't signed with an Apple Developer ID, so macOS blocks it at first. For the zip built on Windows, unzip it on the Mac (double-click), drag **Veejus** to Applications, then run this once in Terminal to clear the download quarantine and sign it for this Mac:

```bash
xattr -cr /Applications/Veejus.app && codesign --force --deep --sign - /Applications/Veejus.app
```

For the `.dmg` built on a Mac, drag Veejus to Applications and right-click it → **Open** the first time (or run the `xattr -cr` part above).

- **Permissions:** the first time you pick an audio input, macOS asks to let Veejus use the microphone; Ableton Link may ask for local network access. Change these later in System Settings → Privacy & Security.
- **System audio:** macOS has no built-in way for apps to capture what the Mac is playing, so the **System audio** source is Windows-only. Install a virtual audio device such as [BlackHole](https://existential.audio/blackhole/), send your music to it (Audio MIDI Setup → multi-output device), and pick BlackHole as the audio input.
- **Keys:** ⌘ replaces Ctrl (⌘S, ⌘O, ⌘⇧S). In the output window **⌃⌘F** toggles fullscreen (F11 shows the desktop on a Mac). On a laptop keyboard the bank keys are **fn + F1–F4**.
- **Where your data lives:** the autosave and recent-sets list are in `~/Library/Application Support/Veejus`.

## Installing (Windows)

`npm run dist` builds `dist/Veejus Setup <version>.exe`:

- **Install:** a per-user installer. It doesn't need admin rights, you can choose the folder, and it adds Start menu and desktop shortcuts. Uninstall it from Windows Settings → Apps.
- **Unsigned:** the installer isn't code-signed yet, so Windows SmartScreen shows "Windows protected your PC" the first time. Choose **More info → Run anyway**. Signing needs a code-signing certificate; electron-builder picks it up from `CSC_LINK` / `CSC_KEY_PASSWORD` when one is available.
- **Ableton Link:** included in the installer only if you ran `npm run build:link` before `npm run dist`.
- **Where your data lives:** sets go wherever you save them; the autosave and the recent-sets list are in `%APPDATA%\Veejus`.
