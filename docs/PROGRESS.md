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

## Phase 2: Audio input and analysis (completed and approved 2026-10-19)

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

**Approval notes (2026-10-19):** Phase 3 was started without answers to these questions, so the defaults stand:

- No preferred input type is assumed; the latency offset defaults to 0 ms.
- Audio settings are not saved yet (Phase 8).
- Detector tuning stays until real-track feedback.

---

## Phase 3: Beat clock (completed and approved 2026-10-19)

### What was built

All of the beat logic is pure TypeScript in `src/core/beat/`. It runs in the output window, next to the renderer, fed by the audio worklet. A simulator runs it identically offline in fake time for tests and the harness.

**Tempo detection: `TempoEstimator`**

- **Method:** autocorrelates the onset-strength signal (kick plus snare/hat spectral flux, one value per 5.3 ms hop) over the last 8 s, every 0.5 s. Each candidate tempo in the configured range (default 70–180 BPM) is scored by the autocorrelation at 1–4 multiples of its beat period, then refined to a fraction of a BPM.
- **Octave errors** (87 vs 174) resolve toward the faster tempo when it is at least 70% as well supported. Results always fold into the range.
- **Confidence** (0–1) separates music (0.9–1.0) from noise (under 0.3). Estimates below 0.4 are ignored, so a beatless passage can't change the tempo.

**Phase tracking: `BeatTracker`**

- **PLL:** a phase-locked loop on kick onsets. Kicks within ±15% of a predicted beat pull the grid 20% of the way toward them. Snare/hat onsets take over only when there have been no kicks for 2 s (click tracks, kickless music).
- **Off-beat filter:** off-grid onsets weaker than half a typical on-beat hit are ignored, so off-beat bass in a breakdown can't drag the grid off the beat. The memory of hit strength decays only very slowly and resets on a real tempo change.
- **Re-acquisition:** if most recent onsets miss the grid and agree on a different phase (a hard cut to an unsynced track), the grid re-acquires that phase.
- **Precise period:** once in phase, a least-squares fit through the actual on-beat kick times gives the period. It is far more precise than autocorrelation: 128 BPM measured as 128.00 instead of 127.86. This is what lets the clock freewheel through long breakdowns without drifting.

**Tempo smoothing: `BeatEngine`**

- Small changes are smoothed.
- A different tempo must be seen 3 times in a row before it's adopted.
- A precise measured tempo is kept until a real change is confirmed.

**The master clock: `BeatClock`**

- It runs in `performance.now()` time on the visual timeline: latency offset ahead of the audio.
- **No jumps:** its beat position only moves forward. On tempo or phase changes it runs at most ±50% fast or slow and converges within about a beat. Only tap and resync snap it, by at most half a beat, and a beat is never emitted twice.
- **Exposes:** `bpm`, `beatIndex`, `beatPhase`, `beatInBar` (1–4), `barIndex`, `barInPhrase`, `phraseIndex` (phrase length 4/8/16/32 bars), plus a beat event (with exact time) for every beat.
- **`ClockSync`** maps the audio stream's time to `performance.now()` from message arrival times, using the minimum offset with drift creep, and re-locks after pauses.

**Manual control**

- **Tap tempo:** a least-squares fit over up to 16 taps; a 2 s pause starts a new sequence. Taps lock the tempo and put the beat on your taps.
- **Typed BPM** (40–300), **×2 / ÷2**, **Lock tempo / Unlock (Auto)**.
- **Nudge** ±10 ms.
- **Resync 1:** now is beat 1 of the bar, aligned to the nearest beat.
- **Phase correction** on/off, **latency offset** −250 to +250 ms, **phrase length**, and **tempo range** (at least one octave wide).

**Keyboard** (anywhere in the control window, except while typing in a field)

- **Space:** tap
- **Enter:** resync downbeat
- **← / →:** nudge

**Tempo panel** (top of the sidebar)

- A big BPM readout, AUTO/LOCKED badge, detected tempo and a confidence bar.
- Four beat lights (beat 1 pink), Bar · Phrase (bar x/N), and in phase / searching.
- The buttons above, a BPM entry box, and the clock settings.

**Output debug overlay**

- A 4-light metronome in the top-right corner, for checking the grid against what you hear.
- Lines for BPM, mode, confidence, bar/beat/phrase and phase state.

**Harness:** `npm run analyze -- <file>` now also runs full beat tracking. It prints the tempo at 4/8/15/30/60 s and whether it ended in phase.

### Accuracy (offline, full pipeline in simulated time)

The pipeline runs synthesized audio through the analyzer, delivers messages with ±3 ms jitter, and updates the clock at 60 fps. Beats are scored against the true beat grid.

| Case                                                   | Tempo                                                      | Beats after 8 s (±15 ms)            |
| ------------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------- |
| Click tracks 90 / 120 / 128 / 140 / 174                | within ±0.15 BPM by 4 s                                    | 100%, worst 0.9–4.7 ms              |
| House 124, techno 132, drum & bass 174 (offbeat kicks) | correct by 4 s, no octave errors                           | 100%                                |
| 3 minutes of house                                     | 124.00 steady                                              | 100%, worst 9 ms                    |
| 8-bar and 32-bar breakdowns with offbeat bass          | held                                                       | ≥98%; no drift at 128 BPM over 62 s |
| Tempo change 120 → 128                                 | re-locked in about 6 s (test: <10 s)                       | ≥95% after the change               |
| Tap tempo                                              | exact after 4 steady taps; ±0.5 with ±10 ms jitter over 12 | —                                   |

Live (Electron, test beat): 120.01 and 127.86 → refined to 128.0. In phase by about 8 s. Beat spacing is steady to ±0.5 ms.

### How to run

```bash
npm run dev
```

In **Audio input**, pick **Test beat**, your mixer input or **System audio**. The **Tempo** panel shows the BPM within a few seconds.

### Test results

- `npm run typecheck` and `npm run lint`: clean.
- `npm run test:unit`: **124 passing**. The 40 new tests:
  - tempo estimator accuracy (5 click tempos), range folding, noise confidence
  - end-to-end tracking: 8 styles and tempos, a 3-minute run, two breakdowns, tempo precision, the 128 BPM breakdown drift, a tempo change, monotonic beats, phase correction on/off
  - tap tempo, clock sync, the clock's tempo and phase convergence, snapping, downbeat, latency offset
  - tracker acquisition, weak-offbeat rejection and re-acquisition
  - every engine command and the guards
- `npm run test:e2e`: **46 passing**. The 11 new tests:
  - the test beat detected at 120 ±0.5 and in phase within 10 s
  - beat events 500 ±10 ms apart, cycling 1-2-3-4
  - 128 BPM detected
  - Space-key tap at 600 ms giving ~100 BPM, locked
  - typed BPM, ×2, ÷2
  - shortcuts ignored while typing
  - unlocking back to auto
  - Enter resync making now beat 1
  - latency offset, phrase length and phase correction
  - the clock freewheeling at the last tempo with audio off
  - 60 fps with tracking running

### Manual test script

1. Run `npm run dev`. In **Audio input** choose **Test beat**. **Expected:** within about 5 s the Tempo panel reads **120.0**, AUTO, with "detected 120.0" and a full confidence bar. Within about 10 s it says **in phase**, and the four beat lights step along with beat 1 in pink.
2. Make the output window visible. **Expected:** the metronome in its top-right corner steps in time with the panel's lights.
3. **Real music** (the acceptance test):
   1. Pick your mixer input (or **System audio**) and play a steady four-on-the-floor track.
   2. **Expected:** the BPM settles on the track's tempo, or exactly half or double it; ×2 / ÷2 fix that.
   3. Watch the beat lights and metronome against the kick you hear for **at least 2 minutes**. **Expected:** they stay locked, through breakdowns too.
   4. If the lights consistently flash slightly after the kick, raise **Latency offset** in Clock settings until they line up. Note the value: it's your setup's latency.
4. Press **Enter** (or **Resync 1**) exactly on a bar's first beat. **Expected:** the pink light now marks the real "one", and the bar counter steps on bar lines.
5. Tap **Space** 4–8 times along with the music. **Expected:** LOCKED, the BPM matches your taps, and the lights follow your taps. Click **Unlock (Auto)** to return to detection.
6. Type a BPM and press Enter. Try **×2**, **÷2**, and **◀ / ▶** (or the arrow keys). **Expected:** each acts immediately, and the lights never stutter or double-flash.
7. Turn audio **Off**. **Expected:** the lights keep going at the last tempo (freewheel).
8. Try the harness on real tracks:

   ```bash
   npm run analyze -- "C:\path\to\track.mp3"
   ```

   **Expected:** the "Tempo" line shows the track's BPM by 8 s, ending "in phase".

### Decisions and defaults (flag any you want changed)

- **The beat grid follows kicks.** That suits house, techno, drum & bass and most dance music. Snares and hats steer it only when there are no kicks.
- **Downbeat (beat 1) is not detected automatically.** The first locked beat becomes beat 1 until you press Resync. Automatic downbeat detection is a Phase 9 backlog item.
- **Tap tempo locks the tempo.** The tapped tempo holds until **Unlock (Auto)**. Phase correction still follows the kicks if enabled.
- **Freewheel:** with audio off, in a breakdown, or when the detector isn't confident, the clock keeps the last tempo and phase.
- **Shortcuts:** Space, Enter and ←/→ avoid the letter and number keys Phase 4 will use for pads. They're captured before buttons, so they don't activate a focused button.
- **Clock settings (latency offset, phrase length, range) are not saved yet** (Phase 8).

### Known issues / limitations

- **Tuned on synthesized music.** Real tracks with swing, live drums or heavy sidechain may lock more slowly or need ×2/÷2. Please report tracks that misbehave; `npm run analyze` output is the most useful thing to send.
- **Sudden tempo changes take about 6 s to adopt.** Gradual DJ pitch changes are followed continuously.
- **Half/double-time ambiguity is inherent.** Hip-hop at 90 BPM with busy hats may read 180; ×2/÷2 persist for the track.
- **The latency offset must be set by ear.** There's no automatic input-latency measurement.

### Open questions for you

1. Run the real-music test (step 3). Does it stay locked for 2+ minutes on your tracks, and what latency offset looks right on your setup?
2. Should Phase 4's quantized triggers use the latency-shifted visual timeline (recommended: clips land on the beat you hear), or the raw audio grid?
3. Any preference for default tap/resync keys before Phase 4 assigns the pad keys?

**Approval notes (2026-10-19):**

- Quantized triggers use the latency-shifted visual timeline.
- Space, Enter and ←/→ stay reserved for tempo.

---

## Phase 4: Beat-synced triggering (completed and approved 2026-10-20)

### What was built

**Pad grid** (top of the main area)

- 4 banks (A–D) of 4×8 pads, each showing its key, clip thumbnail, name and mode.
- **Assigning clips:** drag clips from the library onto pads, or use **Auto-fill**, which puts the library's readable clips on the bank in order.
- **States:**
  - queued: blinking amber
  - armed for the drop: blinking pink
  - playing: green, pulsing on every beat (pink on the downbeat)
  - stopping
- **Global quantize** (off, ¼ beat, beat, bar, phrase; default beat) and **drop timing** (next phrase, or in 1/2/4/8/16 bars).
- **Stop all**, and **Edit pads** mode (clicks select instead of fire).

**Keys**

- **Fire pads:** rows `1–8`, `Q–I`, `A–K`, `Z X C V B N M ,`. Key-up releases a _While held_ pad.
- **Shift+key** or Shift+click arms or disarms a pad for the drop.
- **F1–F4** switch banks; **Esc** stops everything.
- Space, Enter and arrows stay tempo controls. Keys are ignored while typing in a field.

**Pad editor** (sidebar, right-click a pad)

- **Plays:** a clip, a random clip from any library folder, or a random clip from all clips.
- **Mode:**
  - **One-shot:** plays once; pressing again restarts on the next boundary.
  - **For N beats:** ½ beat to 8 bars, then gone.
  - **While held.**
  - **Toggle loop:** the off press is quantized too.
  - **Retrigger:** restarts every beat or bar until toggled off.
- **Quantize override**, **fade in / out** in beats, and **tempo sync** (stretch one pass to ½ beat – 8 bars; works for video and GIF/WebP).
- **Fire**, **Arm for drop** and **Clear** buttons.

**Drop**

- Armed pads fire together on the next phrase, or after N bars from the next bar line.
- A big pulsing **"DROP in 3 bars"** banner switches to beats in the last bar, lists the armed pads, and has **Cancel**.
- Arming an armed pad disarms it.

**Random pads**

- Pick from the folder or library, skipping unreadable clips, and never play the same clip twice in a row.
- The clip is chosen and preloaded when you press, so it's ready on the beat.

**Scheduler (`src/core/trigger/`):** pure TypeScript, driven by the beat clock in beat positions on the latency-shifted visual timeline.

- **Timing:** each action fires on the frame nearest its boundary, at most half a frame early. The output advances the clock and applies triggers _before_ drawing, so a clip due on a frame is drawn on that frame.
- **Grace:** a press up to 80 ms after a boundary fires immediately rather than waiting a whole bar.
- **Downbeat:** bars and phrases follow the resynced downbeat.
- **One clip layer:** a new pad replaces the showing one, and a library click is still an instant, unquantized preview that takes over the layer.

### Test results

- `npm run typecheck` and `npm run lint`: clean.
- `npm run test:unit`: **151 passing**. The 27 new scheduler tests, run in simulated time against a real `BeatClock` at 60 fps:
  - **Starts:** every quantize unit fires within ±½ frame of its boundary; also grace, downbeat resync, and the latency offset (a 40 ms offset fires 40 ms earlier).
  - **For N beats:** 2 and 4 beats at 120 and 174 BPM last exactly N beats ±1 frame.
  - **Modes:** fades; hold, including release-before-start; toggle, including double-press cancel; retrigger on every beat; one-shot restart; replacement.
  - **Drop:** fires exactly on the phrase with the countdown at 7 → 1 bars; N-bar drops with all pads together; disarm; stop all.
  - **Random:** 2,000 picks with no repeat; random pads on a folder; empty sources.
- `npm run test:e2e`: **61 passing**. The 15 new pad tests, in the real app at a locked 120 BPM:
  - **Setup:** drag-to-pad and Auto-fill (broken files skipped).
  - **Timing:** a bar-quantized key press fires within one frame of a bar; beat quantize lands on beats and off is immediate; _For 2 beats_ lasts 2 beats ±1 frame.
  - **Modes:** hold on key down/up; toggle stops on a beat; retrigger every 500 ±25 ms.
  - **Drop:** Shift+key arm shows the countdown and fires on a bar; arming again cancels.
  - **Random:** a random pad plays 6 presses with no consecutive repeats and no broken clips.
  - **Other:** F1/F2 banks; tempo sync gives 0.5× for 2 s stretched to 8 beats; Esc stops all; 60 fps while firing.
  - The Phase 0–3 suites still pass. One old test needed `exact: true` because of the new **Stop all** button.
- **Live with the audio-tracked test beat:** bar-quantized presses landed −4.8, −0.1 and 0.0 ms from the bar. The 0.0 ms press came 47 ms late and fired immediately through the grace window.

### Manual test script

1. Run `npm run dev`, drag `fixtures/media` (or your own clips) into the library, and click **Auto-fill**. In **Audio input**, choose **Test beat** (or your mixer) and wait for **in phase**.
2. Set **Quantize** to **Bar**. Press `1`, `2`, `3` at random moments. **Expected:**
   - The pad blinks amber.
   - The clip appears exactly on the next "1" (watch the pink beat light).
   - A press just after the "1" fires immediately instead of waiting a bar.
3. Right-click pad **3**, set **Mode: For N beats**, **Length: 2 beats**, **Quantize: Beat**. Press `3`. **Expected:** the clip flashes up on a beat for exactly two beats.
4. Set a pad to **While held**: it shows only while you hold the key. **Toggle loop**: on with one press, off with the next, both on the beat. **Retrigger (every beat)**: the clip restarts on each beat (stutter).
5. Hold **Shift** and press `1`. **Expected:** the pink **DROP in N bars** banner counts down, and pad 1 fires on the phrase's first beat. Shift+`1` again before then cancels. Try **Drop: In 2 bars**.
6. Right-click an empty pad. **Plays: Random from all clips**, **Quantize: Off**. Press it repeatedly. **Expected:** a different clip each time, never the same twice in a row.
7. Give a looping pad **Tempo sync: Stretch to 1 bar**. **Expected:** one pass of the clip lasts exactly a bar, and it follows tempo changes.
8. **F2** switches to bank B; **F1** back. **Esc** stops everything.
9. **With real music:** play a track, fire pads on the drop, and judge whether it _feels on the beat_. If clips land late, raise **Latency offset** in Clock settings.

### Decisions and defaults (flag any you want changed)

- **One clip layer for now.** A new pad replaces the showing pad, and several armed pads fire together but only the last shows. Phase 5's layers make multi-clip drops and overlays meaningful; pads will target layers then.
- **Clicks fire; right-click edits.** Mouse down/up on a pad acts like key down/up. Right-click, or **Edit pads** mode, selects a pad for editing, so a performance click never opens the editor by accident.
- **One-shot** ends at the clip's natural end. Pressing again restarts on the next boundary. A **For N beats** clip loops if shorter than N beats.
- **Grace window:** 80 ms. **Default global quantize:** Beat.
- **Drop "In N bars":** counted from the next bar line, so arming mid-bar gives N−1 full bars plus the rest of the current bar.
- **Fades** are measured in beats and apply at the start and end only. A retrigger doesn't re-fade.
- **Pad layouts are not saved yet** (Phase 8, with the library).
- **Library clicks stay instant previews** (unquantized). Pads are the performance path.

### Known issues / limitations

- **Single layer:** "drop macros" with several simultaneous clips need Phase 5.
- **Retriggered videos seek to 0 on every beat.** Short local clips handle this fine; long or heavily compressed videos may show the previous frame for one frame after each restart. GIF/WebP retriggers are exact.
- **Tempo sync relies on the clip's reported duration.** Videos with odd timestamps may stretch slightly wrong.
- **Hold-mode release isn't quantized** (by design: it lets go when you do).

### Open questions for you

1. Run the real-music check (step 9). Do quantized pads feel on the beat on your setup, and with what latency offset?
2. For Phase 5 layers: should each pad pick its layer, with defaults by mode (loops to the background, one-shots and N-beat pads to overlays, armed drops to the takeover layer)?
3. Is right-click to edit and Shift to arm comfortable, or would you prefer different gestures for your controller workflow?

**Approval notes (2026-10-20):** Phase 5 was started without answers, so the recommended defaults stand:

- Pads pick their layer, with defaults by mode.
- Right-click still edits a pad, and Shift still arms it.

---

## Phase 5: Layers, compositing and placement (completed and approved 2026-10-20)

### What was built

**Four layers** (bottom to top): **Background**, **Overlay A**, **Overlay B**, **Takeover**

- Each layer plays one clip at a time, with its own opacity, **blend mode** (normal, add, screen, multiply, difference), **mute** and **solo**.
- The scheduler now keeps one voice per layer. A pad replaces only what's on its own layer, so a background loop keeps running while meme clips pop over it.
- A drop with several armed pads fires them all together, each on its own layer.

**Pads target layers.** A pad's layer is **Auto** by default:

- toggle loops go to **Background**
- one-shot, hold and retrigger pads go to **Overlay A**
- N-beat pads go to **Overlay B**
- anything fired by a **drop** goes to **Takeover**

You can override this per pad. Pad tiles show the target (`loop·BG`, `1×·A`, …). Library clicks still preview instantly on the Background layer.

**Placement per pad**

- **Position:** full screen (with fit), centered, any corner, or a random spot, with size, X/Y offset and rotation.
- **Entrances:** **pop** (scale-in with a bounce) or **slide in** from any edge, timed in beats.

**Keying per pad**

- **Chroma key:** green screen, blue screen or any custom color, with similarity, smoothness and spill suppression.
- **Luma key:** removes dark (or bright) areas.

**Takeover behavior:** while something shows on the Takeover layer, the layers below can **keep playing**, **dim** (adjustable, default 70%), **pause** (videos and GIFs freeze) or **hide**. They restore the moment the takeover ends.

**Master:** brightness and **Blackout** (button or the backquote key).

**Preview monitor:** a live 320-pixel-wide mirror of the final output at the top of the sidebar, about 15 fps, with on/off.

**Compositor (output)** — rewritten:

- **Layers:** composited bottom to top into an offscreen buffer. Before each layer the buffer is copied, so the layer's shader can read what's underneath. That makes every blend mode exact, difference included.
- **Layer shader:** un-premultiplies, keys, applies opacity, then blends.
- **Master pass:** draws the result to the screen with brightness.
- **Preview readback:** asynchronous (pixel buffer plus GPU fence), so the render loop never waits on the GPU.

**Fixtures**

- `fixtures/keying` (committed): a green-screen PNG and MP4, a luma-key PNG, and solid red and gray.
- `npm run fixtures:perf` makes 1080p and 720p clips plus a GIF for the performance test (gitignored).

**Fix along the way:** still images in one-shot mode vanished after 0.1 s; they were treated as one 100 ms GIF frame. Stills now have a natural length of 2 s, which also helps tempo sync.

### Performance (acceptance)

Measured by `tests/e2e/perf.spec.ts` on this machine, over 5 runs:

- **Setup:** output window at **1920×1080**, live preview on.
- **Layers:**
  - Background: a 1080p H.264 loop
  - Overlay A: a rotated, transparent 480p GIF
  - Overlay B: a **chroma-keyed 1080p H.264** clip
  - Takeover: a 720p H.264 clip, with takeover mode "keep playing" so all four draw

| Result                | Value                                |
| --------------------- | ------------------------------------ |
| Average fps           | **60.0** (each 1 s sample 59.9–60.0) |
| Dropped-frame samples | **0**                                |
| Longest frame         | 16.9 ms                              |
| Frame JS time         | ~4.8 ms average                      |

The first version read the preview back synchronously. That made the CPU wait for the GPU about 15 times a second and dropped one run to 55.6 fps. Switching to an asynchronous readback fixed it.

### Test results

- `npm run typecheck` and `npm run lint`: clean.
- `npm run test:unit`: **161 passing**. New:
  - placement math: fit, anchors and margins, random spots staying on screen, offsets and rotation, pop overshoot, slides starting fully off each edge
  - per-layer scheduler cases: layers coexisting, stop layer, a pad moving layers, a multi-pad drop filling several layers
- `npm run test:e2e`: **71 passing**. The 9 new layer tests:
  - four layers stacking with placement, luma key and chroma key, checked pixel by pixel
  - **all five blend modes at 50% opacity giving the exact predicted colors**: red over 50% gray gives normal (191,64,64), add (255,128,128), screen (191,128,128), multiply (128,64,64), difference (128,128,128)
  - mute and solo
  - a chroma-keyed video
  - the pop entrance growing to its final size
  - takeover dim (lower opacity 0.3), pause and hide, each restoring afterwards
  - master brightness and the blackout key
  - **the preview monitor matching the output pixels**
  - the pad editor setting layer, position, size and keying through the UI
  - Plus the 1080p performance test.
- The Phase 0–4 suites still pass on the new compositor, including Phase 1's pixel-level transparency and fit tests. One Phase 4 test now accepts a press that lands in the 80 ms grace window.

### Manual test script

1. Run `npm run dev`. Drag `fixtures/media` and `fixtures/keying` (or your own clips) into the library, then click **Auto-fill**.
2. Right-click a pad: set **Mode: Toggle loop** (Auto → Background) and fire it. Then fire a few one-shot pads. **Expected:** the one-shots pop over the running loop instead of replacing it. The **Layers** panel shows what's on each layer, and the **Output preview** mirrors the output.
3. On a one-shot pad, set **Position: Top right**, **Size** 30%, **Rotation** 10°, **Entrance: Pop**. Fire it. **Expected:** it bounces in, tilted, in the top-right corner.
4. Put `greenscreen.mp4` on a pad with **Keying → Green screen**. **Expected:** the green disappears and the loop shows through. Try **Similarity** and **Spill**.
5. In **Layers**, change Overlay A's **blend** (Screen and Add look great on dark clips) and opacity. **M** mutes and **S** solos a layer. ■ stops a layer.
6. Arm a pad with **Shift** and let the drop fire. **Expected:** it lands on **Takeover**, and the layers below dim. Try **Under takeover: Pause** and **Hide**.
7. Press the backquote key: **Blackout**. Press again to restore. Try **Master brightness**.
8. Optional:
   1. Run `npm run fixtures:perf` and fire the four 1080p clips onto the four layers.
   2. Make the output full screen on a 1080p display.
   3. **Expected:** the overlay holds 60 fps.

### Decisions and defaults (flag any you want changed)

- **Layer order is fixed:** Background < Overlay A < Overlay B < Takeover.
- **The library preview plays on Background.** The "Library preview" panel's loop/speed/fit apply to it.
- **Takeover default:** **Dim 70%**.
- **Corner positions keep a 4% (of screen height) margin.** A random position keeps the whole clip on screen.
- **Chroma key** works on color difference (YCbCr). Default similarity is 30%, smoothness 10%, spill 50%.
- **Preview:** 320 pixels wide at about 15 fps; you can turn it off.
- **Still images play for 2 s** in one-shot mode.
- **Layer mix, master and pads are not saved yet** (Phase 8).

### Known issues / limitations

- **The same video can't play on two layers at once.** One video element would be shared, so the second start restarts it. GIFs, WebPs and stills can.
- **Performance was measured on this machine only** (with software video decoding). Weaker laptops may need fewer 1080p videos at once. Phase 8 adds graceful degradation.
- **Slide entrances** use the unrotated size to decide "off-screen". A heavily rotated clip may peek in from the edge at the very start.
- **No effects yet.** Strobes, RGB split, kaleidoscope and audio-reactive parameters are Phase 6.

### Open questions for you

1. Are the four fixed layers and their auto-routing right for how you'd perform, or do you want more overlay layers or a different order?
2. Should the Takeover layer's default be **Dim**, **Pause** or **Hide**?
3. Placement presets: are there other positions you'd use often (lower third, left/right half, ticker strip)?

**Approval notes (2026-10-20):** Phase 5 was approved without answers to the open questions, so the recommended defaults stand:

- The four fixed layers and the automatic routing stay.
- **Dim** stays the takeover default.
- The **lower third**, **left half** and **right half** positions were added during Phase 6.

---

## Phase 6: Audio-reactive modulation and effects (completed 2026-10-20, awaiting approval)

### What was built

**Effects & modulation panel** (sidebar, under Layers), with one chain per layer plus one for the **Master**. The scope tabs are BG / A / B / TO / Master and show how many items each has.

**Effects**

- Ten effects, each with live sliders:

  | Effect                | Parameters                                                                               |
  | --------------------- | ---------------------------------------------------------------------------------------- |
  | **Strobe / flash**    | amount, flashes per beat (0 = a steady flash for envelopes), on-fraction, to white/black |
  | **RGB split**         | offset, angle                                                                            |
  | **Kaleidoscope**      | mix, segments, rotation                                                                  |
  | **Mirror**            | mix, left→right / top→bottom / both                                                      |
  | **Pixelate**          | block size                                                                               |
  | **Zoom bump**         | zoom                                                                                     |
  | **Shake**             | distance, jumps per beat                                                                 |
  | **Invert**            | mix                                                                                      |
  | **Hue rotate**        | degrees                                                                                  |
  | **Feedback / trails** | trail length, tunnel zoom                                                                |

- Effects can be enabled, disabled, reordered (↑/↓) and removed.
- **On a layer**, effects apply to that layer's clip only, and transparency is kept: a kaleidoscoped meme stays cut out over the background.
- **On the master**, they apply to the whole picture.

**Modulators** drive any number from a source:

- **Targets:** layer opacity, scale, rotation, X/Y move, or any effect parameter. On the master, opacity is brightness, and scale/rotation/move transform the whole frame.
- **Sources:**
  - **Beat-synced LFO:** sine, triangle, saw, square or random step. The period runs from **1/16 note to 8 bars**, with a phase offset. LFOs are aligned to the bar grid, so a 1-bar LFO restarts on every downbeat.
  - **Beat envelope:** attack and decay in beats, retriggered **every beat**, on **beats 2 & 4**, **every bar**, **every phrase**, on each **detected kick**, or on each detected **snare/hat**.
  - **Audio band:** bass, low-mid, mid or high level, with gain.
- **Controls:** each modulator has an **amount**, a **min..max range** (what it adds to the parameter) and **invert**. Several modulators on one target add up. Results are clamped to the parameter's range.
- When you choose a new target, the range resets to one that suits it. For example, opacity gets −1..0, which pulses a full-opacity layer down to nothing.

**Presets** (one-click toggles per layer or master; click again to remove):

- **Kick Bump:** scale +10% on every detected kick, settling over half a beat.
- **Snare Strobe:** an 80% white flash on beats 2 and 4, a quarter-beat decay.
- **Bar Shake:** a shake on each bar that settles over two beats.
- **Drop Flash:** a full white flash plus a 25% zoom on every phrase start.

**New placement positions** (pad editor): **lower third** (bottom center), and **left half** / **right half** (fit into that half).

**How it works** (details in `docs/ARCHITECTURE.md`)

- **Modulation** is pure TypeScript (`src/core/modulation`), evaluated once per frame for all five chains.
- **Musical time** comes from the beat clock's **position in beats**, never from wall time. The position is continuous and only moves forward, so LFOs can't jump when the tempo changes: they just run faster or slower along the same waveform.
- **Effects** are one shader with a type switch, run as full-screen passes in premultiplied color.
- **Idle effects cost nothing:** an effect at zero strength is skipped, and a layer without active effects uses the Phase 5 direct path. A Snare Strobe between flashes costs no GPU work.
- **Feedback** blends the current frame over its decayed past ("lighten"). A small bias stops 8-bit rounding from leaving a permanent ghost.

### Performance (acceptance)

Measured by `tests/e2e/perf.spec.ts` at **1920×1080** with live preview. The four 1080p layers are the same as Phase 5's.

**Effects in the test:** 11 full-screen passes every frame.

| Chain      | Effects                     | Modulators                    |
| ---------- | --------------------------- | ----------------------------- |
| Background | kaleidoscope, hue rotate    | LFO on the kaleidoscope angle |
| Overlay A  | RGB split, feedback trails  | Kick Bump, LFO rotation       |
| Overlay B  | pixelate, quad mirror       | LFO on block size             |
| Takeover   | shake, 50% invert           | —                             |
| Master     | zoom bump, strobe, feedback | LFO on zoom                   |

| Result                | Without effects | With effects |
| --------------------- | --------------- | ------------ |
| Average fps           | 59.9            | **60.0**     |
| Minimum 1 s sample    | 59.9            | **59.9**     |
| Dropped-frame samples | 0               | **0**        |
| Longest frame         | 16.9 ms         | 16.8 ms      |
| Frame JS time         | 5.05 ms avg     | 5.02 ms avg  |

Modulation adds no measurable JavaScript time, and the effect passes fit in the GPU's frame budget on this machine.

### Test results

- `npm run typecheck`, `npm run lint` and Prettier: clean.
- `npm run test:unit`: **181 passing** (20 new):
  - **LFO waveforms:** the expected shapes, staying in 0..1, and exactly one cycle per period for every musical period from 1/16 to 8 bars. Also bar-grid alignment, the phase offset, and the random step holding one value per period.
  - **Phase continuity across tempo changes (acceptance):** a 1/16-note sine sampled every frame while the clock jumps 120 → 174 → 90 → 128 BPM. The position never goes backwards, and no frame-to-frame change exceeds what the waveform's slope allows, so there are no jumps.
  - **A 1-bar sine at 90, 128 and 174 BPM:** sampled every 1 ms from one downbeat to the next, it starts at 0, peaks exactly once and ends at 0.
  - **Envelopes:**
    - The attack/decay shape.
    - Beat, backbeat, bar (including a moved downbeat) and phrase triggers.
    - Kick envelopes: silent until the first kick, then decaying from it.
  - **Modulators:**
    - Range mapping, amount and invert.
    - Audio bands with gain and clamping.
    - Summing on one target.
    - Clamping effect parameters to their ranges.
    - Disabled items and missing targets are ignored.
  - **Presets:**
    - Kick Bump is +10% on a kick and back to 0 after half a beat.
    - Snare Strobe fires only on beats 2 and 4.
    - Drop Flash flashes and zooms on the phrase start.
    - Every preset passes validation.
  - **Guards:** every effect with its defaults passes; out-of-range values and bad ids are rejected.
  - **Placement:** lower third and left/right half.
- `npm run test:e2e`: **77 passing** (6 new):
  - **Effects on the picture**, checked pixel by pixel:
    - A layer flash whitens only that layer.
    - Master mirror copies the red square to the right.
    - Master invert turns red cyan.
    - Disabled and zero-strength effects cost **0 passes**.
  - **Feedback trails** stay visible after the layer stops, then fade **completely to 0**.
  - **A 1-bar sine on opacity, live at 120 BPM:** over 2+ bars, every sample matches the bar-aligned sine within 0.01. There is one peak per bar; the lows land on beat 1 and the highs on beats 2–3.
  - **Kick Bump turned on from the panel**, with the built-in test beat:
    - The clip peaks at +10% (never more) and returns to 1.00.
    - The bumps match the detected kicks one-for-one (±1).
    - Toggling the preset off removes it.
  - **The panel adds an effect, retargets a modulator onto it, disables the effect and removes it.** Removing it also removes its modulator.
  - The **1080p effects performance test** (above).
- **Test fix:** a Phase 4 test ("beat and off quantize") failed twice in full-suite runs. A key press landing within 80 ms after a beat fires immediately, by design (the grace window). The test now accepts that, like the bar-quantize test already did.

### Manual test script

1. Run `npm run dev`. Load clips and fire a toggle loop (Background) and a one-shot or loop on Overlay A.
2. Pick an audio source: **Test beat** for a quick look, or **System audio** / your mixer with music playing.
3. In **Effects & modulation**, choose **A** and click **Kick Bump**. **Expected:** the Overlay A clip bumps on every kick. Click it again to remove it.
4. Choose **Master** and click **Drop Flash**. **Expected:** a white flash and zoom on each phrase start (every 8 bars by default; the bar counter in the Beat panel shows where you are).
5. Choose **BG**, add **Kaleidoscope**, then **Add modulator**. Set the target to **Kaleidoscope: Rotation**, source **LFO**, **Saw**, **2 bars**, range 0 to 360. **Expected:** the kaleidoscope turns one full revolution every 2 bars, staying locked through tempo changes. Try tapping a new tempo.
6. On **A**, add a modulator with target **Opacity** and an LFO **Sine** at **1 bar**. **Expected:** the clip fades out to nothing on each downbeat and is fully visible on beat 3.
7. Try **Feedback / trails** on a moving GIF, **RGB split** with an **Audio band → Bass** modulator on its offset, and **Snare Strobe** on the master.
8. Optional: with `npm run fixtures:perf` clips on all four layers and several effects each, the debug overlay should stay at 60 fps. The overlay also shows the number of effect passes.

### Decisions and defaults (flag any you want changed)

- **One chain per layer plus master**, not per pad. A pad's clip gets the effects of the layer it lands on, which fits the auto-routing: put Kick Bump on Overlay A and every meme pad bumps.
- **Modulators add to a base value** (offset ranges), rather than replacing it. "Scale +10% on kick" is a range of 0..0.1. Several modulators on one target sum.
- **"Snare" triggers:** the Snare Strobe preset uses **beats 2 & 4** from the beat clock, not the detected snare/hat onsets. That keeps it on the grid even when hi-hats are busy. The detected trigger is available as a source too.
- **LFO and envelope shapes:**
  - Sine and triangle LFOs start at 0 on the downbeat and peak mid-cycle.
  - Envelopes rise linearly over the attack, then fall quadratically over the decay (a punchy shape).
- **Shake** zooms in slightly, in proportion to its distance, so the moved edges never show black.
- **Effects and modulators aren't saved yet** (Phase 8), the same as layers and pads.

### Known issues / limitations

- **Effects apply to the whole layer area**, not just the clip's bounding box. Mirror and kaleidoscope on a small corner clip reflect it around the screen center. This is often fun, but it isn't a "local" effect.
- **Cover fit in a half position isn't cropped.** A clip covering the left half spills into the right half; contain (the default) is unaffected.
- **Kick and snare/hat envelope triggers** start when the onset message reaches the output, which is slightly after the hit. With the latency offset set from Phase 3, they line up with beat-grid triggers, but they don't anticipate the hit.
- **GPU cost** was only measured on this machine. Each active layer effect costs a full-screen pass at output resolution, so weaker GPUs may need fewer stacked effects. Phase 8's graceful degradation will cover this.

### Open questions for you

1. Are layer-level and master-level chains enough, or do you also want effects attached to individual pads (for example, a specific meme always enters with RGB split)?
2. Should the presets be editable and saveable as your own presets? That would land with set saving in Phase 8.
3. Do you want more "fun" presets, for example a **Hue Cycle** (hue rotate on a 4-bar saw), a **Wobble** (rotation on a 1-beat sine) or **Tunnel** (feedback with zoom)?

---

## UX-1: Live-safety quick wins (completed 2026-10-20, awaiting approval)

This is the first step of the UX plan in `docs/UX_REVIEW.md`, done before Phase 7 at your request, using the recommended answers to the review's questions.

### What changed

- **The output starts clean.** The debug overlay and its metronome are hidden by default (they were drawn over the show at launch). The toggle moved to a new **Diagnostics** panel at the bottom of the sidebar ("Debug overlay on the output"), with a note that the audience sees it.
- **A library click only selects.**
  - A selected clip gets a blue outline and a **▶ Play** button, which shows it on the Background layer now. Double-clicking a clip is the same as ▶ Play.
  - Browsing, hovering and selecting never touch the show.
  - A hint line above the clips explains this.
- **Clear library is guarded.** **Clear library…** opens a confirm bar: "Remove all N clips? Files on disk are not touched." **Remove all** is red, next to **Cancel**.
  - After clearing, an **Undo** bar stays for 10 seconds. Undo re-imports the same files.
  - Clip ids are derived from file paths, so pad assignments come back intact.
- **The top bar shows only what matters live:** the output connection and fps. The IPC ping and media memory numbers moved into **Diagnostics**.
- **Tempo panel:**
  - **No audio input.** When no input is running, "listening…" is replaced by an amber **"No audio input: choose one"** link. It scrolls to the audio input picker and focuses it. "Starting audio…" and "Audio error: check input" cover the other states.
  - **Plainer buttons.** **Resync 1** → **Beat 1** ("Mark now as beat 1 of the bar"). The unlabeled **◀ ▶** → **−10 ms / +10 ms** ("Move the beat grid earlier/later"). The shortcut hint now reads "Enter marks beat 1".

### Test results

- `npm run typecheck`, `npm run lint` and Prettier: clean.
- `npm run test:unit`: **181 passing** (unchanged).
- `npm run test:e2e`: **80 passing**. New:
  - The debug overlay and metronome start hidden and can be toggled.
  - The tempo panel shows "No audio input" and its link focuses the input picker.
  - A single click selects without changing the output. ▶ Play shows the clip, selecting another clip leaves the show alone, and double-click plays.
  - **Clear library…** can be cancelled, removes everything when confirmed, and **Undo** brings every clip back with the same ids.
- **Updated:** the library and stress tests play clips via select + ▶ Play instead of a single click.

### Manual test script

1. Run `npm run dev`. **Expected:** the output window shows only the background color, with no stats text and no metronome. The tempo panel says **No audio input: choose one**. Click it, and the sidebar jumps to the input picker.
2. Add `fixtures/media`. Click a clip. **Expected:** it gets a blue outline and a **▶ Play** button, and the output doesn't change.
3. Press **▶ Play**, or double-click another clip. **Expected:** it shows on the output.
4. Click **Clear library…** → **Cancel**: nothing happens. Then **Clear library…** → **Remove all** → **Undo**. **Expected:** every clip comes back, and pads assigned before still play.
5. **Diagnostics** (bottom of the sidebar) → tick **Debug overlay on the output**. **Expected:** the overlay and metronome appear on the output. Untick to hide them.

### Decisions and defaults

- **Double-click is the mouse shortcut for ▶ Play.** Keyboard Enter and Space on a library tile do nothing: they stay with the global tempo shortcuts (beat 1, tap). This was already the case; the tile's own Enter handler never fired.
- **Clicking a selected clip keeps it selected.** The ▶ Play button sits in the middle of the tile, so a "click again to deselect" would be easy to hit by mistake.
- **Screen size:** the review's layout work (UX-2) will target laptop widths (≈1366–1920 px) first. Say if you mainly perform on a large external monitor.

### Known issues / limitations

- **Double-click start latency.** In the automated test, double-clicking a clip at the same instant the mouse first lands on it starts the video one frame later than ▶ Play. That's 2 frames instead of 1: the hover preview starts decoding the same file at that moment. When the pointer has rested on the tile for even 0.3 s, double-click starts within a frame too.
- **The sidebar layout is unchanged.** Panels are still stacked; that is UX-2.
