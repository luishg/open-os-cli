# Internal reference — build & distribution

## Building for production

Generate distributable packages for Linux:

```bash
npm run dist
```

This runs esbuild (TypeScript bundling) followed by electron-builder. Output goes to `release/`:

| File | Format | Description |
|---|---|---|
| `open-os-cli-{version}.AppImage` | AppImage | Portable executable, works on any Linux distro |
| `open-os-cli-{version}.pacman` | pacman | Native Arch Linux package |
| `open-os-cli_{version}_amd64.deb` | deb | Debian / Ubuntu package |

### Adding more targets

Edit the `build.linux.target` array in `package.json`:

```json
"target": ["AppImage", "pacman", "deb", "rpm"]
```

Available targets: `AppImage`, `deb`, `rpm`, `pacman`, `snap`, `flatpak`. See [electron-builder Linux docs](https://www.electron.build/linux).

### Release checklist (automated)

1. Bump version in `package.json` and `README.md`
2. Commit + push to `main`
3. Tag and push: `git tag v{version} && git push origin v{version}`
4. The CI workflow builds all platforms and creates the GitHub Release automatically

### Release checklist (manual, Linux-only)

1. Bump version in `package.json` and `README.md`
2. `npm run dist`
3. Test the AppImage: `chmod +x release/open-os-cli-*.AppImage && ./release/open-os-cli-*.AppImage`
4. Test the pacman: `sudo pacman -U release/open-os-cli-*.pacman && open-os-cli`
5. Create a GitHub Release, attach the binaries from `release/`

---

## CI/CD — GitHub Actions

Workflow file: `.github/workflows/release.yml`

### Trigger

Pushing a tag matching `v*` (e.g. `git tag v0.5.0 && git push origin v0.5.0`).

### Jobs

**`build`** — runs 3 runners in parallel (`fail-fast: false` so one failure doesn't cancel the others):

| Runner | Platform | Targets | Output |
|---|---|---|---|
| `ubuntu-latest` | Linux | AppImage, pacman, deb | `.AppImage`, `.pacman`, `.deb` |
| `macos-latest` | macOS | dmg (universal) | `.dmg` (arm64 + x64) |
| `windows-latest` | Windows | nsis | `.exe` installer |

**`release`** — runs after all builds complete. Downloads all artifacts and creates a GitHub Release with `softprops/action-gh-release`.

### Platform-specific build dependencies

Each runner installs what it needs before `npm install`:

- **Linux**: `libarchive-tools` — provides `bsdtar`, required by `fpm` to build `.pacman` packages.
- **macOS**: Python via `actions/setup-python` + `pip install setuptools` — required by `node-gyp` to compile the native `node-pty` module. Python 3.12 removed `distutils`; `setuptools` restores it.
- **Windows**: `windows-build-tools` — provides MSVC build tools for `node-gyp`.

### Key details

- `--publish never` is passed to `electron-builder` so it doesn't try to publish to GitHub itself (the `release` job handles that separately via `softprops/action-gh-release`).
- `GH_TOKEN` is still set in the build step environment — electron-builder uses it to download Electron binaries from GitHub (avoids rate limits), not for publishing.
- `node-pty` is a native C++ module. It must be compiled on each target platform with the correct Electron headers. This is why cross-compilation from a single OS doesn't work reliably.
- The `dist` npm script runs `npm run build && electron-builder` without a platform flag — electron-builder auto-detects the current OS. The workflow overrides with `--linux`, `--mac`, or `--win` per runner.
- **macOS universal build**: The `mac.target` config specifies `arch: ["universal"]`. electron-builder builds the app for both arm64 and x64, then merges them into a single universal `.app` bundle using `@electron/universal`. This ensures the DMG works on both Apple Silicon and Intel Macs. `node-pty` is compiled for both architectures during packaging (Xcode on the arm64 runner handles x64 cross-compilation).

### Platform compatibility

| Platform | Minimum version | Architectures |
|---|---|---|
| macOS | 10.15 Catalina (2019) | Apple Silicon (arm64) + Intel (x64) — universal binary |
| Windows | Windows 10 | x64 |
| Linux | Any with glibc 2.31+ | x64 |

> Electron 33 supports macOS 10.15+. The `minimumSystemVersion` is set explicitly in `package.json` to `"10.15"`.

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
command: open-os-cli
finish-args:
  - --share=ipc
  - --socket=x11
  - --socket=wayland
  - --device=dri
  - --share=network            # required for Ollama HTTP
  - --talk-name=org.freedesktop.Notifications
modules:
  - name: open-os-cli
    buildsystem: simple
    sources:
      - type: file
        path: release/open-os-cli-{version}.AppImage
    build-commands:
      - install -Dm755 open-os-cli-{version}.AppImage /app/bin/open-os-cli
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

## Architecture notes

- `@xterm/xterm` and `@xterm/addon-fit` are in `devDependencies` because esbuild bundles them into `dist/frontend/renderer.js`. Only `node-pty` needs to be a runtime dependency (native module, externalized by esbuild).
- `asarUnpack` in the electron-builder config ensures node-pty is extracted from the asar archive at runtime (native modules can't run from inside asar).
- The `postinstall` script has `|| true` so it doesn't fail during electron-builder's production install step where `@electron/rebuild` isn't present.
- System prompt is built dynamically by `buildSystemPrompt()` in `main.ts` — reads OS, distro (`/etc/os-release`), arch, and shell at query time.
- Inline AI mode has visual separators (opening with "open-os" label, closing plain line) drawn with `─` (U+2500) using `term.cols` for dynamic width. The separator color matches the brand dodger blue.
- Inline prompt history: `inlineHistory[]` stores submitted prompts in memory (session-scoped). Arrow Up/Down navigates the history. `inlineHistoryStash` preserves the current input when the user starts navigating, restoring it when they arrow back past the newest entry. Consecutive duplicates are skipped. This is independent of the shell's own history — it only applies inside the `input` state of the inline AI mode.

### Structured AI responses (JSON format)

The Ollama request includes `format: "json"`, which constrains the model to produce valid JSON. The system prompt instructs the LLM to respond with:

```json
{"text": "brief explanation", "commands": ["command1", "command2"]}
```

- Each `commands` entry is a complete, runnable shell command. Multi-line commands (heredocs, etc.) are stored as a single string with embedded `\n`.
- `text` is the explanation shown to the user before any command review.
- An empty `commands` array means no commands were suggested — the text is displayed and inline mode exits.

**Parsing (`parseAiResponse()` in `renderer.ts`)** is defensive:
- Tries `JSON.parse()` first.
- Accepts field-name variations: `text` / `explanation` / `response` for the text field, `commands` / `command` for the array (local LLMs may deviate from the schema).
- On JSON parse failure, falls back to the raw text and runs `extractCommands()` which tries code-fence extraction (```` ```...``` ````) first, then `$ ` prefix detection as a last resort.

**Streaming trade-off**: because JSON is accumulated and parsed only after `ai:done`, the user sees `...` (thinking indicator) during generation instead of streaming text. This is the trade-off for reliable structured extraction.

### Command display and preview

`formatCommandPreview()` renders a command for the terminal:
- Commands of 4 lines or fewer are shown in full (each line indented with 2 spaces).
- Longer commands show the first 3 lines + a gray `… +N more lines` indicator.
- Used by both `showCommandReview()` (multi-command) and `showCommandConfirm()` (single command).

### Sequential command execution (inline mode)

When the AI returns multiple commands, they are presented one at a time for individual approval — not batched.

**State variables** (`renderer.ts`):
- `inlineCommands: string[]` — all commands extracted from the AI response.
- `inlineCommandIndex: number` — which command is currently being reviewed.
- `inlineAcceptedCommands: string[]` — used only for single-command confirm phase.
- `inlineReviewBusy: boolean` — true during the transition delay between commands (blocks input).

**Single command flow** (most common):
1. `onAiDone` sets `inlineCommandIndex = 1` (past review), `inlineAcceptedCommands = [cmd]`.
2. `showCommandConfirm()` displays `► cmd` with `[I]nsert [R]un [C]ancel`.
3. `handleInlineApproval()` enters the confirm phase (index >= commands.length).

**Multi-command flow**:
1. `onAiDone` sets `inlineCommandIndex = 0`, `inlineAcceptedCommands = []`.
2. `showCommandReview()` displays `Command 1/N ─ cmd` with `[R]un [S]kip [C]ancel`.
3. `handleInlineApproval()` enters the review phase (index < commands.length):
   - **[R]un**: closes separator, writes `\r` to PTY for a fresh prompt, then after 50ms writes the command. If more commands remain, sets `inlineReviewBusy = true` and after 500ms opens a new separator and shows the next review. If it was the last command, resets state.
   - **[S]kip**: increments index, shows next review or exits if none remain.
   - **[C]ancel / Esc**: exits inline mode entirely.
4. The 500ms delay between commands lets the PTY flush output before the next review prompt appears.

### Multi-line command execution

When writing a command to the PTY, all `\n` are replaced with `\r` (`cmd.replace(/\n/g, '\r')`). Each `\r` acts as pressing Enter, so heredocs work correctly:
1. `cat > file <<'EOF'\r` → shell enters heredoc mode
2. `line1\r` → heredoc body
3. `EOF\r` → heredoc closes, command executes

This conversion applies to both inline mode (Insert / Run) and panel mode action handlers.
