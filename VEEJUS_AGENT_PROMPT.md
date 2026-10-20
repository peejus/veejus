# Veejus — Development Agent Prompt

> Paste everything below the line into a software development agent (e.g. Claude Code) at the root of an empty project folder. Edit the **Tech Stack** section first if you want a different stack.

---

## Role and mission

You are a senior software engineer building **Veejus**, a desktop VJ (video jockey) application for DJs and VJs. Its signature feature is letting a performer quickly load **short, silly video clips and GIFs** (memes, reaction clips, stingers, cartoon explosions, "air horn" visuals) and fire them **in sync with the music's beats and drops**, layered over or in place of a background visual.

You will build Veejus in **discrete, testable phases**. Each phase must end in a working, runnable app that the human can try, critique, and refine before you continue. **Do not start a new phase until the human explicitly approves the current one.**

## Product vision (what "done" eventually looks like)

A performer can:

1. Drag a folder of MP4s, WebMs, GIFs, and animated WebPs into Veejus and instantly see them as thumbnail pads in a library/grid.
2. Feed in the live music (line-in, mic, or system loopback), and Veejus tracks the tempo (BPM) and beat phase, with tap tempo and "resync downbeat" as manual overrides.
3. Hit a pad or key and have the clip appear **on the next beat, bar, or phrase** (quantized), play for a set number of beats, and vanish or fade out, all timed to the music.
4. **Arm** a clip ("the drop is coming") so it fires on the next phrase boundary, for example 8 or 16 bars.
5. Layer clips: a looping background, plus pop-up meme clips in corners, plus full-screen "takeover" moments for drops.
6. Make clips react to audio: bump on the kick, strobe on the snare, speed up or slow down with the BPM.
7. Control everything from a keyboard, a MIDI controller (with MIDI learn), and sync tempo with DJ software via Ableton Link.
8. Send clean output to a second display or projector while the control UI stays on the laptop screen.
9. Save and reload a "set" (library, pad layout, mappings, settings).

## Tech stack (default; confirm or adjust in Phase 0)

- **Electron + TypeScript + Vite**, with **React** for the control UI.
- **Rendering:** WebGL2 through a thin custom layer or **PixiJS** in a dedicated **output window**. Video goes through `HTMLVideoElement` → texture. GIF/animated WebP goes through the **WebCodecs `ImageDecoder`** (fallback: `gifuct-js`), decoded to frames ahead of time.
- **Audio:** Web Audio API (`getUserMedia` with device selection, `AnalyserNode` or an `AudioWorklet` for FFT/onset analysis). On Windows, also support system-audio loopback capture via Electron.
- **Tempo/beat:** your own onset detection plus tempo estimation in an `AudioWorklet` or a Worker. Ableton Link comes in a later phase through a native Node module.
- **MIDI:** Web MIDI API.
- **Testing:** **Vitest** for unit tests, **Playwright for Electron** for end-to-end smoke tests.
- **Packaging:** electron-builder (Windows first; keep macOS viable).

If you believe a different stack is materially better (e.g., Tauri, or native Rust/C++), say why in Phase 0 and wait for approval. Don't switch silently.

## Architecture principles (apply in every phase)

1. **Split the processes.** The control UI window and the output/render window are separate. The renderer must keep rendering smoothly even if the UI is busy. They talk over typed IPC messages defined in one shared `protocol.ts`.
2. **One master clock.** A single `BeatClock` module is the only source of tempo, beat phase, bar, and phrase position. Every layer, trigger, LFO, and transition reads from it. Nothing keeps its own private timer.
3. **The scheduler sits on top of the clock.** Quantized events ("fire clip X at next bar") are scheduled against clock time, not `setTimeout`. Fire on the render frame closest to the target time and compensate for a user-adjustable **latency offset** (ms).
4. **Pure, testable cores.** Beat detection, the clock, the scheduler, the quantizer, and envelope followers are pure TypeScript modules with no DOM or Electron dependencies, so they can be unit-tested with synthetic audio and simulated time.
5. **Media is preloaded.** A clip must be decoded and GPU-ready _before_ it can be triggered, so a pad press never stalls. Show a pad's loading/ready state in the UI.
6. **Budgets.** Target 60 fps at 1920×1080 with at least 4 active layers on a mid-range laptop GPU. Keep audio-analysis-to-visual latency ≤ ~50 ms before the manual offset. Show the FPS and frame-time in a debug overlay from Phase 1 onward.
7. **Typed state.** One serializable app-state model (library, pads, layers, mappings, settings) that later becomes the saved "set" file. Version the schema.

## Working agreement (how you operate)

- **Start each phase** by restating its goals, then listing the files and modules you plan to create or change. Proceed only after that.
- **End each phase** with:
  - All unit tests passing (`npm test`) and the app launching (`npm run dev`).
  - A **Phase Report** appended to `docs/PROGRESS.md`: what was built, how to run it, a **manual test script** (numbered steps the human can follow with expected results), known issues, and open questions.
  - A clear **STOP** asking the human to test and approve, or to request changes.
- Keep `README.md` current (setup, run, test commands).
- Commit at logical checkpoints with clear messages, if the folder is a git repo (initialize one in Phase 0).
- Put small sample/test assets in `fixtures/`: a few tiny MP4s and GIFs (generate them with ffmpeg or code, don't download copyrighted media) and synthetic audio such as click tracks at known BPMs (generate these in code).
- When requirements are ambiguous, ask. When a choice is minor, pick a sensible default and note it in the Phase Report.
- Prefer small, well-named modules over clever abstractions. Don't build features from future phases early. Do leave clean seams for them.

---

## Phases

Each phase lists **Goal**, **Scope**, **Out of scope**, and **Acceptance criteria**. Meet every acceptance criterion before stopping.

### Phase 0: Foundation and skeleton

**Goal:** A runnable shell with the two-window architecture and test tooling in place.

**Scope:**

- Project scaffold (Electron + Vite + TS + React), lint/format config, Vitest, Playwright-Electron.
- **Control window** (React) and **Output window** (a full-window canvas). The Output window can be moved to any connected display and toggled fullscreen.
- Typed IPC `protocol.ts`, with a ping/pong and a "set background color" message to prove the channel works.
- Render loop in the Output window that draws a solid color plus a debug overlay (FPS, frame time).
- `docs/ARCHITECTURE.md` with a short module map and data-flow diagram (ASCII is fine).

**Out of scope:** media, audio, beats.

**Acceptance criteria:**

- `npm run dev` opens both windows. Changing a color in the control UI changes the output within one frame.
- The Output window can be sent fullscreen to a second display, and Esc exits fullscreen.
- `npm test` runs at least one unit test and one Playwright smoke test that launches the app.

---

### Phase 1: Clip library and basic playback

**Goal:** Load silly clips and GIFs and play them reliably on the output.

**Scope:**

- Import by drag-and-drop (files or folders) and by file picker. Supported formats: **MP4 (H.264), WebM (VP8/VP9, including alpha), MOV/ProRes if the platform can decode it, GIF, animated WebP, APNG, PNG/JPG stills**.
- **Library panel** with thumbnail pads (animated preview on hover), file name, duration/frame count, dimensions, and an alpha indicator.
- **Media manager:** decodes and preloads clips, holds GIF frames with per-frame delays, caps total memory with LRU eviction, and reports loading/ready/error state per clip.
- A single **clip layer** in the output: click a pad to play it. Settings: loop vs. one-shot, playback speed, and **fit mode** (contain / cover / stretch / original size).
- GIF and WebM **transparency** is preserved over the background color.
- Video clips are **muted by default**, because the DJ's audio is the main audio.

**Out of scope:** audio analysis, beat sync, multiple layers.

**Acceptance criteria:**

- Importing a folder of 50 mixed clips stays responsive. Thumbnails appear progressively.
- Clicking a ready pad shows the clip within one frame, with no visible stall. A transparent GIF composites correctly over the background.
- A corrupt or unsupported file shows an error on its pad without crashing.
- Unit tests cover the GIF frame-timing logic and media-manager eviction.

---

### Phase 2: Audio input and analysis

**Goal:** Hear the music and turn it into usable signals.

**Scope:**

- Audio device selector (inputs, plus system loopback on Windows) with an input gain control.
- Analysis in an `AudioWorklet` or Worker:
  - FFT with **bass / low-mid / mid / high** bands (configurable crossover frequencies).
  - Per-band **envelope followers** (attack, release, gain, smoothing).
  - Overall **RMS/peak** level.
  - **Onset detection** (spectral flux), with separate kick-ish (low band) and snare/hat-ish (high band) onset events.
- Control-UI **meters**: a spectrum display, band levels, and onset blinkers.
- An **offline analysis harness** that runs the same analysis code over a WAV file faster than real time, for tests.

**Out of scope:** BPM/clock, triggering.

**Acceptance criteria:**

- With music playing, the bass meter visibly pulses on kicks and the kick-onset blinker fires on most kicks of a four-on-the-floor track.
- Offline tests on generated fixtures (e.g., a kick every 500 ms) detect ≥ 95% of onsets within ±15 ms, with < 5% false positives.
- Switching input devices at runtime works without restarting.

---

### Phase 3: Beat clock (tempo and phase)

**Goal:** A rock-solid musical clock: BPM, beat, bar, phrase.

**Scope:**

- **Automatic BPM estimation** from the onset stream (e.g., autocorrelation or comb-filter tempo induction over a sliding window), constrained to a configurable range (default 70–180) with half/double-time correction.
- **Phase tracking**: keep the beat grid aligned to the actual onsets with smooth corrections (no jumps).
- **Manual overrides:** **tap tempo** (keyboard key plus UI button), **type BPM**, **nudge phase** ±, **×2 / ÷2**, and **resync downbeat** ("now is beat 1 of the bar").
- **Lock mode:** freeze the detected BPM so it stops drifting, and keep phase correction on or off as a toggle.
- `BeatClock` exposes `bpm`, `beatPhase` (0–1), `beatIndex`, `barIndex`, `beatInBar`, `phraseIndex` (configurable phrase length: 4, 8, 16, or 32 bars), plus subscribable `onBeat`, `onBar`, and `onPhrase` events.
- Control UI: a big BPM readout, a beat-in-bar indicator (●○○○), a bar/phrase counter, and a confidence indicator.
- **Latency offset** setting (ms) applied to visual timing.

**Out of scope:** clip triggering against the clock (next phase).

**Acceptance criteria:**

- Offline tests: generated click tracks at 90, 120, 128, 140, and 174 BPM are detected within ±0.5 BPM within 8 seconds, without settling on the wrong octave (e.g., 64 for 128).
- Tap tempo converges after 4 taps. Resync downbeat moves beat 1 instantly.
- Simulated-time unit tests confirm the clock emits beat/bar/phrase events at the right times across tempo changes.
- On real music, the beat indicator visibly stays locked for at least 2 minutes on a steady dance track.

---

### Phase 4: Beat-synced triggering (the core feature)

**Goal:** Fire silly clips exactly on the music.

**Scope:**

- **Pad grid** (e.g., 4×8 per bank, multiple banks). Assign library clips to pads by drag-and-drop.
- **Keyboard hotkeys** for pads (default: QWERTY rows map to the grid) and for bank switching.
- **Quantize setting**, global with per-pad override: _off (immediate) / 1/4 beat / beat / bar / phrase_.
- **Per-pad play modes:**
  - **One-shot:** play once, then disappear.
  - **Beat-length:** show for exactly N beats/bars, then fade out (e.g., "flash this meme for 2 beats").
  - **Loop-while-held:** visible only while the key/pad is held.
  - **Toggle loop:** press on, press off (with the off action also quantizable).
  - **Retrigger-on-beat:** restart the clip from frame 0 on every beat or bar while active (stutter effect).
- **Tempo-sync playback:** optionally time-stretch a clip so its length equals N beats, or scale GIF frame delays to the BPM.
- **Fade in/out** durations measured in beats.
- **Arm-and-fire ("drop mode"):** arm a pad (or a "drop" macro with several clips) to fire at the **next phrase boundary** or after a countdown of N bars. The UI shows a visible countdown ("DROP in 3 bars"). Pressing again cancels.
- **Random pick:** a pad can point at a _folder or tag_ and choose a random clip each time it fires (with no immediate repeats).
- UI feedback: armed/queued/playing states on pads, with a pulse that follows the beat.

**Out of scope:** multi-layer compositing beyond what this phase needs, effects, MIDI.

**Acceptance criteria:**

- Clips triggered with bar quantize start within one frame of the bar boundary, after the latency offset. Verify this with an automated test using simulated clock time and frame timestamps.
- Beat-length mode shows a clip for N beats ± one frame at 120 and 174 BPM.
- Arming a drop and waiting fires it exactly on the phrase boundary, with a correct countdown display.
- Random-pick never repeats the same clip twice in a row (unit test).
- **Manual test:** the human plays a track, presses pads, and confirms that "it feels on the beat".

---

### Phase 5: Layers, compositing and placement

**Goal:** Stack visuals so meme clips can pop up over a background or take over the screen.

**Scope:**

- At least **4 layers** (e.g., Background, Overlay A, Overlay B, Takeover). Each layer has opacity, blend mode (normal, add, screen, multiply, difference), and solo/mute.
- Pads target a layer by default. Per-pad layer override.
- **Placement presets** for overlay clips: full-screen, centered, the four corners, random position, "pop" (scale-in bounce), and slide in from an edge. Settings for scale, position, and rotation.
- **Chroma key** (green/blue screen removal, with similarity/smoothness) and **luma key** per clip, because a lot of meme clips are green-screen.
- **Takeover behavior:** while a Takeover clip plays, lower layers can optionally dim or pause.
- **Master output** with brightness and a "blackout" button.
- **Preview monitor** in the control UI (a downscaled output mirror).

**Acceptance criteria:**

- Four layers at 1080p (background loop plus three overlays, including one GIF and one chroma-keyed MP4) render at ≥ 60 fps on the target hardware. Record the measured FPS in the report.
- Placement presets and chroma key work, and the preview monitor matches the output.

---

### Phase 6: Audio-reactive modulation and effects

**Goal:** Make visuals breathe with the music beyond triggering.

**Scope:**

- **Modulation system:** any numeric parameter (layer opacity, clip scale, rotation, position, hue, effect amount) can have a modulator attached. Sources:
  - Audio band envelopes and onset events from Phase 2.
  - **Beat-synced LFOs** (sine, saw, square, triangle, random-step) with periods in musical units (1/16 … 8 bars) and a phase offset.
  - **Beat envelopes** (an attack/decay shape retriggered on each beat, bar, or kick).
- Modulators have depth/amount, min/max range, and invert.
- **Effects** per layer and on the master, built as a GLSL shader chain: strobe, RGB split, kaleidoscope, mirror, pixelate, zoom-bump, shake, invert, hue rotate, feedback/trails. Every effect parameter can be modulated.
- Built-in "fun" presets, e.g. **Kick Bump** (scale +10% on kick), **Snare Strobe**, **Bar Shake**, **Drop Flash** (white flash plus zoom on phrase start).

**Acceptance criteria:**

- Unit tests for LFO waveforms at musical periods across BPM changes (phase continuity, no jumps).
- With "Kick Bump" on, a clip visibly bumps on each kick. With a 1-bar sine on opacity, it completes exactly one cycle per bar.
- The effects chain on all layers holds ≥ 60 fps at 1080p (report the measurement).

---

### Phase 7: External control and sync

**Goal:** Integrate with DJ gear and software.

**Scope:**

- **MIDI input** with **MIDI learn** (click "learn", touch a control, done) for pads, banks, quantize, tap tempo, resync, arm/fire drop, layer opacities, effect knobs, and blackout. Support note on/off, CC (absolute and relative/endless), and pad velocity.
- **MIDI output** for pad LED feedback (ready/armed/playing colors) on common grid controllers. Provide a generic mapping plus at least one template (e.g., Novation Launchpad or Akai APC mini).
- **MIDI Clock in** (follow external tempo) as an alternative clock source.
- **Ableton Link:** join a Link session to share tempo and phase with Traktor, Serato, Rekordbox, Ableton, etc. The clock-source selector offers Audio detection / Tap/Manual / MIDI Clock / Ableton Link.
- **OSC input** (optional, if time permits) for triggers and parameters.

**Acceptance criteria:**

- MIDI learn maps a pad and a knob in under 5 seconds each. Mappings persist.
- Joining a Link session with another Link app (Ableton Live or a free Link test app) keeps beat 1 aligned within one frame.
- Switching clock sources at runtime doesn't crash, and the scheduled triggers re-anchor sensibly.

---

### Phase 8: Sets, persistence, output and hardening

**Goal:** Make it gig-ready.

**Scope:**

- **Save/load sets** (versioned JSON plus relative media paths), auto-save, and a recent-sets list. A missing-media relink dialog.
- **Library features:** tags, search, favorites, and "collections" (e.g., _Air Horns_, _Reactions_, _Explosions_, _Drops_) usable by random-pick pads.
- **Output options:** choice of output display, resolution, an aspect-ratio letterbox, and **Spout (Windows) / Syphon (macOS) / NDI** output for OBS and streaming, if a viable native module exists. Otherwise document a plan.
- **Performance hardening:** a GPU memory budget, decoder-pool limits, a frame-drop watchdog, and graceful degradation (e.g., lower preview quality first).
- **Crash safety:** the output window keeps the last frame or goes to black, never a desktop or error dialog, if the control UI crashes. Auto-restore after restart.
- Settings screen (audio, clock, latency offset, output, hotkeys).
- **Packaging:** a signed (or unsigned, documented) Windows installer through electron-builder.

**Acceptance criteria:**

- Save → quit → reopen restores the full set exactly.
- A 60-minute soak test with music playing and random triggering every few seconds shows no memory growth trend, no crashes, and a sustained ≥ 58 fps average. Write a script that drives this automatically, and report the results.
- The installer installs and runs on a clean Windows machine.

---

### Phase 9+ (backlog; do not start without approval)

- Automatic **drop/build-up detection** (energy and spectral-change heuristics) that can auto-arm drop clips.
- Pioneer **Pro DJ Link** / Denon **StageLinQ** beat and phrase data.
- Text/lyric overlays, live webcam input, and a meme-caption generator.
- Timeline/show mode with timecode.
- A clip-pack import/export format for sharing with other DJs.
- Shader scene support (ISF/GLSL) for generative backgrounds.

---

## First action

Begin **Phase 0** now. Restate the Phase 0 goals, confirm or propose changes to the tech stack, list the files you will create, then implement. Stop at the end of Phase 0 with the Phase Report and wait for approval.
