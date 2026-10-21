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

## Pads and triggering

```
 control: usePads (banks of PadConfig, owned here) ──padPress / padRelease / padArm (PadSpec)──▶ output
          keys (usePadShortcuts), clicks, drag-from-library                                       │
                                                                          TriggerScheduler (src/core/trigger)
 output frame:  BeatEngine.update(now) ─▶ TriggerScheduler.update(now, frameMs, clock) ─▶ actions
                ─▶ ClipLayer.play / restart / stop (owner = pad) ─▶ opacity + tempo-sync speed ─▶ render
                ─▶ 'triggerState' to control on change (and ~10/s while a drop counts down)
```

- **Specs, not layouts:** the control window owns pad layouts and sends a resolved `PadSpec` with each press, so the output never needs the grid. The output resolves clips (`candidates`: one clip, or a folder/random set minus unreadable clips) and preloads them on press.
- **`TriggerScheduler`** works in beat positions of the visual timeline (`BeatClock.boundaryAfter` / `boundaryAtOrBefore` for quarter, beat, bar and phrase, respecting the resynced downbeat).
  - Actions fire on the frame nearest their boundary.
  - A press within 80 ms after a boundary fires at once.
  - It holds queued starts and stops, the armed set with its shared drop position, and the single showing voice: start position, end for N-beat or fading stops, next retrigger.
- **`ClipLayer`:**
  - **Owner:** tags its clip with the owning pad, so a natural one-shot end (`finished`) clears the pad, while a replacement or stop doesn't.
  - **Per frame:** takes opacity (fades) and a speed override (tempo sync = clip length ÷ N beats).

## Layers and compositing

```
 frame:  beat.update ─▶ scheduler.update (voices per layer) ─▶ ClipLayer.play/restart/stop per layer
         takeover active? ─▶ pause / dim / hide lower layers
         Stage.beginFrame(bg) ─▶ for Background, Overlay A, Overlay B, Takeover:
             ClipLayer.render ─▶ placeClip(placement, entrance progress, random spot) ─▶ Stage.drawLayer
                 (copy composite ─▶ layer shader: unpremultiply, key, opacity, blend vs copy)
         Stage.endFrame(master brightness / blackout) ─▶ screen
         Stage.requestPreview / takePreview (PBO + fence, async) ─▶ 'previewFrame' to control
```

- **Layer state:** `src/shared/layers.ts` holds the layer ids and config (opacity, blend, mute, solo), takeover mode, master, `Placement` and `KeySettings`.
- **Ownership:** the control owns the layer mix (`useLayers`) and sends the whole `LayersConfig` on change. Pads carry a resolved `layer`, `placement` and `key` in their `PadSpec` (`autoLayer` picks by mode, and Takeover for drops).
- **`placeClip`** (`src/core/placement.ts`) is pure. It turns a placement plus entrance progress (beats since the pad started ÷ entrance beats) into a center/size/rotation transform.
- **`Stage`:**
  - **Targets:** owns two accumulation render targets (composite + copy) at canvas size, plus a small preview target and a pixel-pack buffer.
  - **Blending:** all blending happens in `LAYER_FS` against the copy, so blend modes don't depend on fixed-function GL blending.
  - **Textures:** clip textures are premultiplied (video via the upload flag, images via premultiplied ImageBitmaps).

## Effects and modulation

```
 frame:  ctx = { beat position, bar offset, phrase length, last kick/high positions, band levels }
         resolveChain(chain, ctx) for each layer + master   (pure, src/core/modulation)
             base params + Σ amount · lerp(min, max, source)  ─▶ clamped to each param's range
         ClipLayer.render: transform += scale / rotation / move offsets; opacity += offset
         Stage.drawLayer: no active effects ─▶ direct composite (as before)
                          otherwise ─▶ clip alone onto transparent fxA ─▶ effect passes
                                       (ping-pong fxA/fxB; feedback uses its own history pair)
                                       ─▶ composite result with the layer's blend/opacity
         Stage.endFrame: master chain over the composite ─▶ master pass (brightness + master
                         zoom/rotate/move) ─▶ screen (and the preview)
```

- **Types:** `src/shared/fx.ts` holds `EFFECT_DEFS` (every effect, its parameters and ranges), `Modulator` and `ModSource`, `FxConfig` (one chain per layer plus master), the presets and the guards.
- **Ownership:** the control owns the config (`useFx`) and sends the whole `FxConfig` on every change (`setFx`), like the layer mix.
- **Time base:** every musical source is a function of the beat clock's **position in beats**, never of wall time.
  - LFOs: `phase = frac((pos + barOffset) / period + offset)`. The clock position is continuous and only moves forward, so tempo changes never make an LFO jump.
  - Envelopes: shaped by beats elapsed since the last trigger. Beat, backbeat, bar and phrase triggers are computed from the position. Kick and high triggers store the clock position when the onset message arrives.
- **Targets:** modulator targets are `opacity`, `scale`, `rotation`, `x`, `y` (chain parameters), or `<effectId>.<param>`. On the master, `opacity` adds to brightness and the transform parameters move the whole frame.
- **Effect shader:** one program (`effectShader.ts`) with a type switch. It works in premultiplied RGBA, so layer chains keep transparency.
  - **Zero-cost when idle:** an effect at zero strength (`effectIsActive`) is skipped. A layer with no active effects takes the original direct path.
  - **Feedback history:** kept per scope and effect id, and freed after 2 unused frames.

## Messages (`src/shared/protocol.ts`)

| Channel                 | Direction               | Payload                                                                                                                                                                                                                                                           |
| ----------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `veejus:to-output`      | control → main → output | `ControlToOutput`: `setBackground`, `ping`, `setDebugOverlay`, `playClip`, `stopClip`, `setLayerSettings`, `requestStatus`, audio/beat/pad commands, `setLayers`, `setMaster`, `setPreview`, `stopLayer`, `setFx`                                                 |
| `veejus:to-control`     | output → main → control | `OutputToControl`: `outputReady`, `pong`, `frameStats`, `backgroundApplied`, `clipState`, `clipStarted`, `clipEnded`, `mediaStats`, `audioStatus`, `audioDevices`, `audioMeters`, `audioOnset`, `beatState`, `beat`, `triggerState`, `layerState`, `previewFrame` |
| `veejus:main-request`   | control → main (invoke) | `MainRequest` → `MainResponse` (displays, fullscreen, library import/remove)                                                                                                                                                                                      |
| `veejus:output-state`   | main → control          | `OutputWindowState` (display, fullscreen, visible)                                                                                                                                                                                                                |
| `veejus:output-command` | output → main           | `OutputCommand`: `exitFullscreen`, `toggleFullscreen`                                                                                                                                                                                                             |
| `veejus:library`        | main → control, output  | `ClipInfo[]`, the whole library, after every change                                                                                                                                                                                                               |
| `veejus:get-library`    | output → main (invoke)  | current `ClipInfo[]`                                                                                                                                                                                                                                              |

Main checks the sender of every message and runs the matching `is…` guard before acting on or forwarding it.

## Source layout

```
src/
  main/         Electron main process: windows, IPC, library, media protocol
  preload/      contextBridge APIs, one per window
  shared/       protocol types + guards; audio, beat, pad, layer and fx types + guards; media
                types, HTTP range, colors
  core/         pure TypeScript engine modules (no DOM/Electron); unit-tested
                FrameStats, FrameTimeline, LruBudget, fitRect, placeClip.
                audio/: RealFft, EnvelopeFollower, OnsetDetector, AudioAnalyzer,
                        synth (test patterns), wav, evaluate (scoring + offline runs)
                beat/:  TempoEstimator, BeatTracker, TapTempo, ClockSync, BeatClock,
                        BeatEngine, simulate (offline pipeline)
                trigger/: TriggerScheduler, pickRandom
                modulation/: LFOs, beat envelopes, audio sources, resolveChain
  renderer/
    control/    React control UI. App = status bar + left column (PadGrid, Mixer, LibraryPanel)
                + right column (PreviewMonitor, BeatPanel, context panel showing PadEditor,
                FxPanel or ClipInspector) + SetupDrawer (AudioPanel, output/background,
                ClockSettings, diagnostics). Probe queue; hooks (useLayers + blackout key,
                usePads + pad keys, useBeat + tempo keys, useAudio, useFx, useLibrary,
                useOutputLink)
    output/     Stage (WebGL2 compositor + effect chains), effectShader, ClipLayer x4, media/ (MediaManager, VideoClip, ImageClip),
                audio/ (AudioEngine, analysis.worklet), metronome
tests/
  unit/         Vitest, for core/, shared/ and main/library
  e2e/          Playwright driving the built Electron app (smoke, library, stress)
scripts/        make-fixtures.mjs (ffmpeg test media), make-audio-fixtures.ts,
                analyze-audio.ts (offline analysis harness), ffmpeg.ts
fixtures/       media/ and keying/ (committed); stress/, perf/ and audio/ (generated, gitignored)
```

## Seams for later phases

- **Phase 7 (MIDI):** a MIDI CC can drive any `FxConfig` number through the same target strings (`opacity`, `<effectId>.<param>`). A "MIDI" `ModSource` kind would slot into `sourceValue`.
- **Phase 8 (saving):** `FxConfig`, `LayersConfig` and the pads are plain JSON with guards, ready to save in a set file.
