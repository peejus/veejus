# Veejus

A desktop VJ app for firing short, silly video clips and GIFs in sync with the music's beats and drops.

The build follows the phased plan in [VEEJUS_AGENT_PROMPT.md](VEEJUS_AGENT_PROMPT.md). Progress and per-phase test scripts are in [docs/PROGRESS.md](docs/PROGRESS.md); the module map is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Current status:** Phase 0 (foundation and skeleton).

## Requirements

- Node.js 20.11+ (developed on Node 24)
- Windows 10/11 (macOS should work but is untested)

## Setup

```bash
npm install
```

If Electron's binary did not download during install, run `node node_modules/electron/install.js`.

## Commands

| Command             | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `npm run dev`       | Start the app with hot reload (control window + output window)  |
| `npm run build`     | Production build into `out/`                                    |
| `npm run preview`   | Run the production build                                        |
| `npm test`          | Unit tests (Vitest), then build + end-to-end tests (Playwright) |
| `npm run test:unit` | Unit tests only                                                 |
| `npm run test:e2e`  | Build, then end-to-end tests that launch the real app           |
| `npm run typecheck` | TypeScript checks for main/preload and renderer code            |
| `npm run lint`      | ESLint                                                          |
| `npm run format`    | Prettier                                                        |

## Using it (Phase 0)

- **Control window:** pick a background color, toggle the debug overlay, send the output to any display, go fullscreen.
- **Output window:** what the audience sees. Closing it only hides it ("Show output" brings it back). In the output window, **Esc** exits fullscreen and **F11** toggles it.
