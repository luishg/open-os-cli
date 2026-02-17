# open-os cli

A small, local-first terminal emulator with optional AI assistance — transparent, safe, and easy to maintain.

Part of **Open-OS** (https://open-os.com/): open, smart tools that make technology more interoperable.

---

## What it is

**open-os cli** is a terminal emulator with integrated AI assistance. It runs your shell normally and adds AI features that are explicit and approval-gated.

- Full terminal emulator (bash/zsh/fish via PTY)
- Two AI interaction modes: **inline** (Ctrl+Space in the terminal) and **panel** (overlay UI)
- Streaming responses from local LLMs via Ollama
- Commands are never executed without explicit user approval
- First-run setup wizard for model selection
- Configuration persisted at `~/.config/open-os-cli/config.json`

---

## Download & install (v0.2.0)

### AppImage (any Linux distro)

| File | Size |
|---|---|
| `open-os-0.2.0.AppImage` | ~105 MB |

```bash
chmod +x open-os-0.2.0.AppImage
./open-os-0.2.0.AppImage
```

No installation needed. Works on any Linux distro with FUSE support. To integrate with your system launcher, use [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) or move it to `~/Applications/` and create a `.desktop` entry.

### Arch Linux (.pacman)

| File | Size |
|---|---|
| `open-os-cli-0.2.0.pacman` | ~73 MB |

```bash
sudo pacman -U open-os-cli-0.2.0.pacman
```

After installing, launch with:

```bash
open-os
```

To uninstall:

```bash
sudo pacman -R open-os-cli
```

### Requirements

- **Ollama** running locally for AI features (`ollama serve`). The terminal works without it — AI features are optional.

---

## Stack

| Layer | Technology | Role |
|---|---|---|
| Window | Electron | Desktop app shell, IPC between processes |
| Terminal | xterm.js + node-pty | Terminal rendering (browser) + real PTY (Node.js) |
| AI | Ollama HTTP API | Local LLM, streaming `/api/chat` |
| Language | TypeScript | Everything |
| Build | esbuild + electron-builder | Bundling + packaging |

---

## Development

### Prerequisites
- **Node.js** 20+
- **Build tools** for native modules (node-pty):
  - Arch Linux: `sudo pacman -S base-devel`
  - Ubuntu/Debian: `sudo apt install build-essential`
- **Ollama** running locally (`ollama serve`)

### Install and start

```bash
git clone <repo-url> open-os-cli
cd open-os-cli
npm install        # installs deps + rebuilds node-pty for Electron
npm start          # builds TypeScript + launches the app
```

### First run
1. The terminal opens with a welcome message
2. Press **Ctrl+Space** — the setup wizard appears if no model is configured
3. Select an Ollama model from the list
4. Start using AI assistance

---

## Building for production

Generate distributable packages for Linux:

```bash
npm run dist
```

This runs esbuild (TypeScript bundling) followed by electron-builder. Output goes to `release/`:

| File | Format | Description |
|---|---|---|
| `open-os-0.2.0.AppImage` | AppImage | Portable executable, works on any Linux distro |
| `open-os-cli-0.2.0.pacman` | pacman | Native Arch Linux package |

### Adding more targets

Edit the `build.linux.target` array in `package.json`:

```json
"target": ["AppImage", "pacman", "deb", "rpm"]
```

Available targets: `AppImage`, `deb`, `rpm`, `pacman`, `snap`, `flatpak`. See [electron-builder Linux docs](https://www.electron.build/linux).

---

## Flatpak / Flathub distribution

Flatpak is the standard way to distribute desktop apps across Linux distros via [Flathub](https://flathub.org/).

### 1. Create a Flatpak manifest

Create `com.open-os.cli.yml` at the project root:

```yaml
app-id: com.open-os.cli
runtime: org.freedesktop.Platform
runtime-version: '24.08'
sdk: org.freedesktop.Sdk
base: org.electronjs.Electron2.BaseApp
base-version: '24.08'
command: open-os
finish-args:
  - --share=ipc
  - --socket=x11
  - --socket=wayland
  - --device=dri
  - --share=network            # required for Ollama HTTP
  - --talk-name=org.freedesktop.Notifications
modules:
  - name: open-os
    buildsystem: simple
    sources:
      - type: file
        path: release/open-os-0.2.0.AppImage
    build-commands:
      - install -Dm755 open-os-0.2.0.AppImage /app/bin/open-os
```

> Note: This is a simplified manifest using the pre-built AppImage. For a Flathub submission, you'll need a full build-from-source manifest. See the [Flathub submission guide](https://docs.flathub.org/docs/for-app-authors/submission/).

### 2. Build locally

```bash
# Install flatpak-builder if not present
# Arch: sudo pacman -S flatpak-builder
# Ubuntu: sudo apt install flatpak-builder

flatpak-builder --user --install build-dir com.open-os.cli.yml
flatpak run com.open-os.cli
```

### 3. Submit to Flathub

1. Fork [flathub/flathub](https://github.com/flathub/flathub) on GitHub
2. Create a branch with your manifest (`com.open-os.cli.yml`)
3. Open a pull request following the [Flathub quality guidelines](https://docs.flathub.org/docs/for-app-authors/requirements/)
4. The Flathub team reviews and merges — your app becomes available via `flatpak install flathub com.open-os.cli`

Requirements for Flathub submission:
- App icon (SVG preferred, at least 256x256 PNG)
- AppStream metadata file (`com.open-os.cli.metainfo.xml`)
- Desktop entry file
- Stable release URL (e.g., GitHub Releases)

---

## Usage

### Inline mode (Ctrl+Space)
Press **Ctrl+Space** anywhere in the terminal to enter AI mode:

1. A colored `open-os >` prompt appears
2. Type your question and press Enter
3. The AI response streams directly in the terminal
4. If the AI suggests commands, approval options appear:
   - **[I]nsert** — places the command in the terminal prompt
   - **[A]ccept & Run** — executes the command
   - **[C]ancel** — discards and returns to normal mode

Press Escape at any time to cancel.

### Panel mode (click hint bar)
Click the hint bar at the bottom of the window for an overlay panel:

1. Type your question in the input field
2. The AI response streams in the panel
3. Action buttons appear for suggested commands:
   - **Insert** — writes the command to the terminal
   - **Accept & Run** — executes it
   - **Cancel** — closes the panel

### Context
Both modes automatically capture the last 30 lines of terminal output and include them with your query, giving the AI context about what you're working on. The system prompt also includes your OS, distro, and shell to get platform-specific suggestions.

---

## Architecture

### Data flow

```
User types in xterm.js
        │
        ▼
   [renderer.ts] ───IPC──► [main.ts] ───node-pty──► bash/zsh
                                │                        │
                                │                        ▼
                                │                   shell output
                                │                        │
                            IPC (pty:data) ◄─────────────┘
                                │
                                ▼
                           xterm.js displays output


Ctrl+Space → inline mode / Click → panel mode
User types question → Enter
        │
        ▼
   [renderer.ts] ───IPC──► [main.ts] ───HTTP──► Ollama :11434
                                │                     │
                            IPC (ai:chunk) ◄──────────┘
                                │                (streaming)
                                ▼
                    Response displayed (inline or panel)
                    Approval options appear
                                │
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
                 [Insert]   [Run]      [Cancel]
                 pty.write  pty.write    close
                 (no \r)   (+ \r)
```

### Key design rule
> The AI layer never talks directly to the PTY. It only produces suggestions. Execution always goes through the approval gate in the renderer.

---

## Project structure

```
open-os-cli/
├── package.json          # deps, version, electron-builder config
├── tsconfig.json         # TypeScript config
├── build.mjs             # esbuild — bundles to dist/
├── .gitignore
├── src/
│   ├── main.ts           # Electron main: window + PTY + Ollama + config
│   ├── preload.ts        # contextBridge: typed IPC API for renderer
│   └── frontend/
│       ├── index.html    # Layout: terminal + panel + hint bar
│       ├── renderer.ts   # xterm.js, inline AI, panel, response routing
│       └── styles.css    # Electric blue theme, animations
├── release/              # generated by `npm run dist`
│   ├── open-os-0.2.0.AppImage
│   └── open-os-cli-0.2.0.pacman
└── README.md
```

### Where each concern lives

| Concern | File |
|---|---|
| Window creation, menus, hotkeys | `main.ts` — `createWindow()` |
| PTY spawn and pipe | `main.ts` — `createPty()` |
| Ollama HTTP streaming | `main.ts` — `queryOllama()` |
| Model listing | `main.ts` — `listOllamaModels()` |
| Config persistence | `main.ts` — `loadConfig()` / `saveConfig()` |
| System info for prompt | `main.ts` — `buildSystemPrompt()` |
| IPC bridge | `preload.ts` — `contextBridge` |
| Terminal rendering | `renderer.ts` — xterm.js setup |
| Inline AI mode | `renderer.ts` — state machine (idle/input/streaming/approval) |
| Panel AI mode | `renderer.ts` — overlay panel with setup wizard |
| Response routing | `renderer.ts` — chunks routed by `aiQuerySource` |
| Welcome message | `renderer.ts` — `showWelcome()` |

---

## Configuration

Settings are stored at `~/.config/open-os-cli/config.json`:

```json
{
  "model": "llama3:latest"
}
```

The model can be changed at any time by clicking the model label in the panel header.

Ollama connection defaults to `localhost:11434`.

---

## Principles
1. **No silent execution** — AI never runs commands without explicit user approval.
2. **Transparency** — AI output is visually distinct from terminal output.
3. **Local-first** — Uses Ollama for fully local inference. No accounts, no telemetry.
4. **Small scope** — Focused terminal + AI assistance. No plugins, no agents, no automation.

---

## Contributing
- Keep PRs small and focused
- Prefer simple solutions
- Avoid adding dependencies unless they reduce maintenance

---

## License
MIT or Apache-2.0, consistent with the Open-OS ecosystem.
