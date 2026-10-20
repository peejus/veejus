# Veejus progress

## Phase 0: Foundation and skeleton (completed and approved 2026-10-19)

### What was built

- Electron 44 + Vite 8 (via electron-vite 6) + TypeScript 6 + React 19 project, with ESLint, Prettier, Vitest and Playwright.
- **Two windows:**
  - **Veejus Control** (React): background color picker and swatches, a debug overlay toggle, an output display list with "Send output here", fullscreen control, and live output FPS, frame time and IPC ping.
  - **Veejus Output**: a full-window WebGL2 canvas with a `requestAnimationFrame` render loop that clears to the chosen color, plus a debug overlay showing FPS, average and max frame time, dropped frames, canvas size and the current color.
- **Typed IPC protocol** in `src/shared/protocol.ts`. Main validates and routes every message, and only accepts messages from the expected window.
- **Latency measurements** built in:
  - IPC round trip: the control window pings the output once a second.
  - Color-change latency: the time from sending a color until the output has drawn a frame with it.
- `FrameStats` (rolling frame timing) as the first pure `core/` module.
- Output window behavior:
  - Can be moved to any display.
  - Fullscreen on demand. Esc exits and F11 toggles; these keys are handled both in main and in the page.
  - Hides instead of closing.
  - Keeps rendering when unfocused.
  - Recovers from WebGL context loss.

### How to run

```bash
npm install
npm run dev
```

### Test results

- `npm run typecheck`: clean. `npm run lint`: clean.
- `npm run test:unit`: 12 passing (FrameStats, protocol guards, color helpers).
- `npm run test:e2e`: 9 passing. They launch the built app and verify:
  - Both windows open.
  - The render loop runs.
  - Ping/pong works.
  - A color set in control reaches the output.
  - The debug overlay toggles.
  - Fullscreen on and off works, including Esc.
  - The display list loads.
  - On a machine with two or more displays, the output moves to another display in fullscreen and comes back.
- Measured on the dev machine (Dell U2717D at 2560×1440 plus a 24E2QA at 1920×1080):
  - Output: 60.0 fps, 16.68 ms average frame time, 0 drops.
  - IPC ping: ~0.4 ms.
  - Color change drawn ~11 ms after sending, under one 60 Hz frame.

### Manual test script

1. Run `npm run dev`. **Expected:** two windows open, "Veejus Control" and "Veejus Output" (black, with a green-on-black stats box in the top-left).
2. In Control, check the top bar. **Expected:** "● Output connected", about 60 fps, and an IPC time under 2 ms.
3. Click the hot-pink swatch. **Expected:** the output turns pink immediately. "Last change drawn in …" shows a value under ~17 ms.
4. Drag inside the color picker. **Expected:** the output follows smoothly with no lag.
5. Untick **Debug overlay**. **Expected:** the stats box disappears from the output. Tick it again and it returns.
6. Under **Displays**, click **Send output here** on your second monitor. **Expected:** the output window jumps to that monitor, and "output here" moves to that row.
7. Click **Go fullscreen**. **Expected:** the output fills that monitor, and Fullscreen shows "yes".
8. Click the output window and press **Esc**. **Expected:** it leaves fullscreen. Press **F11**: it goes fullscreen again. Press **F11** again: it leaves.
9. Close the output window with its ✕. **Expected:** it hides, and a **Show output** button appears in Control. Click it and the output returns.
10. Click in the Control window to focus it and leave the output in the background. **Expected:** the FPS stays at ~60, because the output doesn't throttle when unfocused.
11. Close the Control window. **Expected:** the whole app quits.

### Decisions and defaults (flag any you want changed)

- **Kept the default stack.** Electron + web tech gives free, robust decoding of MP4/WebM/GIF/WebP, WebGL2, Web Audio, Web MIDI and easy multi-window support, which covers most of the roadmap. Tauri's webviews vary by OS (WebKit on macOS), which would make video codecs and WebCodecs inconsistent. Native Rust/C++ would mean writing the media and UI layers from scratch.
- **Output rendering uses raw WebGL2** rather than PixiJS for now. A solid color needs no engine. Whether to adopt PixiJS or keep a thin custom layer gets decided at the start of Phase 1, when real textures arrive.
- **Debug overlay is on by default.** It will become a setting later.
- **The output window hides on close** rather than being destroyed, so it can come back instantly.
- **The output window hides the mouse cursor** (it's a show surface).
- **Main handles Esc/F11 via `before-input-event`, and the page forwards them too.** Synthetic input (as used by Playwright) skips the main-process hook.

### Known issues / limitations

- Not tested on macOS.
- The IPC ping can spike to ~150 ms while a window is entering or leaving fullscreen, because of the OS window animation. It recovers immediately and does not affect normal rendering.
- The control renderer bundle is ~577 kB. It loads from local disk, so no code splitting yet.
- `fixtures/` is empty. Generated media and audio fixtures start in Phase 1 and 2. ffmpeg is not installed on this machine, so Phase 1 will generate test clips in code, or install ffmpeg if you agree.

### Open questions for you

1. Is the default stack OK to carry forward (Electron + React + WebGL2)?
2. Do you want PixiJS for the renderer, or a thin custom WebGL layer? I lean toward thin custom: fewer abstractions between the beat scheduler and the GPU.
3. For Phase 1 test clips: may I install ffmpeg (e.g., `winget install ffmpeg`), or should I generate fixtures in code only?

**Approval notes (2026-10-19):**

- Default stack kept.
- Thin custom WebGL layer (no PixiJS).
- ffmpeg installed for fixtures.

---

## Phase 1: Clip library and basic playback (completed 2026-10-19, awaiting approval)

### What was built

**Import**

- Drag and drop files or folders onto the library, or use **Add files…** / **Add folder…** (native dialogs).
- Folders are scanned recursively, with natural sort, a depth limit of 8, and at most 2,000 files per import.
- Unsupported and hidden files are skipped, and duplicates are ignored.
- Each clip gets a stable id (a hash of its path), ready for saved sets in Phase 8.

**Secure media protocol**

- `veejus-media://clip/<id>` serves only files in the library, with HTTP Range support so video can seek.
- Renderers never get file paths or file-system access.

**Library pads**

- Each pad shows a PNG thumbnail and a meta line: duration or frame count, dimensions, format.
- An **α** badge marks clips with transparency. A checkerboard shows transparent areas.
- Hovering plays a live preview: the real GIF/WebP animates, and videos play muted.
- A status dot shows the output's load state:
  - green: ready
  - amber: loading
  - grey: not loaded yet
  - red: error (with the message)
- ✕ removes a clip; **Clear** empties the library.

**Output media manager**

- Preloads every clip in the background, two at a time:
  - Videos are detached, muted `<video>` elements paused on frame 0.
  - GIF, WebP, APNG, PNG and JPEG are fully decoded with WebCodecs `ImageDecoder` into premultiplied `ImageBitmap`s with per-frame timing. GIF delays under 11 ms are treated as 100 ms, as browsers do.
- Two LRU budgets limit memory: 768 MB of decoded image frames and 16 warm video players.
  - Background preloads only fill free space.
  - Playing a cold clip loads it on demand and evicts the least-recently-used clips.
  - The clip on screen is pinned and never evicted.

**Clip layer (WebGL2)**

- One layer, drawn over the background with premultiplied alpha. GIF and WebM alpha composite correctly.
- Settings, all live:
  - **Loop / One-shot:** one-shot clears the layer at the end.
  - **Speed:** 0.25×–4×.
  - **Fit:** contain, cover, stretch, or original size.
- **Stop** clears the layer.
- Clips are always muted.

**Latency reporting**

- The output reports how many frames passed between the play request and the first drawn frame.
- The control shows that count plus the round-trip time ("Last start: 1 frame after the request, 12.6 ms").

**Debug overlay** now also shows the current clip, ready and loading counts, image memory, and warm videos.

**Test fixtures:** `scripts/make-fixtures.mjs`, via `npm run fixtures` and `npm run fixtures:stress`.

- `fixtures/media` (committed): 11 small files, including an alpha WebM, a half-transparent GIF and PNG, animated WebP and APNG, a JPEG, a ProRes MOV (unsupported in Chromium, on purpose), two corrupt files and a `.txt` file.
- `fixtures/stress` (gitignored): 50 clips — 20 MP4, 15 GIF, 10 WebP, 5 WebM.

### How to run

```bash
npm run dev
```

Then drag `fixtures/media` (or any folder of clips) onto the Library panel.

### Test results

- `npm run typecheck` and `npm run lint`: clean.
- `npm run test:unit`: **47 passing**. Covers:
  - FrameTimeline and GIF delay normalization
  - LruBudget eviction and pinning
  - fitRect
  - HTTP Range parsing
  - media type detection
  - the main-process Library (recursive import, natural order, dedupe, removal, stable ids)
  - the new protocol guards
- `npm run test:e2e`: **27 passing**:
  - 9 Phase 0 smoke tests.
  - 15 library tests. They check:
    - import and dedupe, thumbnails, metadata and α badges
    - error pads for the corrupt and ProRes files
    - every clip type starts within one frame
    - GIF/WebP frames advance
    - **pixel-level transparency checks**
    - fit modes, live speed, one-shot vs loop, stop, remove, hover preview
  - 3 stress tests.

**50-clip stress run (dev machine):**

| Measurement                                  | Result                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| All 50 pads shown after import               | ~30 ms                                                                             |
| First thumbnail                              | ~150–240 ms                                                                        |
| All 50 thumbnails                            | ~0.7–1.1 s                                                                         |
| Longest control-window frame gap during load | 17–67 ms                                                                           |
| Output during load                           | 60 fps, max frame ~17 ms                                                           |
| Preloaded after settling                     | 41 ready (16 warm videos, 81 MB of image frames); 9 videos left cold by the budget |
| Start latency for 20 ready pads              | every one 0–1 frame                                                                |
| Cold clip                                    | loads on demand and plays                                                          |

### Manual test script

1. `npm run dev`, then drag the `fixtures/media` folder onto the Library panel. **Expected:**
   - 10 pads appear ("Added 10 clips (1 skipped…)").
   - Within about a second, they show thumbnails and green dots.
   - `corrupt.gif`, `corrupt.mp4` and `prores.mov` show red dots with an error message.
2. Hover `half-alpha.gif` and `countdown.mp4`. **Expected:** they animate in the pad.
3. Pick the pink background swatch, then click `alpha-ball.webm`. **Expected:** an orange ball moves across a pink output, with no black box around it. Click `half-alpha.gif`: the right half is pink (transparent).
4. Click `countdown.mp4`. **Expected:** it starts instantly, and "Last start" says 0 or 1 frame.
5. Drag **Speed** to 2×. **Expected:** the countdown runs twice as fast. Click **1×** to reset.
6. Switch **Fit** between Contain, Cover, Stretch and Original size while `photo.jpg` plays. **Expected:** the image letterboxes, crops to fill, stretches, or shows at 320×240 in the middle.
7. Choose **One-shot**, then click `wave.webp`. **Expected:** it plays once (1 s) and disappears. Switch back to **Loop**.
8. Click **Stop**. **Expected:** the output shows only the background.
9. Hover a pad and click its ✕. **Expected:** the pad disappears.
10. Click a corrupt pad. **Expected:** nothing happens and nothing crashes.
11. Optional, the big import:
    1. Run `npm run fixtures:stress`, then drag `fixtures/stress` in. **Expected:** the UI stays smooth, and thumbnails fill in within about a second.
    2. Watch the debug overlay. **Expected:** about 60 fps while clips preload.
    3. Click pads rapidly. **Expected:** each starts immediately.
12. Try your own silly clips and GIFs. Real-world files are the best test of format coverage.

### Decisions and defaults (flag any you want changed)

- **Software video decoding by default.** Measured: with hardware decoding, each video preload stalled the output for 1–3 frames (33–92 ms frames during a 50-clip import). With software decoding, output frames stayed at ~17 ms. Short, small VJ clips decode cheaply on the CPU. Opt back in with `VEEJUS_HW_VIDEO_DECODE=1`. Phase 8's settings screen should expose this, and it's worth re-measuring with 1080p and 4K background loops in Phase 5.
- **Budgets:** 768 MB of decoded image frames and 16 warm videos. These are constants in `src/renderer/output/media/mediaManager.ts` for now, to become settings later.
- **Animated images are fully decoded up front,** for zero-cost frame switching at show time. A huge GIF (e.g., 1080p × 500 frames ≈ 4 GB) would blow the budget. It still plays alone, because an on-demand load may exceed the budget, but it would evict everything else. Phase 8 hardening should add downscaling or streaming for oversized animations.
- **The control window probes clips independently** of the output (its own decode for thumbnails). That doubles the decoding work on import, but keeps the output free of UI work.
- **Layer settings are global** (one clip layer): Loop/One-shot, Speed and Fit apply to whatever plays next and to the current clip, live. Per-pad play modes come in Phase 4.
- **A play request for a clip that is still loading** starts it when loading finishes, unless another play or stop comes in first.
- **The library is not saved between runs yet.** Saved sets arrive in Phase 8, but the stable clip ids are already in place.

### Known issues / limitations

- **ProRes MOV is unsupported.** That's a Chromium limitation; the pad shows "Unsupported format or codec". H.264 MOV files should work.
- **The α badge only checks the frame the thumbnail is taken from.** A GIF whose transparency only appears in later frames won't get the badge. It still renders transparently.
- **Thumbnails are regenerated every launch** (no cache yet).
- **Nested-control accessibility smell:** the pad is a button that contains a remove button. Fine with a mouse and keyboard; worth revisiting when pads get MIDI/key mapping in Phase 4 and 7.
- **Hardware-decoding behavior is untested on other GPUs.** It was only measured on this machine.

### Open questions for you

1. Is software video decoding OK as the default? (Recommended: yes, with a setting later.)
2. Are the memory budgets OK (768 MB of images, 16 warm videos)? If your laptop has 8 GB of RAM, I'd lower the image budget to ~400 MB.
3. Should the library persist between launches before Phase 8? It's a small addition: save the imported paths to a JSON file and reload them on start.
