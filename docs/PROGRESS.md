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

## Phase 1: Clip library and basic playback (completed and approved 2026-10-19)

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

**Approval notes (2026-10-19):** Phase 2 was started without answers to these questions, so the recommended defaults stand:

- Software video decoding stays the default.
- The budgets stay at 768 MB of images and 16 warm videos.
- Library persistence waits for Phase 8.

---

## Phase 2: Audio input and analysis (completed 2026-10-19, awaiting approval)

### What was built

**Audio engine** (in the output window, next to the renderer and the future beat clock)

- One `AudioContext` and an AudioWorklet that runs the analyzer on the audio thread. Nothing is connected to the speakers, so Veejus never makes sound.
- Sources, all switchable at runtime without a restart:
  - **Input devices:** mixer or interface inputs, with echo cancellation, noise suppression and auto-gain turned off so analysis sees the true signal.
  - **System audio:** Windows loopback of whatever the PC is playing, handy when DJ software runs on the same machine.
  - **Test beat:** a built-in, silent 120 BPM house loop, for trying everything without a mixer.
  - **Off:** suspends the context.
- A device unplugged mid-set shows "Input disconnected" rather than failing silently. The device list refreshes when devices change.

**Analysis** (`src/core/audio/`, pure TypeScript shared by the live worklet, the tests and the harness)

- 1024-point FFT every 256 samples: about 5.3 ms steps at 48 kHz.
- **4 bands:** bass, low-mid, mid, high, with configurable crossovers (default 150 / 800 / 4000 Hz). Each band has an attack/release envelope follower and its own gain. Input gain is ±24 dB. RMS, peak and a clip flag are reported. The spectrum display uses 64 log-spaced bins.
- **Onset detection:** spectral flux on two ranges, kick (30–180 Hz) and snare/clap/hat (2.5–16 kHz). It uses SuperFlux (a lag of 2 hops, max-filtered across ±1 bin, so a kick's falling pitch doesn't re-trigger). Peak picking has 1-hop lookahead, an adaptive mean threshold, and an absolute floor so steady noise doesn't trigger.
- **Recent-hit gate:** a hit must reach 50% of the second-strongest onset of the last 1.5 s. This removes bass-note and kick/bass beating triggers, and using the second-strongest means one huge first kick of a drop can't mask the ones after it.
- **Minimum spacing:** 90 ms for kicks, 50 ms for snare/hat, unless the new hit is more than twice as strong. Changing the input gain resets the adaptive levels.
- **Timing:** onset times are compensated for window position. The measured bias is about +1–3 ms.
- **Latency:** about 14 ms from sound entering the analyzer to the output knowing, plus the audio interface's own input latency. That part is measured and corrected in Phase 3 with a manual offset.

**Control UI: Audio input panel**

- Source picker plus a refresh button, a status line (state, source, sample rate, errors) and an input gain slider.
- **Meters:** a level meter with peak marker and a CLIP light, four band bars, and a spectrum. They're drawn per frame from the latest data without React re-renders.
- **Onset lamps:** **Kick** and **Snare / hat**, each with a running count.
- **Analysis settings** (collapsible): sensitivities, attack/release, crossovers and per-band gains.

**Output debug overlay** now shows the audio source, analysis latency, band levels and onset counts.

**Offline tools**

- `npm run analyze -- <file> [--truth t.json] [--csv out.csv]` runs the same analyzer over any audio file: WAV natively, MP3, FLAC and others through ffmpeg. It prints kick and snare/hat counts and a rough tempo, scores against ground truth, and can export onsets. It runs about 150× faster than real time.
- `npm run fixtures:audio` writes the synthetic patterns as WAV files with ground-truth JSON to `fixtures/audio/` (gitignored).

### Accuracy (offline, on synthesized drums with exact ground truth)

The synth renders kicks with a pitch drop, snares, claps, hats, an offbeat band-limited bassline and noise floors.

| Case                                                              | Kick recall          | Kick false positives | Timing (±15 ms window)     |
| ----------------------------------------------------------------- | -------------------- | -------------------- | -------------------------- |
| Kick only, 120 BPM                                                | 100%                 | 0%                   | +0.8 ms mean, 2.8 ms worst |
| House 124 (kick, clap, hats, bass)                                | 100%                 | 0%                   | +1.2 ms mean, 3.8 ms worst |
| Techno 132 (16th hats)                                            | 100%                 | 0%                   | +1.8 ms mean, 4.5 ms worst |
| Drum & bass 174 (two-step, bass)                                  | 100%                 | 0%                   | +1.8 ms mean, 4.8 ms worst |
| House at 90 / 128 / 140 / 174 BPM, 44.1 kHz, −42 dB, −35 dB noise | ≥95%                 | <5%                  | within ±15 ms              |
| −12 dB fader drop / gain change mid-track                         | 100% straight after  | —                    | —                          |
| Silence, or steady −20 dBFS noise                                 | no triggers (<0.5/s) | —                    | —                          |

Snare/clap/hat: 100% recall with 0% false positives on house and drum & bass. Techno 16th hats score 87.5%; the misses are hats directly after a snare, masked by its tail.

### How to run

```bash
npm run dev
```

In **Audio input**, pick **Test beat**, your mixer input, or **System audio**.

### Test results

- `npm run typecheck` and `npm run lint`: clean.
- `npm run test:unit`: **84 passing**.
  - 37 new DSP tests:
    - FFT, envelope follower
    - band routing and level calibration, crossovers and band gains
    - RMS/peak and gain
    - hop timing, block-size independence, spectrum
    - WAV round-trips, guards
  - 19 accuracy tests (the table above).
- `npm run test:e2e`: **35 passing**. The 8 new audio tests:
  - device listing, with Chromium's fake devices
  - test-beat kick rate of 2.0/s ±10%, and the snare/hat rate
  - analysis latency under 40 ms
  - meters, counts and lamps updating in the control window
  - input gain lowering levels while kicks are still found
  - switching from the test beat to a device and back without a restart
  - Windows system-audio loopback starting
  - **Off** stopping analysis and zeroing the meters
  - 60 fps with 0 dropped frames while audio runs
- Phase 0 and 1 suites are unchanged and still pass (50-clip stress: output 59.8–60 fps).

### Manual test script

1. Run `npm run dev`. In **Audio input**, choose **Test beat (120 BPM, silent)**. **Expected:**
   - The status reads "Running · Test beat 120 BPM · 48 kHz".
   - The Bass bar pumps.
   - The **Kick** lamp flashes pink twice a second, and the **Snare / hat** lamp flashes cyan.
   - The counts climb.
2. Drag **Input gain** to −24 dB. **Expected:** the bars drop, and the kick lamp keeps flashing on every beat. Set it back to 0 dB.
3. **With real music** (the actual acceptance test):
   1. Pick your mixer or audio-interface input, or **System audio** and play a four-on-the-floor track on this PC.
   2. **Expected:** the Bass bar pulses on kicks, and the **Kick** lamp fires on most kicks without firing on bass notes or vocals. The level meter should sit mostly green; if the CLIP light shows, lower the input gain.
4. Switch between your input, **System audio**, **Test beat** and **Off** while music plays. **Expected:** each switch takes effect within about a second with no restart, and **Off** stops the lamps and empties the meters.
5. Open **Analysis settings** and try **Kick sensitivity** at 20% and 80% on a busy track. **Expected:** fewer and more kick flashes, respectively.
6. Unplug a USB audio interface while it's selected, if you have one. **Expected:** the status shows "Error · Input disconnected", and the app keeps running.
7. Try the harness on a real track:

   ```bash
   npm run analyze -- "C:\path\to\a\track.mp3"
   ```

   **Expected:** a kicks-per-minute rate and a "kick spacing suggests ~N BPM" close to the track's real tempo (or half or double it).

### Decisions and defaults (flag any you want changed)

- **The audio engine lives in the output window,** not the control window. It's beside the renderer and the coming beat clock, and away from React re-renders. The control window gets meters at 30 Hz plus instant onset events.
- **Onset ranges are fixed** (kick 30–180 Hz, snare/hat 2.5–16 kHz) and independent of the four display/reactivity bands. The bands are for visuals; the onset ranges are tuned for detection.
- **A kick's beater click counts as a "high" onset.** Real kicks have a high-frequency transient. Phase 4/6 visuals that want "snare only" may need a separate snare detector later.
- **System audio uses screen-capture loopback,** the only way Chromium/Electron exposes it. Windows doesn't show a capture prompt; the screen video track is dropped immediately.
- **Audio settings are not saved between runs yet** (Phase 8). Each launch starts with audio Off.

### Known issues / limitations

- **Tuned on synthesized drums.** Real mixes, with sidechained bass, reverb tails and live drums, will behave somewhat differently. The real-music check in the manual script, plus `npm run analyze` on your own tracks, is the honest test. Please report tracks where kicks are missed or bass notes trigger.
- **Masked hats:** 16th-note hats directly after a loud snare are often missed (87.5% recall on the techno pattern).
- **Input-device latency is not measured.** The analysis latency shown (~14 ms) excludes the audio interface's own buffer. Phase 3 adds a manual latency offset.
- **Loopback was only checked to start.** Analysis accuracy through it wasn't verified with audible playback, because that would play sound on this machine during testing.
- **macOS has no system-audio option** in this build; the item shows an error there.

### Open questions for you

1. Do you mostly feed Veejus from a mixer or interface input, or from system audio (DJ software on the same laptop)? That affects which latency defaults to pick in Phase 3.
2. Should audio settings (source, gain, sensitivities) persist between launches now, rather than waiting for Phase 8? Re-picking the input at every gig is a likely annoyance.
3. Can you try a few real tracks you'd actually play, through the panel or `npm run analyze`, and tell me how the kick lamp behaves? That's the best way to tune the detector before Phase 3 builds tempo tracking on it.
