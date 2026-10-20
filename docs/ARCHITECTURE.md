# Veejus architecture

## Processes and windows

```
 ┌──────────────────────────────┐        ┌───────────────────────────────┐
 │ Control window (React)       │        │ Output window (WebGL2 canvas) │
 │ src/renderer/control         │        │ src/renderer/output           │
 │  - library pads, probing     │        │  - MediaManager (preload/LRU) │
 │  - playback + output UI      │        │  - ClipLayer + Stage (WebGL2) │
 │  - sends ControlToOutput     │        │  - sends OutputToControl      │
 └──────────────┬───────────────┘        └───────────────┬───────────────┘
   preload/control.ts                       preload/output.ts
   (window.veejus: ControlBridge)           (window.veejus: OutputBridge)
                │  ipc          veejus-media://clip/<id>  │  ipc
                ▼                     (both windows)      ▼
 ┌───────────────────────────────────────────────────────────────────────┐
 │ Main process  src/main/                                               │
 │  index.ts         windows, display/fullscreen, IPC routing + guards   │
 │  library.ts       the clip library (id -> file); folder scanning      │
 │  mediaProtocol.ts serves library files, with Range support, to both   │
 │                   renderers; unknown ids get 404                      │
 └───────────────────────────────────────────────────────────────────────┘
```

- The **output window** has `backgroundThrottling: false` so it renders at full rate when unfocused, and it hides instead of closing. It owns no app state beyond what control and main send it, so a busy control UI cannot stall rendering.
- Both renderers run with `contextIsolation`, `sandbox` and no Node integration. Preloads are built as self-contained CommonJS bundles (`isolatedEntries`), because sandboxed preloads cannot load sibling chunks.
- Chromium switches set in main:
  - `disable-media-suspend`: keeps paused, preloaded video players decoded.
  - `autoplay-policy=no-user-gesture-required`.
  - `disable-accelerated-video-decode`: software decoding. Hardware decoder start-up stalls the GPU process. Opt back in with `VEEJUS_HW_VIDEO_DECODE=1`.

## Media pipeline

1. **Import.** Control sends `importPaths`, or `pickAndImport` for the native dialog. Main scans folders recursively (natural sort, depth and count limits) and registers supported files under a stable id (a hash of the path). Then it broadcasts the whole library on `veejus:library` to both windows.
2. **Probe (control).** `ProbeQueue` reads each clip three at a time, for a PNG thumbnail plus metadata: size, duration or frame count, and whether the sampled frame has transparency. Pads fill in progressively.
3. **Preload (output).** `MediaManager.sync()` queues every new clip, two at a time:
   - **Video:** a detached, muted `<video>` paused on frame 0 (`VideoClip`).
   - **Animated images and stills:** all frames decoded up front with WebCodecs `ImageDecoder` into premultiplied `ImageBitmap`s (`ImageClip`).
   - **Budgets:** two `LruBudget`s cap memory, one for image bytes (768 MB) and one for warm videos (16).
   - **Eviction:** background preloads only fill free space. A play request can evict least-recently-used clips, but never the one on screen, which is pinned.
   - **Reporting:** the output reports `clipState` (cold, loading, ready, error) for each clip to control.
4. **Play.** `playClip` goes to `ClipLayer`.
   - **A ready clip** starts on the next rendered frame. Its first drawn frame is reported as `clipStarted` with `waitFrames`.
   - **A cold clip** loads first.
   - **Each frame**, the layer uploads the current frame to a texture: video frames via `requestVideoFrameCallback`, image frames via `FrameTimeline`. It then draws a premultiplied-alpha quad placed by `fitRect`.

## Audio pipeline

```
 input (device getUserMedia | system loopback getDisplayMedia | synthesized test beat)
   │  output window: AudioEngine (src/renderer/output/audio/audioEngine.ts)
   ▼
 MediaStreamSource / BufferSource ─▶ AudioWorkletNode "veejus-analysis" ─▶ gain 0 ─▶ destination
                                       │ (audio thread: AudioAnalyzer from src/core/audio)
                                       ├─ onset   (immediately, with detection delay)
                                       ├─ bands   (every 2 hops, ~94/s) → AudioEngine.snapshot (visuals)
                                       └─ meters  (~30/s, with 64-bin spectrum)
   output main thread ──▶ control: audioOnset (immediately), audioMeters (30/s), audioStatus, audioDevices
```

- **`AudioAnalyzer`** (`src/core/audio/analyzer.ts`) is pure TypeScript and block-size independent. It runs a 1024-point FFT every 256 samples and produces:
  - envelope-followed levels for 4 bands
  - RMS and peak
  - SuperFlux onsets for kicks (30–180 Hz) and snares/hats (2.5–16 kHz), picked by `OnsetDetector`: an adaptive mean threshold, an absolute floor, a gate on the second-strongest recent onset, and minimum spacing.

  The same class runs in the worklet, the unit tests (`analyzeOffline`) and `npm run analyze`.

- **`synth.ts`** renders drum patterns with exact ground-truth hit times; `scoreOnsets` measures recall, false positives and timing. These back the accuracy tests and the built-in test beat.
- **Onset times** reach the output main thread with a detection delay. `AudioEngine` converts them to `performance.now()` time (`onOnset(..., atMs)`), ready for the Phase 3 beat clock.
- **Main** grants `media` permission only to the output window, and only for audio. On Windows it answers `getDisplayMedia` with the primary screen plus `audio: 'loopback'`; the output drops the video track.

## Beat clock

```
 worklet ──flux batch (8 hops, with stream time)──▶ BeatEngine.observeSync + pushFlux ──▶ TempoEstimator
         ──onset (stream time, strength, flux)───▶ BeatEngine.pushOnset ─────────────▶ BeatTracker (PLL)
                                                                                         │ period + beat time
 control ──beatCommand (tap, setBpm, nudge…)─────▶ BeatEngine.command ──▶ TapTempo      ▼ (via ClockSync)
                                                                        BeatClock (performance.now, visual timeline)
 output render loop, every frame: BeatEngine.update(now) ──▶ beat events ──▶ overlay metronome, control 'beat'
                                                         └─▶ 'beatState' to control ~10/s
```

- **`TempoEstimator`**: harmonic autocorrelation of the onset-strength signal over 8 s, every 0.5 s. It resolves octaves (preferring the faster tempo when it is ≥70% as supported) and reports a confidence.
- **`BeatTracker`** works in stream seconds. A PLL on kick onsets (snare/hat fallback) ignores weak off-beat onsets, re-acquires on a consistent strong phase change, and measures the period precisely from on-beat hits.
- **`BeatEngine`** smooths and confirms tempo, handles auto/locked modes, ×2/÷2 and the manual commands. It converts stream time to `performance.now()` through `ClockSync`, which uses the minimum message-delivery offset.
- **`BeatClock`** is the single source of musical time for everything visual. It is monotonic, converges instead of jumping, applies the latency offset, and counts bars (barOffset set by resync) and phrases.
- **`simulate.ts`** runs analyzer plus engine in simulated time with message jitter. It is used by the accuracy tests and `npm run analyze`.

## Messages (`src/shared/protocol.ts`)

| Channel                 | Direction               | Payload                                                                                                                                                                                                             |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `veejus:to-output`      | control → main → output | `ControlToOutput`: `setBackground`, `ping`, `setDebugOverlay`, `playClip`, `stopClip`, `setLayerSettings`, `requestStatus`                                                                                          |
| `veejus:to-control`     | output → main → control | `OutputToControl`: `outputReady`, `pong`, `frameStats`, `backgroundApplied`, `clipState`, `clipStarted`, `clipEnded`, `mediaStats`, `audioStatus`, `audioDevices`, `audioMeters`, `audioOnset`, `beatState`, `beat` |
| `veejus:main-request`   | control → main (invoke) | `MainRequest` → `MainResponse` (displays, fullscreen, library import/remove)                                                                                                                                        |
| `veejus:output-state`   | main → control          | `OutputWindowState` (display, fullscreen, visible)                                                                                                                                                                  |
| `veejus:output-command` | output → main           | `OutputCommand`: `exitFullscreen`, `toggleFullscreen`                                                                                                                                                               |
| `veejus:library`        | main → control, output  | `ClipInfo[]`, the whole library, after every change                                                                                                                                                                 |
| `veejus:get-library`    | output → main (invoke)  | current `ClipInfo[]`                                                                                                                                                                                                |

Main checks the sender of every message and runs the matching `is…` guard before acting on or forwarding it.

## Source layout

```
src/
  main/         Electron main process: windows, IPC, library, media protocol
  preload/      contextBridge APIs, one per window
  shared/       protocol types + guards, audio and beat types + guards, media types, HTTP range, colors
  core/         pure TypeScript engine modules (no DOM/Electron); unit-tested
                FrameStats, FrameTimeline, LruBudget, fitRect.
                audio/: RealFft, EnvelopeFollower, OnsetDetector, AudioAnalyzer,
                        synth (test patterns), wav, evaluate (scoring + offline runs)
                beat/:  TempoEstimator, BeatTracker, TapTempo, ClockSync, BeatClock,
                        BeatEngine, simulate (offline pipeline)
                Later: Scheduler (Phase 4), ...
  renderer/
    control/    React control UI: BeatPanel, LibraryPanel, PlaybackPanel, AudioPanel, probe queue,
                hooks (useBeat + keyboard shortcuts, useAudio, useLibrary, useOutputLink)
    output/     Stage (WebGL2), ClipLayer, media/ (MediaManager, VideoClip, ImageClip),
                audio/ (AudioEngine, analysis.worklet), metronome
tests/
  unit/         Vitest, for core/, shared/ and main/library
  e2e/          Playwright driving the built Electron app (smoke, library, stress)
scripts/        make-fixtures.mjs (ffmpeg test media), make-audio-fixtures.ts,
                analyze-audio.ts (offline analysis harness), ffmpeg.ts
fixtures/       media/ (committed), stress/ and audio/ (generated, gitignored)
```

## Seams for later phases

- `ClipLayer` becomes one of several layers in a compositor (Phase 5). `Stage.drawTexture` already takes a rect and an opacity.
- Phase 4's scheduler reads `BeatClock` positions and `BeatEvent.atMs` to quantize triggers to beat/bar/phrase on the visual timeline. `ClipLayer.play()` currently starts on the next frame. Phase 4 adds a scheduled start time from the clock.
- `ImageClip` timing (`FrameTimeline`) is speed-scaled elapsed time. Phase 4 can drive the elapsed time from beats to tempo-sync GIFs.
