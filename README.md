# open-os cli

A small, local-first terminal emulator with optional AI assistance — transparent, safe, and easy to maintain.

Part of **Open-OS** (https://open-os.com/): open, smart tools that make technology more interoperable.

![Welcome screen and model selector](screenshot-1.png)

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

## Download & install (v0.4.3)

Download from the [GitHub Releases page](https://github.com/luishg/open-os-cli/releases/tag/v0.4.3).

### AppImage (any Linux distro)

| File | Size |
|---|---|
| [`open-os-cli-0.4.3.AppImage`](https://github.com/luishg/open-os-cli/releases/download/v0.4.3/open-os-cli-0.4.3.AppImage) | ~105 MB |

```bash
chmod +x open-os-cli-0.4.3.AppImage
./open-os-cli-0.4.3.AppImage
```

No installation needed. Works on any Linux distro with FUSE support. To integrate with your system launcher, use [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) or move it to `~/Applications/` and create a `.desktop` entry.

### Arch Linux (.pacman)

| File | Size |
|---|---|
| [`open-os-cli-0.4.3.pacman`](https://github.com/luishg/open-os-cli/releases/download/v0.4.3/open-os-cli-0.4.3.pacman) | ~73 MB |

```bash
sudo pacman -U open-os-cli-0.4.3.pacman
```

After installing, launch with:

```bash
open-os-cli
```

To uninstall:

```bash
sudo pacman -R open-os-cli
```

### Debian / Ubuntu (.deb)

| File | Size |
|---|---|
| [`open-os-cli_0.4.3_amd64.deb`](https://github.com/luishg/open-os-cli/releases/download/v0.4.3/open-os-cli_0.4.3_amd64.deb) | ~73 MB |

```bash
sudo dpkg -i open-os-cli_0.4.3_amd64.deb
```

After installing, launch with:

```bash
open-os-cli
```

To uninstall:

```bash
sudo dpkg -r open-os-cli
```

### macOS (.dmg)

| File | Size |
|---|---|
| [`open-os-cli-0.4.3-universal.dmg`](https://github.com/luishg/open-os-cli/releases/download/v0.4.3/open-os-cli-0.4.3-universal.dmg) | ~150 MB |

Open the `.dmg` and drag **open-os-cli** to your Applications folder. The DMG is a universal binary that works on both Apple Silicon (M1/M2/M3) and Intel Macs.

> Note: the app is not signed with an Apple Developer certificate. On first launch, right-click → Open to bypass Gatekeeper. Requires macOS 10.15 Catalina or later.

### Windows (.exe)

| File | Size |
|---|---|
| [`open-os-cli.Setup.0.4.3.exe`](https://github.com/luishg/open-os-cli/releases/download/v0.4.3/open-os-cli.Setup.0.4.3.exe) | ~78 MB |

Run the installer. After installing, search for **open-os-cli** in the Start menu.

> Note: the installer is not code-signed. Windows SmartScreen may show a warning — click "More info" → "Run anyway".

To uninstall: Settings → Apps → open-os-cli → Uninstall.

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

## Usage

### Inline mode (Ctrl+Space)
Press **Ctrl+Space** anywhere in the terminal to enter AI mode:

1. A visual separator marks the start of the AI block
2. A colored `open-os >` prompt appears — type your question and press Enter
3. The AI generates a response (shown after completion)
4. If the AI suggests a **single command**, approval options appear:
   - **[I]nsert** — places the command in the terminal prompt for editing
   - **[R]un** — executes the command immediately
   - **[C]ancel** — discards and returns to normal mode
5. If the AI suggests **multiple commands**, they are presented one at a time:
   - **[R]un** — executes that command immediately, then shows the next one
   - **[S]kip** — skips to the next command without executing
   - **[C]ancel** — discards all remaining commands and exits
6. A closing separator marks the end of the AI block

Multi-line commands (heredocs, etc.) are fully supported — the preview shows the first few lines with a "... +N more lines" indicator for longer commands.

Press **Tab** to autocomplete file and directory names while typing your prompt — it works like shell tab-completion, resolving paths relative to your shell's current directory. Press **Escape** at any time to cancel. Use **Arrow Up/Down** to navigate through your previous AI prompts (history is kept for the session, works like shell history).

### Panel mode (click hint bar)
Click the hint bar at the bottom of the window for an overlay panel:

1. Type your question in the input field
2. The AI generates a response (shown after completion)
3. Action buttons appear for suggested commands:
   - **Insert** — writes the command to the terminal
   - **Run** — executes it
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
                                │                     │  (format: json)
                            IPC (ai:chunk) ◄──────────┘
                                │                (streaming)
                                ▼
                    JSON parsed: {text, commands[]}
                    Text displayed, commands shown for review
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
      Single command    Multiple commands       No commands
     [I]nsert [R]un    Sequential review:       exit mode
     [C]ancel          [R]un [S]kip [C]ancel
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
├── build/
│   ├── icon.png          # App icon (1024x1024 source)
│   └── icons/            # Generated sizes (16–512px) for hicolor theme
├── .gitignore
├── src/
│   ├── main.ts           # Electron main: window + PTY + Ollama + config
│   ├── preload.ts        # contextBridge: typed IPC API for renderer
│   └── frontend/
│       ├── index.html    # Layout: terminal + panel + hint bar
│       ├── renderer.ts   # xterm.js, inline AI, panel, response routing
│       └── styles.css    # Electric blue theme, animations
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
| Inline AI mode | `renderer.ts` — state machine (idle/input/streaming/approval), prompt history, visual separators |
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
