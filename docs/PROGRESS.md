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

## UX-1: Live-safety quick wins (completed and approved 2026-10-20)

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

**Approval notes (2026-10-20):** UX-1 approved as built.

---

## UX-2: Layout restructure (completed and approved 2026-10-20)

Step 2 of `docs/UX_REVIEW.md`: one screen for the show, and a drawer for setup.

### What changed

**Before:** pads and library on the left, and an 11-panel sidebar that scrolled to about 3,000 px.

**Now:**

| Area             | What's there                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Top bar**      | **Output** pill (display, "· fullscreen"), **Audio** pill (input name, or amber "Audio: off"), a **Fullscreen** / **Exit fullscreen** / **Show output** button, output fps, **⚙ Setup**. Clicking a pill opens Setup at that tab. |
| **Left column**  | The pads; the **mixer**, one strip per layer plus Master; the library.                                                                                                                                                            |
| **Right column** | The output preview, the tempo panel, and the **context panel**.                                                                                                                                                                   |
| **⚙ Setup**      | A drawer that slides over the right side, with tabs **Audio**, **Output** (displays, fullscreen, background color), **Clock** and **Diagnostics** (overlay toggle, ping, media, frame timing).                                    |

**Mixer strips**

- Each strip has:
  - a color stripe (one fixed color per layer)
  - M / S / ■
  - what's playing, and from which pad
  - an opacity fader
  - a blend mode
  - an **FX** button, with a green dot when the layer has effects on
- The Takeover strip adds "Others: keep playing / dim / pause / hide", plus a dim amount.
- The Master strip has brightness, **Blackout** and FX.

**Context panel** shows the last thing you selected, with ✕ to close:

- **A pad:** right-click it, hover and press the new **✎**, or drop a clip on it.
- **A layer's effects:** press **FX** on its strip. Pressing it again closes the panel.
- **A library clip:** a thumbnail, **▶ Play on Background**, Now playing / Stop / start latency, and the library-play settings (loop, speed, fit). These used to be the "Library preview" panel.

**Removed**

- The **Edit pads** mode: right-click and ✎ cover editing without a mode, so a click always fires.
- The separate Layers, Effects, Library preview, Background, Output window and frame-timing panels. Their contents moved into the mixer, the context panel or Setup.
- The effects panel's BG / A / B / TO / Master tabs: the mixer's FX buttons replace them.

**Other changes**

- **One keyboard reference:** a single line under the pads now lists every shortcut: pads, arm, banks, stop, tap, beat 1, nudge, blackout, edit. The tempo panel's separate hint is gone.
- **Sizing for laptops:** pad tiles are sized by window height, library rows never squash, and the preview is capped in height. At **1366×768** the pads, mixer, preview, tempo panel and context panel are all fully on screen, and the library keeps one row of clips visible.

### Test results

- `npm run typecheck`, `npm run lint` and Prettier: clean.
- `npm run test:unit`: **181 passing** (no logic changes).
- `npm run test:e2e`: **87 passing**.
- **New** `tests/e2e/layout.spec.ts` (6 tests):
  - The empty context panel shows a hint.
  - Right-click and ✎ open the pad editor (✎ doesn't fire the pad), and ✕ closes it.
  - FX opens the layer's effects, and the green dot appears when Kick Bump is turned on. Another strip's FX switches the panel; pressing it again closes it.
  - A library clip shows in the context panel, and a pad selection takes the panel over.
  - Every Setup tab holds its controls, and the Audio pill opens Setup at Audio.
  - **At 1366×768**, the pads, mixer, preview, tempo panel and context panel are all fully in view, and the library is at least 150 px tall.
- **Smoke:** a new test checks that the status bar names the output display and toggles fullscreen.
- **Updated:** tests for audio, beat, background, displays and the overlay now open Setup first. The effects tests use the mixer's FX buttons, and "connected" is checked by a status attribute instead of text.
- **Performance:** the 1080p tests still hold **60.0 fps with 0 dropped frames**.
  - Output JavaScript per frame is now about **1.3 ms**, down from about 5 ms.
  - The debug overlay used to be on by default and rebuilt its text every frame; it's off since UX-1.

### Manual test script

1. Run `npm run dev`.
   - **Expected:** the top bar shows "Output: <your display>" and an amber "Audio: off".
   - Click **Audio: off**: Setup opens at Audio. Pick an input and close Setup with ✕.
2. Click **Fullscreen** in the top bar, then **Exit fullscreen**. Click the **Output** pill to choose another display.
3. Load clips and **Auto-fill**. Fire pads with keys. **Expected:** the mixer strips show what's on each layer and from which pad.
4. Right-click a pad, or hover it and press ✎. **Expected:** its settings appear on the right, without scrolling. Change the mode, then close with ✕.
5. Press **FX** on Overlay A and turn on **Kick Bump**. **Expected:** the FX button gets a green dot. Press **FX** on Master to switch, and press it again to close.
6. Click a library clip. **Expected:** it appears on the right with **▶ Play on Background** and the loop / speed / fit settings.
7. Try the window at laptop size (about 1366×768). **Expected:** everything for the show is visible at once.

### Decisions and defaults

- **The mixer lives under the pads, not in the right column** (a change from the review's sketch). At laptop heights the right column can't hold the preview, tempo panel, mixer and a usable context panel together.
- **The status pills open Setup tabs** instead of pop-up menus, so each setting has exactly one home.
- **Setup is a drawer over the right column.** The pads and the left half of the mixer stay usable while it's open.
- **Layer colors:**
  - Background: blue
  - Overlay A: orange
  - Overlay B: cyan
  - Takeover: purple

  UX-3 will reuse them on pad tiles.

### Known issues / limitations

- **The library is small at 1366×768:** one row of clips, and it scrolls. Larger windows give it more room. UX-5 adds search and filters to make finding clips faster than scrolling.
- **The pad editor and effects lists are long** and scroll inside the context panel at laptop heights. UX-3 (Basic / Advanced pad settings) and UX-4 (modulation on the sliders) shorten them.
- **Pad tiles still use the `1×·A` badges** (UX-3).

**Approval notes (2026-10-20):** UX-2 approved as built.

---

## UX-3: Pads and context editing (completed and approved 2026-10-20)

Step 3 of `docs/UX_REVIEW.md`.

### What changed

**Pad tiles read at a glance**

- **Mode icons** replace the `1×·A` / `loop·BG` badges:

  | Icon | Mode        |
  | ---- | ----------- |
  | ▶    | one-shot    |
  | ⏱N   | for N beats |
  | ✋   | while held  |
  | ⟳    | toggle loop |
  | ↻    | retrigger   |
  | ⚄    | random clip |

- **Layer stripe:** a colored left edge shows the layer the pad plays on. It's the same color as that layer's mixer strip:
  - Background: blue
  - Overlay A: orange
  - Overlay B: cyan
  - Takeover: purple
- **Plain-words tooltip:** for example, "A6 · key 6 / photo.jpg / Retrigger on Takeover / Click or key to fire · Shift to arm for the drop · right-click to edit". Empty pads say how to fill them.

**Pad editor: basics first**

- **Header:** **Fire / Arm for drop / Clear** sit right under the pad's name, so they're always on screen.
- **Basic:** clip (or a random clip from a folder), mode (plus length or restart rate), layer, and position (plus fit or size).
- **More settings** (collapsed): quantize override, fades, tempo sync, offsets, rotation, entrance, keying.
  - Its title lists what you've changed, in amber, for example "More settings · quantize Bar · fades · chroma key". Nothing hides silently.
  - Open or closed, it stays the way you left it, across pads and restarts.

**Keyboard sheet**

- **Opening:** **?** opens a sheet listing every shortcut and mouse gesture, grouped into Pads, Tempo, Show and Mouse. A **?** button in the top bar and an **All shortcuts (?)** link under the pads open it too.
- **Closing:** ?, Esc, ✕, or a click outside the sheet.
  - While it's open, **Esc closes the sheet and does not stop the show**. Esc is still Stop all whenever the sheet is closed.
  - The pad and tempo keys keep working with the sheet open.
- **The line under the pads** is now short: fire, arm, stop all, edit, and the link to the sheet.

**Drop timing lives in the drop banner**

- The **Drop** menu left the pad toolbar, which now shows banks, quantize, Auto-fill and Stop all.
- While something is armed, the **DROP in N bars** banner has a **Lands** menu: on the next phrase, or in 1–8 bars.
- Changing it **retargets the armed drop from now**. Before, the target was fixed when you armed it, so the menu only affected the next drop. The choice is kept for later drops.

### Test results

- `npm run typecheck`, `npm run lint` and Prettier: clean.
- `npm run test:unit`: **182 passing**. New: changing the drop timing while armed retargets the drop from now (it fires at the new bar, within half a frame). Changing only the quantize leaves a pending drop where it is.
- `npm run test:e2e`: **91 passing**. New in `layout.spec.ts`:
  - **Pad tiles:** the mode icon, the plain-words tooltip, the stripe color matching Overlay A's orange, and the empty-pad tooltip.
  - **Pad editor:** the basics are visible, and quantize is hidden until **More settings** is opened. A changed quantize shows in the summary, and the open state carries over to the next pad.
  - **Shortcut sheet:**
    - **?** opens it.
    - **Esc** closes it while a loop keeps playing.
    - Esc with the sheet closed stops everything.
    - The top-bar button and the "All shortcuts" link open it.
  - **Drop timing:** absent while idle; shown in the banner once armed; changing it updates the countdown; Cancel clears it.
- **Updated:** the pad tests open **More settings** before using quantize or tempo sync, and the drop test picks its timing in the banner after arming.
- **Performance:** 1080p with effects is unchanged, at **60.0 fps** with 0 dropped frames.

### Manual test script

1. Run `npm run dev`, load clips, then **Auto-fill**.
   - Set a few pads to different modes and layers.
   - **Expected:** each tile shows its mode icon and a colored left edge matching the mixer strip of its layer. Hovering explains it in words.
2. Right-click a pad.
   - **Expected:** Fire / Arm / Clear and the basics are visible without scrolling.
   - Open **More settings**, set a quantize, and see it listed in the summary.
   - Right-click another pad: **More settings** is still open.
3. Fire a loop, press **?**, then **Esc**. **Expected:** the sheet closes and the loop keeps playing. Press **Esc** again: everything stops.
4. **Shift+click** a pad. **Expected:** the drop banner appears with **Lands: on the next phrase**. Switch it to **in 1 bar**: the countdown jumps, and the pad fires on the next bar.

### Decisions and defaults

- **"More settings" starts closed** on a fresh install, then remembers your choice.
- **Mode icons are text glyphs**, not images, so they stay crisp at any size. The ✋ may look slightly different from the others because Windows draws it from its emoji font.
- **Changing the drop timing applies to the pending drop** and to later ones. It counts from the moment you change it, not from when you armed the pad.

### Known issues / limitations

- **Tests share your app profile.** The end-to-end tests launch the app with the normal user-data folder. Settings stored in the window (for now, only the "More settings" open state) are shared between test runs and your own use. This predates UX-3, but it's the first time something is stored there. Giving tests their own profile is a small follow-up.
- **Mouse users can't set the drop timing before arming.** It appears once something is armed: arm, then pick. Keyboard arming works the same way.

**Approval notes (2026-10-20):** UX-3 approved as built.

---

## UX-4: Effects in the mixer (completed and approved 2026-10-20)

Step 4 of `docs/UX_REVIEW.md`. The mixer's FX buttons and active dots already came with UX-2. This step reworks the effects panel those buttons open.

### What changed

**Modulation lives on the parameter it moves**

- Every effect setting has a **~** button next to it. Pressing it attaches a modulator (a 1-bar sine LFO, with a range that suits the parameter) and opens its editor right under that slider. You no longer pick a target from a list.
  - When a setting is modulated, its label turns pink and the ~ lights up. A number appears on the ~ if it has several modulators.
  - Pressing the ~ again hides or shows the editor.
  - **+ another modulator here** stacks more modulators on the same setting; they add up.
- **Layer motion and opacity:** a new section with the same rows for **opacity** (brightness on the Master), **scale**, **rotation**, **move X** and **move Y**.
  - These have no slider of their own, since the base comes from the mixer and the pad. Instead they show a **live meter**.
  - The section opens by itself when one of them is modulated.
- **All modulators (N)** is a collapsed overview:
  - one line per modulator: its target (changeable) and its source in words, for example "sine LFO, 1 bar" or "envelope on kick (detected)"
  - a **show** link that opens it in place
- The modulator editor says **Adds … to …** instead of "Range", which is what the numbers mean.

**Ghosts: see the modulation**

- While anything is modulated, the output sends the current modulated values back 20 times a second.
- A modulated slider shows a pink **ghost thumb** where the value is right now.
- **The mixer fader shows it too:** modulate Overlay A's opacity and its fader's ghost rides the LFO. The same goes for the Master brightness.
- Ghosts move by changing the page directly, not through React, so fast modulation costs no control-window rendering.

**Sliders for performers**

All effect, modulator and mixer sliders now support:

- **Double-click** to reset to the default.
- **Shift-drag** to fine-tune at a tenth of the speed.
- **Click the number** to type an exact value. Enter sets it; Esc cancels (and does _not_ stop the show).

**Adding effects and presets**

- **+ Add effect** opens a grid of **effect cards**: an icon, the name and a one-line description. For example, "Feedback / trails: trails and tunnels from earlier frames". These replace the dropdown and button.
- **Preset tiles** show their description under the name, for example "Kick Bump: scale +10% on every kick".

### Test results

- `npm run typecheck`, `npm run lint` and Prettier: clean.
- `npm run test:unit`: **183 passing**. New: `fxLive` validation, which accepts per-scope numeric values and rejects unknown scopes, NaN and strings.
- `npm run test:e2e`: **93 passing**. New in `layout.spec.ts`:
  - **Slider gestures:**
    - Double-click resets Pixelate's block size to 16.
    - Typing 40 sets it to exactly 40.
    - A 100 px **Shift-drag** moves it by a tenth of what a plain drag would, checked against the value the output actually uses.
  - **~ on Overlay A's opacity:**
    - Attaches a modulator with its editor in place (1-bar period).
    - The **mixer fader's ghost** appears and moves between two readings 0.4 s apart, staying within 0–1.
    - Removing the modulator hides the ghost.
- **Updated:** the effects tests add Invert from its card and modulate it with **~**, retarget it from the overview, and check Kick Bump through the lit ~ on Scale.
- **Performance:** 1080p with effects is still **60 fps** with 0 dropped frames. Output JavaScript per frame is about 1.1–1.4 ms, including building the live values.

### Manual test script

1. Run `npm run dev`, fire a loop on Overlay A, and choose an audio source (the Test beat is fine).
2. Press **FX** on Overlay A, then **+ Add effect** → **RGB split**.
   - Press **~** next to **Offset**, and set the source to **Beat envelope → Kick**.
   - **Expected:** the picture splits on every kick, and the Offset slider's pink ghost jumps with it.
3. Open **Layer motion and opacity** and press **~** on **Opacity**. **Expected:** the clip pulses once per bar, and the **Overlay A fader in the mixer** shows a ghost riding up and down.
4. On any slider:
   - Double-click: it goes back to the default.
   - Shift-drag: it moves slowly.
   - Click the number, type a value and press Enter.
5. Open **All modulators** to see everything at a glance, and use **show** to jump to one.

### Decisions and defaults

- **A new modulator is a 1-bar sine LFO.** Its range comes from the parameter: opacity −1..0 (pulses to nothing), scale 0..0.1, rotation 0..15°, moves 0..0.05, and effect settings 0..half their range.
- **Live values are sent only while something is modulated**, plus one empty update when modulation stops. With no modulation there's no extra traffic.
- **The ghost shows the final value**, base plus modulation, clamped to the slider's range.
- **Layer-motion rows have no base slider:** the base for those comes from the mixer fader (opacity) and the pad's placement (scale, rotation, position).

### Known issues / limitations

- **Ghosts lag the output by up to about 50 ms**, since they're sent 20 times a second. That's fine for seeing what's happening, but they aren't frame-exact.
- **Shift-drag starts from where the thumb is,** so Shift-clicking somewhere else on the track doesn't jump there; that's intended for fine-tuning.
- **The effects panel is still long** when a layer has several effects, each with its modulators open. Collapsing an effect card is a possible follow-up.

**Approval notes (2026-10-20):** UX-4 approved; UX-5 was requested next.

---

## UX-5: Library and visual polish (completed and approved 2026-10-20)

The last step of `docs/UX_REVIEW.md`. With it, all five steps of the review are done.

### What changed

**Library**

- **Search:** a search box matches clip names and folders.
- **Filter chips** with counts: **All**, **Video**, **GIF / animated**, **Stills**, **Broken**.
  - A chip is hidden when nothing matches it.
  - If the chip you're on empties (for example, after removing the broken clips), the view falls back to All.
  - When nothing matches the search, the library says "No clips match" with a **Show all** link.
- **Names on the thumbnail:** the name and details sit on a dark band at the bottom of each tile, so they're always visible even when only one row of clips fits. Broken clips show their reason in red there, and in full in the tooltip.
- **Broken clips:**
  - A **Remove N broken** button removes them all at once.
  - It offers **Undo** for 10 seconds, the same Undo bar that **Clear library…** uses.
  - Removing a single clip also offers Undo now.
- **Pad counts:** a **▣ N** badge on each tile shows how many pads (across all banks) use that clip; the tooltip says "On N pads".
  - Removing a clip that pads use now **asks first**: "bounce.png is on 1 pad. Remove it…?"

**First run**

- A slim **Get ready** strip above the pads lists three steps:
  1. Add a folder of clips (opens the folder picker).
  2. Choose the audio input (opens Setup → Audio).
  3. Choose the output screen (opens Setup → Output).
- Each step gets a green ✓ when done. "Done" is checked live: there are clips in the library, an audio input is running, and the output is fullscreen or on a non-primary display.
- The strip disappears once all three are done, or when you press **Hide** (remembered).

**Color meanings**

Defined once in the stylesheet (`--live`, `--pending`, `--select`, `--danger`) and applied everywhere:

| Color   | Means                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------- |
| Green   | playing (pads, and the library clip on the output)                                                      |
| Amber   | queued or armed (pads), and the **drop banner**, which was magenta and is now amber/orange              |
| Magenta | the beat (the beat lights, which were cyan) and the selection (pads and library clips, which were cyan) |
| Red     | destructive and error                                                                                   |

This frees cyan to mean only **Overlay B**.

**Type and contrast**

- No readable text below 12 px: meta lines, band names, tempo details, pad labels and effect hints were 9–11 px.
- Every text color was checked against the panel background. All readable text is at least 4.5:1; the dim "CLIP" meter label was raised.

**Window behavior**

- The window itself never scrolls. If the left column (checklist, drop banner, pads, mixer, library) needs more room than the window has, it scrolls on its own; the library always keeps about one row of clips (210 px).
- **Below 1100 px wide:**
  - The right column narrows to 320 px.
  - The library becomes a single horizontally scrolling row.
  - The mixer keeps its five strips side by side, dropping the now-playing line and the % readouts to save height.

**Tests run in their own profile**

- Each test launch gets a fresh, temporary app profile (the `VEEJUS_USER_DATA` environment variable).
- Window storage (the checklist, "More settings") no longer leaks between test runs or into your own settings. This fixes the known issue from UX-3.

### Test results

- `npm run typecheck`, `npm run lint` and Prettier: clean.
- `npm run test:unit`: **183 passing**.
- `npm run test:e2e`: **98 passing**. New in `layout.spec.ts`:
  - **Search and filters:** search narrows to one clip; "No clips match" and **Show all** work; **Video** shows only videos.
  - **Tiles:** the name is on the thumbnail, the **▣ 1** badge and "On 1 pad" tooltip appear, and removing a pad-assigned clip asks first (Cancel keeps it).
  - **Broken clips:** **Broken** shows only error tiles; **Remove N broken** removes them and the view falls back to All; **Undo** brings them back.
  - **First-run strip:** the clips step is checked off, the audio step opens Setup → Audio, and **Hide** removes the strip.
  - **At 1024×700:** the library is a single scrolling row and the five mixer strips stay on one line.
- **Performance:** 1080p with effects is unchanged, at **60.0 fps** with 0 dropped frames.

### Manual test script

1. Start fresh (or clear the app's local storage). **Expected:** the **Get ready** strip shows three steps. Do each one and watch them tick off. The strip goes away after the third, or press **Hide**.
2. Add `fixtures/media`, then **Auto-fill**.
   - Type in **Search**, and try the **Video / GIF / Stills / Broken** chips.
   - Under **Broken**, press **Remove N broken**, then **Undo**.
3. Check that tiles show their names and a **▣ 1** on clips that are on pads. Hover a tile and press ✕. **Expected:** a clip on a pad asks before going.
4. Arm a drop. **Expected:** the banner and the armed pad are amber. Select a pad or a clip: the outline is magenta. Playing things are green.
5. Narrow the window below 1100 px. **Expected:** the library turns into one scrolling row, and the mixer stays in one line.

### Decisions and defaults

- **"Output screen set"** counts as done when the output is fullscreen or sits on a non-primary display. Leaving it windowed on the main screen keeps the reminder until you press **Hide**.
- **Removing broken clips doesn't ask first:** they can't be played, and Undo is there.
- **The drop banner is amber**, matching "armed / pending". The old magenta made it look like a selection.

### Known issues / limitations

- **The left column can scroll at 1366×768** when the **Get ready** strip and a drop banner are both showing; each adds about 40–50 px. Once the strip is done or hidden, the normal perform view fits without scrolling (tested).
- **Mixer strip names truncate below about 1100 px** ("Backgr…"); hover shows the full name.
- **The GIF / animated filter guesses from the file type** until a clip has been read: GIF and APNG count as animated, WebP as a still until its frame count is known.

**Approval notes (2026-10-20):** UX-5 approved as built.

---

## Phase 7: External control and sync (completed and approved 2026-10-21)

### What was built

**MIDI controllers** (control window, Web MIDI)

- **MIDI learn:** press **MIDI learn** in the top bar. A banner explains the steps, and every mappable control gets an outline: amber dashed when unmapped, green when mapped.
  - Click a control: it pulses magenta, and the banner names it, for example "Pad A3: countdown.mp4".
  - Press or move a control on your controller: it's mapped. The banner confirms it ("Mapped: Pad A1: alpha-ball.webm ← Note 36, ch 1 (nanoPAD2)").
  - Map as many as you like, then press **Done**.
  - In learn mode, clicks only pick controls: nothing fires.
- **Mappable:**
  - every pad (by grid position on the current bank)
  - bank tabs, global quantize (cycles)
  - Tap, Beat 1, −10 / +10 ms nudge
  - Stop all, Blackout
  - the four layer faders and master brightness
  - **every effect slider**
  - In **⚙ Setup → MIDI** (no on-screen button): **Arm (hold, like Shift)**, **Fire drop now**, **Next / Previous bank** and **Quantize (cycle)**.
- **Messages:**
  - Note on/off and CC on any channel.
  - **Pad velocity** sets the clip's opacity; there's a per-mapping checkbox, on for pads.
  - CC faders are absolute. For endless encoders, two **relative** modes: two's complement (1 / 127) and 64-centered.
  - A note on a fader target sets it to the velocity.
- **Re-learning** a control replaces its old mapping. Several controls can drive the same target.
- **⚙ Setup → MIDI** (a new tab):
  - devices found, and a live **last message** monitor
  - the learnable extra actions
  - the **controller template**
  - the **LED feedback** output
  - a **mappings list**, with CC mode, velocity and remove per mapping, and **Remove all**
- **Mappings persist:** they're saved in the app profile and come back at the next start.
- **Template: Akai APC mini (mk1).** One click maps:
  - the grid's top four rows → the 32 pads (same layout as the screen)
  - faders 1–4 → layer opacities; master fader → brightness
  - scene buttons → banks A–D, tap, beat 1, stop all, blackout
  - track buttons 1–4 → quantize off / beat / bar / phrase; track button 8 → fire drop now
  - Shift → arm
- **LED feedback:** pad LEDs on the chosen MIDI output show the pad states, and the current bank's button is lit. Only changes are sent.

  | LED             | Pad state |
  | --------------- | --------- |
  | off             | empty     |
  | yellow          | ready     |
  | blinking green  | queued    |
  | green           | playing   |
  | blinking red    | armed     |
  | blinking yellow | stopping  |

  These are the APC mini's velocities; many grid controllers use the same low velocities, so they're also the generic palette.

**Tempo sources** (⚙ Setup → Clock → **Tempo source**)

- **Audio detection**, **Tap / manual**, **MIDI clock** or **Ableton Link**, switchable at any time while running.
- The tempo panel's badge shows **AUTO / LOCKED / MIDI / LINK**, with the source's live status in place of "detected …".
- Controls that don't apply are disabled:
  - **MIDI clock:** all tempo edits.
  - **Link:** Tap, Lock, Beat 1 and nudge.
  - Typed BPM and ×2 / ÷2 still work under Link: they're **proposed to the whole session**, as Link apps do.
- **MIDI clock in:**
  - Follows any MIDI input sending clock.
  - Tempo comes from a line fit over the last 4 beats of ticks, so USB jitter averages out.
  - **Start** (or Continue, or Song Position) gives the position, so bars line up. Without it, only the tempo is followed and the status says "press play on the source to line up bars".
  - If ticks stop, the clock freewheels at the last tempo.
- **Ableton Link:**
  - Uses the official Link SDK through a Node-API binding, running in the main process.
  - Joins the session, follows its tempo and **bar phase** (beat 1 lines up), and proposes tempo changes back.
  - The status shows the tempo and how many other Link apps are connected.

**Switching sources at runtime**

- Switching to MIDI or Link snaps once onto the source's grid (at most half a beat), then converges as before.
- Switching back to internal carries on from where the clock is, at the internal tempo.
- Queued quantized pads fire on the _new_ grid's boundaries. The unit test checks that a bar-quantized pad queued just before a switch fires on a Link downbeat.

**Other additions**

- **Fire drop now:** an armed drop can fire on the next beat (the `dropNow` message, for the MIDI action).
- **Velocity on pads:** `padPress` carries an optional velocity, which the scheduler applies as a gain on the layer's opacity.

**Building Ableton Link** (optional): `npm run build:link`

- It fetches the `@ktamas77/abletonlink` binding (MIT), which includes the Ableton Link SDK.
- It patches the binding's build file for Windows (it hard-codes the macOS platform and C++14), then builds with Visual Studio Build Tools into `native/abletonlink.node`.
- `native/` is gitignored: no Link SDK source is committed.
- Without the module, everything else works, and choosing Ableton Link says "Ableton Link isn't installed (run npm run build:link)".

### Acceptance

| Criterion                                                            | Result                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIDI learn maps a pad in under 5 s                                   | **~0.2 s**: click MIDI learn, click the pad, press the note (automated test)                                                                                                                                      |
| MIDI learn maps a knob in under 5 s                                  | **~0.3 s** for the fader (the test also learns an effect slider)                                                                                                                                                  |
| Mappings persist                                                     | The test restarts the app on the same profile: every mapping is back                                                                                                                                              |
| Link session: beat 1 aligned within one frame                        | A real Link peer (the same Link SDK, in the test process) at 133 BPM: worst offset **0.43–0.61 ms** across runs, against a one-frame limit of 16.7 ms. Tempo followed, and a tempo set in Veejus reached the peer |
| Switching clock sources at runtime doesn't crash; triggers re-anchor | Tested in unit tests (internal → Link with a queued bar pad, freewheel, back to internal) and end to end (internal → MIDI → internal)                                                                             |

### Test results

- `npm run typecheck`, `npm run lint` and Prettier: clean.
- `npm run test:unit`: **203 passing** (20 new).
  - **MIDI clock follower:**
    - tempo through ±1 ms jitter
    - beat time within 1 ms after Start
    - tempo only (no phase) without Start
    - Song Position Pointer
    - timeout
  - **Engine with external sources:**
    - follows MIDI clock: tempo, every beat within a frame, downbeats on the source's bars
    - snaps onto a Link grid and lines up beat 1
    - ignores tempo commands while external, and returns to the internal tempo after
    - freewheels
    - re-anchors a queued bar trigger
  - **MIDI mapping:**
    - parsing (note-off by velocity 0, channels, non-note messages ignored)
    - press detection
    - matching by device, channel and number
    - absolute and both relative CC modes
    - guards and labels
    - APC mini template: 32 unique pad notes, faders, banks, no collisions
    - LED colors per state
  - **Scheduler:** `dropNow`, and pad velocity as opacity.
- `npm run test:e2e`: **106 passing** (8 new):
  - `midi.spec.ts`:
    - learning a pad (it doesn't fire while learning; afterwards velocity 64 gives opacity 0.50)
    - learning a fader and an effect slider; a relative encoder stepping the effect in a burst of 5
    - the APC mini template: LEDs yellow → green on play, Shift-arm shows blinking red, fire drop now, fader 1, bank buttons, stop all
    - the tempo-source picker
    - persistence across a restart
  - `sync.spec.ts`:
    - MIDI clock at 126 BPM injected in real time: tempo within ±0.2 BPM, bars within a frame
    - runtime source switching
    - **Ableton Link with a real peer**
- **Performance:** 1080p with effects is still **60.0 fps** with 0 dropped frames.

### Manual test script

1. **MIDI learn** (your **Korg nanoPAD2** shows up as an input on this machine):
   - Press **MIDI learn**, click pad A1, then hit a nanoPAD2 pad. Map a few more pads, then press **Done**.
   - **Expected:** the nanoPAD2 pads fire the clips. Hit softly and hard: the clip is more transparent when hit softly.
2. ⚙ Setup → **MIDI**:
   - Watch **Last message** while you play the nanoPAD2.
   - Check **Mappings**, then restart Veejus and check that they're still there.
3. A controller with faders or knobs (or the nanoPAD2's X-Y pad, which sends CCs): learn the **Overlay A** fader and an effect slider.
   - For an endless encoder, set its CC mode to **Relative** in the mappings list.
4. **MIDI clock:**
   - ⚙ Setup → Clock → **MIDI clock**. Send clock from a DJ mixer, a drum machine or a DAW, and press play there.
   - **Expected:** the badge shows **MIDI**, the status shows the BPM, and beat 1 follows the source's bar.
5. **Ableton Link:**
   - Run `npm run build:link` once.
   - Start a Link app (Ableton Live, Traktor/Rekordbox with Link on, or a phone app like "Link to MIDI").
   - ⚙ Setup → Clock → **Ableton Link**. Allow network access if Windows asks.
   - **Expected:** "Link: N BPM, 1 other app", the tempo follows, and the beat lights flash with the other app's bar. Type a BPM in Veejus: the other app follows.
6. Switch between sources while a loop plays. **Expected:** no jumps beyond a snap to the new grid, and queued pads still land on beats.

### Decisions and defaults

- **MIDI pads follow the current bank**, like the keyboard: pad mappings are grid positions, not fixed pads. This matches how grid controllers and banks usually work.
- **Mappings live in the app profile** (window storage), not in a set file. Sets arrive in Phase 8, when mappings can be saved with them.
- **MIDI clock listens to every input.** Picking one clock input could come later; most setups have one clock source.
- **Link runs in the main process** (the native module can't load in the sandboxed windows). It's sampled every 20 ms with sub-millisecond timestamps.
- **Tempo commands under Link are proposals to the session:** typed BPM, ×2 and ÷2. Tap is disabled, since tap tempo and a shared session clock fight each other.
- **OSC input was optional and is not included.** The MIDI action layer (`MidiActions`) is where an OSC receiver would plug in.

### Known issues / limitations

- **Ableton Link licensing:** the Link SDK is **GPL-2.0-or-later**, or proprietary under a license from Ableton.
  - Building it locally for your own use is fine.
  - **Distributing** Veejus with Link would require GPL compliance or an Ableton license; the build script keeps it optional and out of the repository. This is your decision before any public release.
- **Windows firewall:** the first time Link starts, Windows may ask whether Veejus (Electron) can use the network. Link needs local network access to find peers.
- **Only one hardware check so far:** your nanoPAD2 was detected. The pad, fader, encoder and LED logic were tested with injected MIDI messages. The APC mini LED colors follow Akai's published protocol, but haven't been checked on a real unit. Link was tested against a real Link peer on this machine, not yet against Ableton Live or a DJ app.
- **APC mini mk2** (RGB) uses a different LED protocol and isn't covered by the mk1 template.
- **MIDI clock jitter:** with very jittery clock sources (some USB interfaces), the fitted tempo may wander by about 0.1 BPM. Bars stay aligned because the phase is re-read every beat.

**Approval notes (2026-10-21):** Phase 7 approved as built.

---

## Phase 8: Sets, persistence, output and hardening (completed and approved 2026-10-21)

### What was built

**Sets** (the set name in the top bar)

- **New, Open…, Save, Save as…** (Ctrl+O, Ctrl+S, Ctrl+Shift+S) and **Recent sets**. A dot by the name marks unsaved changes.
- **Format:** a `.veejus` file, versioned JSON (`veejus-set`, version 1). It holds:
  - the library, with collections and favorites
  - all four pad banks and the trigger settings
  - layer mix and master
  - every effect and modulator
  - clock settings (source, tempo, latency offset, phrase length, tempo range)
  - MIDI mappings
  - audio input and analysis settings
  - background color, library-play settings and output options
- **Media paths** are stored both relative to the set file and absolute. On opening, Veejus looks next to the set file first, so a folder holding the set and its clips can be moved or copied to another machine, then at the original path.
- **Files are written atomically** (temporary file, then rename), so a crash mid-save never leaves a damaged set.
- **Damaged or foreign files** are refused with a reason: "Not a Veejus set file", "saved by a newer version", "The set's pads are damaged".
- **Missing media:** a **Missing clips** dialog lists what wasn't found, and **Search a folder…** looks for the files by name (including subfolders).
  - Pads are re-pointed at the found files automatically.
  - **Continue without them** keeps the pads assigned, showing "(missing clip)".
- **Autosave and restore:**
  - Every change is autosaved to the app profile 1.5 s later, and immediately after a save.
  - The next start brings back exactly where you were, including the set's name and whether it had unsaved changes.
  - The same restore runs after a control-window crash.

**Library: collections and favorites** (search came with UX-5)

- Select a clip to **☆ star it** or **add it to collections**, with autocomplete from existing ones. Tiles show ★.
- The library's filter row adds a **★ Favorites** chip and one chip per collection, combinable with the type filters and search.
- **Random pads** can pick from a collection ("Random from collection: Air Horns") or from favorites. The pad tile reads "Random: Air Horns".

**Output options** (Setup → Output → Picture)

- **Shape:** fill, or letterboxed to **16:9, 4:3, 1:1 or 9:16** (vertical screens and streams), centered with black bars.
- **Resolution:** native, **1080p** or **720p**. The compositor renders at the capped size and the GPU scales it to the screen, for weaker GPUs or 4K outputs.
- **Display choice and fullscreen** were already there (UX-2).
- **Spout / Syphon / NDI:** not built. No candidate native module could be verified against Electron 44 on this machine. `docs/STREAMING_PLAN.md` has the plan: off-screen shared textures, then an optional Spout sender, then NDI. Today, **OBS Window Capture** of the output window is the recommended way to stream.

**Performance hardening**

- **Frame-drop watchdog** with graceful degradation. When the output stays under 52 fps for 3 s, quality steps down one level at a time:
  1. preview monitor smaller and slower
  2. preview paused
  3. picture rendered at 75%

  After 15 s at 58.5 fps or more it steps back up. The control shows a banner while degraded ("The output was dropping frames, so Veejus reduced quality: …"), and Setup → Diagnostics shows the level and GPU memory.

- **GPU memory budget:** at most 6 feedback-trail buffer pairs at once (new trails beyond that are skipped). The output reports its render-target memory.
- **Decoder pool limits** (from Phase 1) remain: 768 MB of decoded image frames and 16 warm videos, both LRU.

**Crash safety**

- **Control-window crash:** it reloads automatically and restores the autosaved set. The output keeps playing throughout, since it never depends on the control to draw.
- **Output-window crash:** it reloads in place (same display, still fullscreen) over a black window background. The control re-sends the mix, effects and options as soon as it's back.
- **Crash loops** back off (5 s between reloads after 3 crashes in a minute).
- **No error dialogs on stage:** uncaught errors in the main process are logged, never shown.

**Settings screen:** Setup now has **Audio · Output · Clock · MIDI · Keys · Diagnostics**. **Keys** lists every shortcut. Remapping keys isn't included; MIDI covers custom controls.

**Packaging:** `npm run dist` builds a Windows installer with electron-builder.

- NSIS, per-user (no admin rights), choice of folder, Start menu and desktop shortcuts, and a new app icon.
- It's **unsigned**; the README documents the SmartScreen "Run anyway" step and how to sign.
- The optional Link module is included when built.

**Soak test:** `npm run soak` (default 60 minutes, `-- --minutes N`).

- Launches the built app with a fresh profile at 1080p and loads all fixture media.
- Runs the test beat, and fires a random pad every 2–5 s: random clip, layer, mode, quantize, placement and entrance, velocity, plus occasional drops and stop-alls. The effect sets switch every minute.
- Samples memory (every process, plus the JS heaps) every 30 s and the output frame rate every 2 s.
- Writes `tmp/soak/soak-<time>.json` and `.md`, with a memory trend (least-squares slope after warm-up) and a PASS / CHECK verdict.

### Acceptance

| Criterion                                              | Result                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save → quit → reopen restores the full set exactly     | **Yes.** The automated test builds a full show, saves it, quits, starts with an empty profile and opens the file. The reopened set is **identical**, compared field by field (everything except the save time), and the output shows it.                |
| 60-minute soak: no crashes                             | **None** in either 60-minute run.                                                                                                                                                                                                                       |
| 60-minute soak: ≥ 58 fps sustained                     | **59.95 fps** average. Lowest 1 s sample 59.9 fps; 0 of 1,735 samples below 58.                                                                                                                                                                         |
| 60-minute soak: no memory growth trend                 | **No trend once warmed up: −11.6 MB/hour** over the second half. See the memory notes below.                                                                                                                                                            |
| Installer installs and runs on a clean Windows machine | **Partly verified.** The installer builds (`dist/Veejus Setup 1.0.0.exe`, 112 MB). The packaged app starts, plays a clip and loads the bundled Link module (automated test). The installer itself hasn't been run on a clean machine: see Known issues. |

**Soak run** (`npm run soak`, report in `tmp/soak/soak-2026-10-21T23-14-56.md`):

- 60 minutes at 1920×1080 with the test beat running.
- 66 clips (fixtures media, keying, perf and stress), including 35 videos against a warm limit of 16, so video players constantly load and unload.
- 1,030 random triggers, 97 of them drops, with the effect set switching every minute.

**Memory, and how it was checked**

- **What happened:** total memory rose from about 1.2 GB to about 1.65 GB over the first ~25 minutes, then stayed level. The second half of the run trends −11.6 MB/hour, with swings of ±100 MB as caches fill and empty.
- **Measured per process:**
  - **Output window:** almost all of the rise.
  - **Control window:** flat at ~240 MB.
  - **GPU process:** levels off at ~420 MB after warm-up.
  - **Both JavaScript heaps:** small and flat (5–30 MB in the output).
- **Diagnostic runs** (15 minutes each, side by side):
  - **Preview monitor off:** the same rise. The preview readback isn't the cause.
  - **12 videos (no player churn):** the output stayed flat at ~300–330 MB.
  - So the plateau comes from many different videos passing through the 16 warm players, consistent with Chromium's media caches filling to their limits.
- **A reuse pool for video elements** was tried and made no difference (a second 60-minute run reached the same plateau), so it was reverted.
- **The soak script now judges the trend over the second half of the run,** after this warm-up.

### Test results

- `npm run typecheck`, `npm run lint` and Prettier: clean.
- `npm run test:unit`: **212 passing** (9 new):
  - **Set files:**
    - a full set survives a round trip
    - the fingerprint ignores the save time
    - foreign, newer and damaged files are refused with the right reason
    - moved clips are remapped in the pads, and still-missing ones are listed
  - **Collection and favorite** pad sources.
  - **Picture layout:** fill, letterbox and pillarbox centering, resolution cap without upscaling, portrait.
  - **Watchdog:** one level per sustained slump, capped at 3, a slow step-by-step recovery, short dips and the in-between zone ignored.
- `npm run test:e2e`: **112 tests**. New in `sets.spec.ts` (6):
  - **Exact save → quit → reopen:** mix, effects, clock, MIDI, output, audio, a collection pad and a favorite.
  - **Autosave restore after a restart.**
  - **Control-window crash:** the output keeps drawing and keeps its loop; the control reloads and restores the set.
  - **Relink after moving the clips folder.**
  - **Letterboxing** to 1:1.
  - **Degradation:** the warning appears, the render scale drops to 75%, then everything restores.
- **New** `packaged.spec.ts`: the built app starts, plays a clip, and loads the bundled Link module.
- **In the full run,** 111 passed. The 1080p perf test dipped to 57 fps right after the 112 MB installer had been built (most likely Windows scanning the new files). Three repeat runs straight after held **60.0 fps with 0 dropped frames**.
- **Two test fixes:**
  - The library hover test now moves the mouse away first. A tile that reflows under a stationary cursor gets no mouseenter.
  - The control-crash test reads the reloaded window through the main process, because Playwright's handle on a crashed page goes stale.

**Two UX fixes found along the way**

- The library's **Undo** bar is now a floating toast, so its disappearing never shifts clips under the cursor.
- The **reduced-quality warning** is a top-bar pill rather than a banner, so nothing moves when quality changes mid-show.

### Manual test script

1. Build a small show: load clips, set some pads, add Kick Bump, map a MIDI control, pick 4:3.
   - **Save as…** "Friday night". **Expected:** the name shows in the top bar with no dot. Change something: the dot appears.
2. Quit and restart. **Expected:** everything is back, including the set name.
3. **New set**, then **Open…** "Friday night". **Expected:** identical.
4. Move the clips folder somewhere else (not the set file), then open the set. **Expected:** the **Missing clips** dialog. **Search a folder…** at the new place: the pads work again.
5. Copy the set file _and_ its clips folder together to another place (or a USB stick), then open it there. **Expected:** no missing clips.
6. Select a clip, ☆ it, add it to "Air Horns". Point a pad at **Random from collection: Air Horns**. **Expected:** it only plays clips from that collection.
7. Setup → Output → Picture → **9:16**. **Expected:** a vertical picture with black bars. Back to **Fill**.
8. Optional: Task Manager → end the "Veejus" renderer process with the highest memory that isn't the GPU process. That's usually the output or the control. **Expected:** the window comes back by itself within a second, and the other keeps running.
9. Installer: run `dist/Veejus Setup 1.0.0.exe` on a machine without the dev setup. Choose **More info → Run anyway** at SmartScreen, install, then start it from the Start menu.

### Decisions and defaults

- **Opening a set replaces the library** with the set's clips. A set is a whole show; merging libraries could come later.
- **Autosave lives in the app profile**, not next to the set file, so it never overwrites your saved set. Saving is always explicit.
- **The audio input is part of the set**, so a set made for the venue's mixer reopens with it. If that device isn't connected, the audio panel says so.
- **Keyboard shortcuts aren't remappable**, but MIDI mappings are. The Keys tab documents the fixed keys.
- **No Spout / NDI yet**, for the reasons in `docs/STREAMING_PLAN.md`. OBS Window Capture covers streaming today.
- **The installer is per-user and unsigned.** Signing needs a certificate, which only you can provide.

### Known issues / limitations

- **The installer hasn't been run on a clean machine.** It's built, and the packaged app passes its automated start-and-play test. But installing it here would put an app with shortcuts and an uninstall entry on your PC, so I didn't run it without asking. Step 9 of the manual test script covers it. It's best done on a second PC or a fresh Windows user account.
- **The installer is unsigned.** SmartScreen warns the first time ("More info → Run anyway"). Signing needs a code-signing certificate.
- **The Link module in the installer is GPL code.** It's included because it was built locally. Before giving the installer to anyone else, decide on Link licensing (Phase 7 note), or build without `native/abletonlink.node`.
- **Restoring after a crash uses the last autosave**, so up to about 1.5 s of the latest changes can be lost.
- **"Search a folder" matches by file name.** Two different clips with the same name in different folders resolve to the first one found.
- **Degradation level 3 renders at 75%,** which is visibly softer. It only kicks in after levels 1–2 didn't restore the frame rate.

**Approval notes (2026-10-21):** Phase 8 approved. The installer acceptance check (install and run on a clean Windows machine) is with the user: they'll run `dist/Veejus Setup 1.0.0.exe` on a clean machine themselves. Phases 0–8 are complete. Phase 9+ (the backlog) needs approval before starting.

## Quick start and auto-play (completed and approved 2026-11-26)

Asked for: easier start-up, easier loading of images and GIFs, and a one-button mode that plays them on the beat, moving from one to the next.

### What was built

- **▶ Auto-play** (top bar, or the **P** key): one button that steps through the library on the beat. The output schedules it like a pad, on the beat clock, so it follows tap tempo, audio detection, MIDI clock and Link alike.
  - **Plays:** images & GIFs (default), everything (videos too), favorites, or a collection.
  - **Change:** **Auto** (default) holds a still for one bar and plays each GIF (or video) through once, stretched slightly so it lasts 1, 2, 4, 8 or 16 beats (nearest on a log scale); or a fixed step of 1, 2, 4, 8 or 16 beats, with GIFs at their normal speed.
  - Changes of a bar or more land on bar lines; the first change may come sooner to get onto the grid.
  - **Order:** in library order, or shuffled (every clip once per round, never the same twice in a row).
  - **Picture:** fill (crop, default), whole picture or stretch; **Layer:** Background by default.
  - The next clip is chosen and loaded a step ahead, so it is ready when its beat comes.
  - A pad fired on the auto-play layer takes over; auto-play waits and comes back on the beat the pad ends. **Esc** (stop everything), the layer's ■ and the library's Stop switch it off, and the button follows.
  - The button counts down the beats to the next change. **▾** opens the settings in the context panel, with **Now** and **Next** (with beats to go).
  - Settings are saved in the set (an optional `autoPlay` field, so older sets still open) and remembered between runs. Switching it on or off isn't an unsaved change. The restored session resumes auto-play if it was on.
- **Quick start:** while the library is empty, a **Start a show in one click** card offers **Choose images & GIFs…** and **Choose a folder…**, and takes dropped files. Importing from it (or pressing Auto-play with nothing loaded) adds the files, starts auto-play and shows the output window if it was hidden. A short notice says how many clips were added.

### Files

- `src/shared/autoplay.ts`: settings, status, step-length rule (`autoStepBeats`), guards.
- `src/core/trigger/scheduler.ts`: the auto-play voice (`setAutoPlay`, stepping in `update`, yielding to pads, switching off on stop).
- `src/renderer/output/main.ts`: which clips a source covers, clip lengths, `setAutoPlay` / `autoPlayStopped` messages.
- `src/renderer/control/useAutoPlay.ts`, `AutoPlay.tsx` (button, panel, quick-start card), `App.tsx`, `useSet.ts`, `ShortcutSheet.tsx`, `control.css`.

### Tests

- Unit (`tests/unit/autoplay.test.ts`, 10 tests): step lengths, in-order timing on the beat and bar grid, GIF stretching only with the Auto step, loading a step ahead, shuffle rounds, yielding to a pad and resuming on the beat it ends, stop all, waiting for clips, changing layer, set validation and the fingerprint.
- End-to-end (`tests/e2e/autoplay.spec.ts`, 4 tests): the quick-start card, one button stepping through only images and GIFs with every change on a beat (within a frame), the panel's Now/Next and a step change to every beat, saving in the set, and P and Esc.

### Manual test script

1. Start with an empty library (Set menu → New set). The **Start a show in one click** card shows above the pads.
2. Press **Choose images & GIFs…** and pick a few images and GIFs. They appear in the library, the output window shows them one after another on the beat, and the Auto-play button turns green with a beat countdown.
3. Tap **Space** along with some music, or type a BPM. The changes follow the new tempo.
4. Press **▾**: the panel shows Now and Next. Try **Every beat**, then **Shuffle**.
5. Fire a pad that plays on the Background layer. It takes over, and auto-play comes back on the beat after it ends.
6. Press **P** to stop and start it, then **Esc**: it stops and the button goes grey.
7. Quit and start Veejus again: the library and auto-play settings come back.

## Beat-locked photo effects (completed and approved 2026-11-26)

Asked for: effects on still photos, in sync with the beat: image pulse, the image folding onto itself, the image bouncing up and down, and a pixel spin that bounces across the image.

### What was built

- **Four new effects** (FX → + Add effect), each a shader pass with its own beat count, so it is locked to whatever clock is running (tap, audio detection, MIDI clock, Link) with no modulator to set up:
  - **Pulse:** the picture swells on every beat (or every N beats) and eases back; Size, Beats per pulse, Brightness (a glow with the swell) and Snap (how sharply it falls back).
  - **Fold:** one half hinges over onto the other like paper: shut (as far as Fold allows) on the beat, open again halfway through the cycle. The folded flap is shaded and its back shows mirrored. Direction: the right side over the left, or the bottom up over the top. Panels (1–8) make it an accordion.
  - **Bounce:** the picture lands on the beat, squashes for a moment, and flies up in a parabola between beats; Height, Beats per bounce, Squash.
  - **Pixel spin:** the picture is cut into square tiles, and a wave of spinning, shrinking tiles sweeps across it and bounces back; Turns, Tile size, Beats per sweep (one pass), Wave width.
- **Presets:** **Photo Pulse**, **Photo Fold**, **Photo Bounce** and **Pixel Spin** join the one-click presets in every FX panel.
- **Auto-play photo effect:** a **Photo effect** setting in the auto-play panel puts one of them on each still photo while auto-play shows it: Pulse, Fold, Bounce, Pixel spin, or **Mix** (the next one in turn for each photo, so no two in a row match). GIFs and videos play untouched. Settings saved before this have no photo effect and still load.
- **Bar alignment:** effects now count beats from bar 1 (as LFOs already did), so a 2- or 4-beat fold or sweep lines up with the bar after **Beat 1** / Enter. The beat passed to shaders wraps at 768 beats instead of 256, so beat counts of 3 or 6 stay seamless too.

### Files

- `src/shared/fx.ts` (effect definitions and presets), `src/renderer/output/effectShader.ts` (the four shaders), `src/renderer/output/stage.ts` (beat wrap), `src/core/modulation/modulation.ts` (when each effect is active).
- `src/shared/autoplay.ts` (`photoFx`), `src/renderer/output/main.ts` (adding the photo effect to the auto-play layer; bar-aligned effect beat; a test hook that returns a pixel with the beat its frame was drawn at), `src/renderer/control/AutoPlay.tsx`, `FxPanel.tsx`.

### Tests

- End-to-end (`tests/e2e/photofx.spec.ts`, 6 tests). For each effect, about 90–150 frames of a red still over black are sampled together with the beat each frame was drawn at, and every clear-cut pixel must match the effect's formula at that beat (and both states must turn up). Plus: the presets add the right effect, and auto-play's Mix puts at least three different photo effects on successive stills (none when switched off).
- Unit: photo-effect settings guard (including older settings without it); the existing guard and preset tests cover the new effects and presets. The guard test now spreads every effect type over two chains, since there are more types (14) than one chain may hold (12).

### Manual test script

1. Load a few photos and press **FX** on the Background strip. Try **Photo Pulse**, **Photo Fold**, **Photo Bounce** and **Pixel Spin** in turn, with music playing or after tapping a tempo. Each moves on the beat.
2. **+ Add effect → Fold**: set Panels to 4 and Direction to up for an accordion.
3. Change the tempo: the effects speed up and slow down with it. Press **Beat 1** on a downbeat: the fold shuts on the bar's beats.
4. Open **Auto-play ▾**, set **Photo effect** to **Mix**, and start auto-play: each photo gets the next effect, and GIFs play without one.
