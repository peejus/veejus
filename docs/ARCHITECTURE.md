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

## Messages (`src/shared/protocol.ts`)

| Channel                 | Direction               | Payload                                                                                                                            |
| ----------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `veejus:to-output`      | control → main → output | `ControlToOutput`: `setBackground`, `ping`, `setDebugOverlay`, `playClip`, `stopClip`, `setLayerSettings`, `requestStatus`         |
| `veejus:to-control`     | output → main → control | `OutputToControl`: `outputReady`, `pong`, `frameStats`, `backgroundApplied`, `clipState`, `clipStarted`, `clipEnded`, `mediaStats` |
| `veejus:main-request`   | control → main (invoke) | `MainRequest` → `MainResponse` (displays, fullscreen, library import/remove)                                                       |
| `veejus:output-state`   | main → control          | `OutputWindowState` (display, fullscreen, visible)                                                                                 |
| `veejus:output-command` | output → main           | `OutputCommand`: `exitFullscreen`, `toggleFullscreen`                                                                              |
| `veejus:library`        | main → control, output  | `ClipInfo[]`, the whole library, after every change                                                                                |
| `veejus:get-library`    | output → main (invoke)  | current `ClipInfo[]`                                                                                                               |

Main checks the sender of every message and runs the matching `is…` guard before acting on or forwarding it.

## Source layout

```
src/
  main/         Electron main process: windows, IPC, library, media protocol
  preload/      contextBridge APIs, one per window
  shared/       protocol types + guards, media types, HTTP range parsing, colors
  core/         pure TypeScript engine modules (no DOM/Electron); unit-tested
                FrameStats, FrameTimeline, LruBudget, fitRect.
                Later: BeatClock, Scheduler, analysis, ...
  renderer/
    control/    React control UI: LibraryPanel, PlaybackPanel, probe queue, hooks
    output/     Stage (WebGL2), ClipLayer, media/ (MediaManager, VideoClip, ImageClip)
tests/
  unit/         Vitest, for core/, shared/ and main/library
  e2e/          Playwright driving the built Electron app (smoke, library, stress)
scripts/        make-fixtures.mjs (ffmpeg test media)
fixtures/       media/ (committed), stress/ (generated, gitignored)
```

## Seams for later phases

- `ClipLayer` becomes one of several layers in a compositor (Phase 5). `Stage.drawTexture` already takes a rect and an opacity.
- `src/core/` gets the `BeatClock` (Phase 3), the single source of musical time. `ClipLayer.play()` currently starts on the next frame. Phase 4 adds a scheduled start time from the clock.
- `ImageClip` timing (`FrameTimeline`) is speed-scaled elapsed time. Phase 4 can drive the elapsed time from beats to tempo-sync GIFs.
