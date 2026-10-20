# Veejus architecture

## Processes and windows

```
 ┌───────────────────────────┐        ┌──────────────────────────────┐
 │ Control window (React)    │        │ Output window (WebGL2 canvas) │
 │ src/renderer/control      │        │ src/renderer/output           │
 │  - UI, settings, meters   │        │  - render loop (rAF)          │
 │  - sends ControlToOutput  │        │  - sends OutputToControl      │
 └─────────────┬─────────────┘        └───────────────┬──────────────┘
   preload/control.ts                      preload/output.ts
   (window.veejus: ControlBridge)          (window.veejus: OutputBridge)
               │  ipc                                  │  ipc
               ▼                                       ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │ Main process  src/main/index.ts                                  │
 │  - creates both windows, owns display/fullscreen management      │
 │  - validates every message (src/shared/protocol.ts guards)       │
 │  - forwards control <-> output messages unchanged                │
 │  - answers MainRequest (displays, fullscreen, move output)       │
 │  - pushes OutputWindowState to control on any change             │
 └──────────────────────────────────────────────────────────────────┘
```

- The **output window** has `backgroundThrottling: false` so it renders at full rate when unfocused, and it hides instead of closing. It owns no app state beyond what control sends it, so a busy control UI cannot stall rendering.
- Both renderers run with `contextIsolation`, `sandbox` and no Node integration. Preloads are built as self-contained CommonJS bundles (`isolatedEntries`), because sandboxed preloads cannot load sibling chunks.

## Messages (`src/shared/protocol.ts`)

| Channel                 | Direction               | Payload                                                                     |
| ----------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `veejus:to-output`      | control → main → output | `ControlToOutput`: `setBackground`, `ping`, `setDebugOverlay`               |
| `veejus:to-control`     | output → main → control | `OutputToControl`: `outputReady`, `pong`, `frameStats`, `backgroundApplied` |
| `veejus:main-request`   | control → main (invoke) | `MainRequest` → `MainResponse`                                              |
| `veejus:output-state`   | main → control          | `OutputWindowState` (display, fullscreen, visible)                          |
| `veejus:output-command` | output → main           | `OutputCommand`: `exitFullscreen`, `toggleFullscreen`                       |

Main checks the sender of every message and runs the matching `is…` guard before acting on or forwarding it.

## Source layout

```
src/
  main/         Electron main process
  preload/      contextBridge APIs, one per window
  shared/       protocol types + guards, small helpers shared by every process
  core/         pure TypeScript engine modules (no DOM/Electron); unit-tested
                Phase 0: FrameStats. Later: BeatClock, Scheduler, analysis, ...
  renderer/
    control/    React control UI
    output/     output page: Stage (WebGL2) + render loop + debug overlay
tests/
  unit/         Vitest, for core/ and shared/
  e2e/          Playwright driving the built Electron app
fixtures/       generated test media and audio (from Phase 1)
```

## Seams for later phases

- `Stage.draw()` becomes the layer compositor (Phase 1 and 5).
- `src/core/` gets the `BeatClock` (Phase 3), the single source of musical time. The output render loop will read clock time once per frame and hand it to the scheduler and layers.
- `ControlToOutput` grows clip, layer and trigger messages. Each one gets a guard and a unit test.
