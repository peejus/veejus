# Sending the output to OBS / streaming (Spout, Syphon, NDI): plan

Phase 8 asked for Spout (Windows), Syphon (macOS) or NDI output "if a viable native module exists, otherwise document a plan". This document is the plan. Phase 8 doesn't include a native video-sharing module, for the reasons below.

## What works today, with no extra software

- **OBS Window Capture.**
  - Add a _Window Capture_ source in OBS and pick "Veejus Output". Set Capture Method to _Windows 10 (1903 and up)_.
  - This uses Windows Graphics Capture. It picks up the output at full frame rate, works while the window is windowed or fullscreen, and costs a GPU copy per frame.
  - **This is the recommended way to stream Veejus now.**
- **OBS Display Capture** of a second screen showing the fullscreen output also works.
- **Letterbox shapes** (Setup → Output → Picture) such as **9:16** make a vertical picture for phone-shaped streams. Capture the window and crop the bars in OBS, or set the OBS canvas to 1080×1920.

## Why there's no Spout / NDI yet

1. **Getting the frames out.** The output is drawn by WebGL in the output window's GPU process. A sender needs that frame as a shared GPU texture, or a CPU copy.
   - **CPU copy:** an async `readPixels` of the 1080p frame every frame is about 8 MB per frame, roughly 500 MB/s. The Phase 5 preview readback (a 320-pixel picture) already showed that synchronous readback costs frames. A full-size copy at 60 fps would threaten the 60 fps target on mid-range GPUs.
   - **Shared texture:** Electron's off-screen rendering can hand frames over as shared GPU textures (`webPreferences.offscreen.useSharedTexture`, in recent Electron versions). That's the efficient route, but it means rendering the output in an off-screen window and presenting it separately. That changes how the output window works, and needs its own performance work.
2. **Native modules.**
   - **Spout:** Spout is a Windows DirectX shared-texture protocol. The candidates are small native addons that take the shared texture handle from Electron's off-screen rendering and publish it as a Spout sender (the `electron-spout` style of binding).
   - **NDI:** NDI needs NewTek/Vizrt's NDI SDK. Its license allows free use, but redistribution has terms (an NDI runtime install or a bundled runtime, and attribution). Node bindings (the `grandiose` family) exist in community forks of varying upkeep.
   - **Syphon:** macOS only; not relevant until there's a macOS build.

   None of these could be verified to build and run against Electron 44 on this machine within Phase 8. An unproven native dependency on the show-critical output path is the kind of risk Phase 8 is meant to remove.

## Plan

| Step | Work                                                                                                                                                                              | Done when                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1    | Prototype off-screen rendering with shared textures for the output (a hidden off-screen window), and measure it against today's 60 fps 1080p four-layer test.                     | Same frame rate and no extra frame of latency.                                                   |
| 2    | **Spout sender** (Windows): a native addon (built like the optional Link module, `npm run build:spout`) that publishes each shared texture as "Veejus". Optional; off by default. | Resolume / OBS's Spout plugin receive the picture at 60 fps with the same latency as the window. |
| 3    | **NDI** as a second optional sender, using the NDI SDK installed by the user. It'll cost CPU encoding, so it gets its own toggle and a resolution choice.                         | OBS (NDI plugin) receives the picture on the local network; CPU cost measured and documented.    |
| 4    | Setup → Output gets "Also send to: Spout / NDI", with status (receivers connected).                                                                                               | Settings saved in the set; failure to load a module never affects the main output.               |

Steps 1–2 are the useful next piece; NDI is optional. Like the Link module, these stay **optional native components**: Veejus must run without them.
