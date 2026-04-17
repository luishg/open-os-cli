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
| `open-os-cli-{version}.x86_64.rpm` | rpm | Fedora / RHEL package |

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
5. Test the rpm: `sudo dnf install release/open-os-cli-*.x86_64.rpm && open-os-cli`
6. Create a GitHub Release, attach the binaries from `release/`

---

## CI/CD — GitHub Actions

Workflow file: `.github/workflows/release.yml`

### Trigger

Pushing a tag matching `v*` (e.g. `git tag v0.5.0 && git push origin v0.5.0`).

### Jobs

**`build`** — runs 3 runners in parallel (`fail-fast: false` so one failure doesn't cancel the others):

| Runner | Platform | Targets | Output |
|---|---|---|---|
| `ubuntu-latest` | Linux | AppImage, pacman, deb, rpm | `.AppImage`, `.pacman`, `.deb`, `.rpm` |
| `macos-latest` | macOS | dmg (universal) | `.dmg` (arm64 + x64) |
| `windows-latest` | Windows | nsis | `.exe` installer |

**`release`** — runs after all builds complete. Downloads all artifacts and creates a GitHub Release with `softprops/action-gh-release`.

### Platform-specific build dependencies

Each runner installs what it needs before `npm install`:

- **Linux**: `libarchive-tools` — provides `bsdtar`, required by `fpm` to build `.pacman` packages. `rpm` — provides `rpmbuild`, required by `fpm` to build `.rpm` packages.
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
- Inline AI mode has visual separators (opening with "open-os" label, closing plain line) drawn with `─` (U+2500) using `tab.term.cols` for dynamic width. The separator color matches the brand dodger blue.
- Inline prompt history: `tab.inlineHistory[]` stores submitted prompts in memory (session-scoped, per-tab). Arrow Up/Down navigates the history. `tab.inlineHistoryStash` preserves the current input when the user starts navigating, restoring it when they arrow back past the newest entry. Consecutive duplicates are skipped. This is independent of the shell's own history — it only applies inside the `input` state of the inline AI mode.

### Tab system

The application supports two types of tabs: **terminal tabs** (xterm.js + PTY) and **chat tabs** (DOM-based LLM conversation). Both share the same tab bar, numbering sequence, and lifecycle. The model panel overlay is shared across all tabs (model selection and info only — no query functionality).

**Tab identification:** Monotonically incrementing integer IDs generated by the renderer (e.g., `"1"`, `"2"`, `"3"`). The renderer owns tab lifecycle; the main process manages PTYs (terminal tabs) or conversation state (chat tabs) keyed by the tab ID it receives.

**Tab types:**
- **Terminal tabs** (`type: 'terminal'`): Full xterm.js terminal with PTY, inline AI mode. Title: "Terminal N".
- **Chat tabs** (`type: 'chat'`): DOM-based chat interface for direct LLM conversation. No PTY, no xterm.js. Title: "Chat N". Uses `chat:query` IPC (free-form text, no JSON format) instead of `ai:query` (JSON-structured terminal commands).

**Main process (`main.ts`):**
- `tabs = new Map<string, TabState>()` — each `TabState` holds `type: 'terminal' | 'chat'`, `shell: pty.IPty | null`, and `conversationHistory: ChatMessage[]`.
- `createTab(tabId)` spawns a new PTY for terminal tabs.
- `createChatTab(tabId)` creates a chat tab state (no PTY, just conversation history).
- `destroyTab(tabId)` kills the PTY if present and removes from the map.
- `queryOllama(tabId, prompt, context)` — terminal AI: uses `format: "json"`, terminal system prompt, terminal context.
- `queryChatOllama(tabId, prompt)` — chat AI: free-form text, conversational system prompt, no terminal context. Higher history limit (`MAX_CHAT_HISTORY_MESSAGES = 50`).
- Both query functions stream responses via the same `ai:chunk`, `ai:done`, `ai:error` channels.
- PTY handlers (`pty:write`, `pty:resize`) are null-safe — they silently no-op for chat tabs.
- On `window-all-closed`, only tabs with a shell have it killed.

**Renderer (`renderer.ts`):**
- `TabInstance` interface includes `type: 'terminal' | 'chat'` and chat-specific fields (`chatMessagesEl`, `chatInputEl`, `chatSendBtn`, `chatStreamEl`, `chatStreamBuffer`, `chatInThinking`). Terminal-specific fields (`term`, `fitAddon`) are `null` for chat tabs.
- `tabInstances = new Map<string, TabInstance>()` with `activeTabId` tracking the visible tab.
- `createTabInstance()` creates terminal tabs (xterm.js + PTY).
- `createChatTabInstance()` creates chat tabs (DOM chat interface + no PTY).
- `switchToTab(tabId)` focuses the terminal (terminal tabs) or chat input (chat tabs).
- `closeTab(tabId)` disposes the terminal or removes chat DOM, sends `tabClose(id)`.
- IPC callbacks route by `tabId` and `aiQuerySource`: `'chat'` routes to chat message rendering, `'inline'` routes to terminal AI handling.
- Ctrl+Space on chat tabs focuses the chat input instead of entering inline mode.
- Copy/Paste/Clear context menu actions handle both tab types.

**Chat tab features:**
- Lightweight markdown renderer (`renderMarkdown()`) handles code blocks, inline code, bold, italic, headers, lists.
- Thinking block detection (`parseChatResponse()`) parses `<think>...</think>` tags from reasoning models and renders them in a styled block.
- Streaming: on each `ai:chunk`, the assistant message is re-rendered with `renderStreamingMessage()`. On `ai:done`, `finalizeStreamingMessage()` removes the streaming cursor and applies final markdown.
- Input is disabled during streaming and re-enabled on completion.
- Each chat tab displays a welcome banner with instructions explaining it's a chat (not a terminal).

**IPC protocol:** All PTY and AI channels include `tabId` as the first data argument. Channels:
- `tab:create` (renderer → main) — create terminal tab
- `tab:create-chat` (renderer → main) — create chat tab
- `tab:close` (renderer → main) — destroy either tab type
- `tab:new-request` (main → renderer) — context menu "New Tab"
- `tab:new-chat-request` (main → renderer) — context menu "New Chat Tab"
- `chat:query` (renderer → main) — chat tab query (free-form text)
- `ai:query` (renderer → main) — terminal AI query (JSON format)
- `ai:chunk/ai:done/ai:error` (main → renderer) — shared streaming response channels

**DOM structure:**
```html
<div id="tab-bar">
  <div class="tab active" data-tab-id="1">
    <span class="tab-title">Terminal 1</span>
    <button class="tab-close">&times;</button>
  </div>
  <div class="tab" data-tab-id="2">
    <span class="tab-title">Chat 2</span>
    <button class="tab-close">&times;</button>
  </div>
  <button id="tab-add">+</button>
</div>
<div id="terminal-container">
  <div class="terminal-pane active" data-tab-id="1">
    <!-- xterm.js canvas renders here -->
  </div>
  <div class="terminal-pane chat-pane" data-tab-id="2">
    <div class="chat-welcome"><!-- welcome banner + instructions --></div>
    <div class="chat-messages"><!-- scrollable message list --></div>
    <div class="chat-input-row">
      <textarea class="chat-input"></textarea>
      <button class="chat-send">Send</button>
    </div>
  </div>
</div>
```

**Tab bar behavior:**
- "+" button and right-click "New Tab" both call `createAndSwitchNewTab()`.
- Right-click "New Chat Tab" calls `createAndSwitchNewChatTab()`.
- Close button hidden when only 1 tab exists (CSS: `#tab-bar[data-tab-count="1"] .tab-close { display: none; }`).
- Active tab has accent-colored bottom border; inactive tabs match the hint bar colors.
- Terminal panes use `position: absolute` with `display: none`/`display: block` toggling. Chat panes use `display: none`/`display: flex` (overridden by `.chat-pane.active` CSS).

### Configuration system

Settings live at `~/.config/open-os-cli/config.conf` in Ghostty/Kitty-style key-value format (`key = value`, `#` comments). This format was chosen over JSON because: (1) `.conf` has MIME type `text/plain`, so `xdg-open` opens it in a text editor (not a browser), (2) it supports comments, and (3) it matches what most popular Linux terminals use (Ghostty, Kitty, Foot).

**Config format example:**
```conf
# Font
font-family = "Cascadia Code", monospace
font-size = 14
# Cursor
cursor-blink = true
cursor-style = block
```

**Config lifecycle:**
1. `loadConfigRaw()` reads `.conf` file via `parseConfFile()` → returns flat `Record<string, string>`.
2. `resolveConfig()` maps flat keys to typed `ResolvedConfig` with validation (clamped numbers, enum-checked strings, boolean parsing). Returns fully-typed object — no optional fields, always safe to use.
3. `config:get` IPC handler returns `resolveConfig()` — the renderer always gets a complete config.
4. `config:save-model` uses `saveConfigKey()` which preserves existing file content (comments, other keys) and only updates the specific key.

**Migration:** On first startup, `migrateJsonConfig()` checks for an old `config.json` and migrates the `model` field to `config.conf`. The old JSON file is left in place for safety.

**Theme system:** Theme files at `~/.config/open-os-cli/themes/{name}.json` are referenced by name via `theme = name` in config. `loadTheme(name)` reads and merges with `DEFAULT_THEME`. If the file is missing or invalid, `DEFAULT_THEME` is returned silently. Theme colors are split into `terminal` (xterm.js ITheme fields) and `ui` (CSS custom properties for panel, hint bar, and accent colors). Themes stay as JSON because they're structured data not frequently hand-edited.

**Keybinding system:** `keybind-ai-trigger` is a human-readable string (e.g., `Ctrl+Space`, `Ctrl+Shift+A`). `parseKeybinding()` converts it to `{ control, shift, alt, meta, code }` matching Electron's `before-input-event` API. The renderer displays the configured trigger label in the welcome message, hint bar, and onboarding text via `getAiTriggerLabel()`.

**Config application in renderer:** `applyConfig()` runs during startup (before the first tab is created). It caches config and theme globally, applies UI theme CSS custom properties on `:root`, then calls `applyConfigToTab()` on every existing tab. New tabs automatically receive the cached config. Per-tab application:
- **Terminal tabs**: Font, cursor, scrollback → `tab.term.options.*`; terminal theme colors → `tab.term.options.theme`
- **Chat tabs**: Font family/size, foreground/background → `tab.paneEl.style.*` (CSS inline)
- **Both**: Padding → inline style on `tab.paneEl`

**Opening config:** "Settings" in the right-click context menu and the gear icon in the AI panel header both call `openConfigFile()`, which ensures the config file exists (writes all defaults if missing, preserves existing values) and opens it with a platform-specific text editor: `open -t` on macOS, `$VISUAL`/`$EDITOR`/`xdg-open` on Linux, `shell.openPath()` on Windows.

### Model panel

The slide-up panel (`#ai-panel`) is used exclusively for model selection and info display — it has no query functionality.

**States:**
- **No model configured** (`showSetup()`): fetches model list from Ollama (`/api/tags`), displays buttons to select one.
- **Model selected** (`showModelInfo()`): fetches model metadata from Ollama (`/api/show`), displays family, parameter size, quantization, context window, and capability badges (thinking, vision, tools, completion). "Change model" button returns to selection.

**Model info API** (`showOllamaModel()` in `main.ts`): POST to `/api/show` with `{name: modelName}`. Returns `details` (family, parameter_size, quantization_level, format), `capabilities` array, and `model_info` (architecture-specific keys like `{family}.context_length`).

**Chat tab model info bar**: Below the chat input, `loadChatModelInfo()` fetches the same `/api/show` data and renders a compact summary with capability badges. Also caches `chatModelContextLength` for context usage percentage in response metrics.

**Chat response metrics**: The final streaming chunk (`done: true`) includes `eval_count`, `eval_duration`, `prompt_eval_count`, `prompt_eval_duration`, `total_duration` (all in nanoseconds). `finalizeStreamingMessage()` renders: tokens, tok/s, TTFT, total time, and context usage bar (if context length is known).

### Structured AI responses (JSON format)

The Ollama request for **terminal inline mode** includes `format: "json"`, which constrains the model to produce valid JSON. The system prompt instructs the LLM to respond with:

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

**State variables** (per-tab fields on `TabInstance` in `renderer.ts`):
- `tab.inlineCommands: string[]` — all commands extracted from the AI response.
- `tab.inlineCommandIndex: number` — which command is currently being reviewed.
- `tab.inlineAcceptedCommands: string[]` — used only for single-command confirm phase.
- `tab.inlineReviewBusy: boolean` — true during the transition delay between commands (blocks input).

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

This conversion applies to inline mode (Insert / Run).

### Chat agent mode (web tools)

Chat tabs turn into a basic agent when the configured model has Ollama capability `tools`. The implementation is intentionally minimal — **zero new dependencies** (only Node.js `http`/`https` + regex), and contained in a single module so it can be swapped out without touching the chat flow.

**What the agent can do:** two tools, both read-only.

| Tool | Implementation | Contract |
|---|---|---|
| `web_search(query)` | `src/tools/web.ts` — `webSearch()` | GET `https://html.duckduckgo.com/html/?q=…`, regex-parses `result__a` + `result__snippet`, decodes the `uddg` redirect param, returns top 5 formatted results (≤2 KB). |
| `fetch_url(url)` | `src/tools/web.ts` — `fetchUrl()` | GETs an http/https URL with a Chrome UA, follows ≤3 redirects, 10s timeout, 1 MB body cap, accepts only `text/html`/`text/plain`, strips `<script>/<style>/<noscript>/<!--comments-->/tags`, decodes entities, truncates to 5000 chars. Refuses internal hosts (`localhost`, `127/8`, `10/8`, `192.168/16`, `169.254/16`, `172.16/12`, IPv6 loopback/link-local/ULA). |

Both funnel through `executeTool(name, args)` which wraps errors — a failure becomes `ERROR: …` in the tool-result content, and the model decides how to handle it (it usually apologizes and moves on, no crash).

**Tool schemas** (`TOOL_SCHEMAS` in `tools/web.ts`) follow the OpenAI-style `{type: 'function', function: {name, description, parameters}}` shape that Ollama accepts natively. Passed to `/api/chat` as the top-level `tools` array.

**Agent loop** lives in `main.ts` — `queryChatOllama()` is now `async` and iterates up to `MAX_TOOL_ROUNDS = 4`. Each iteration calls `streamOneRound()`, which does one streaming HTTP request to `/api/chat` and returns `{text, toolCalls, metrics}`. The loop:

1. Pushes `{role: 'user', content: prompt}` to `tab.conversationHistory` (remembers `rollbackLength` for error recovery).
2. Per round: prepends the chat system prompt (only if tools are active), calls `streamOneRound()`, emits `ai:chunk` / `ai:thinking-chunk` as tokens arrive.
3. If the round returned no `tool_calls`: pushes the final assistant message, emits `ai:done` with metrics, returns.
4. Otherwise: pushes `{role: 'assistant', content, tool_calls}` so the model sees its own request on the next turn. For each call, emits `ai:tool-call`, runs `executeTool()`, pushes `{role: 'tool', content, tool_name}`, emits `ai:tool-result` (with content truncated to 300 chars for the UI — full text stays in history).
5. If round 4 still has tool calls: emits a synthetic `ai:tool-result` with `[aborted: max tool rounds reached]` + `ai:done`.
6. On any exception: `history.length = rollbackLength` rolls history back to pre-query state (so retry is clean), then emits `ai:error`.

**Capability detection** — `modelSupportsTools(model)` memoizes per-model via `toolCapabilityCache: Map<string, boolean>`, populated from `showOllamaModel()`'s `capabilities` array. If the model lacks `tools`, we send the request without the `tools` field and skip the system prompt — behavior is identical to pre-0.7.0 chat.

**System prompt** — `buildChatSystemPrompt()`. Injected **only when tools are active**. Instructs the model to use tools only for info outside its training data and to cite URLs. Chat tabs without tools still send no system prompt (unchanged behavior).

**Config flag** — `chat-tools-enabled` in `config.conf` (default `true`). Resolved into `ResolvedConfig.chat.toolsEnabled`. Setting it to `false` skips the capability check and the `tools` payload entirely.

**IPC channels added:**
- `ai:tool-call` (main → renderer) — `(tabId, name: string, args: Record<string, unknown>)` fires when the agent is about to run a tool.
- `ai:tool-result` (main → renderer) — `(tabId, name: string, result: string)` fires with a ≤300-char preview after the tool returns.

Existing `ai:chunk`, `ai:thinking-chunk`, `ai:done`, `ai:error` are unchanged. `ai:done` is emitted **only once per user query** — in the final round that returns no tool_calls — with that round's metrics.

**Renderer rendering** — `TabInstance` now has `chatSegments: ChatSegment[]` where:

```ts
type ChatSegment =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool-call'; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; name: string; content: string };
```

Segments are appended in arrival order by the IPC handlers (`appendTextChunk`, `appendThinkingChunk`, and direct `push` for tool segments). `renderSegmentsHtml()` walks them and builds the assistant bubble — text via `renderMarkdown()`, thinking via `.chat-thinking`, tool calls via `.chat-tool-call`, tool results via `.chat-tool-result`. This is why tool-call blocks appear **inline** between text paragraphs instead of as separate messages — the whole agent turn is one bubble.

The legacy `<think>...</think>` fallback for older reasoning models is preserved inside text segments by `extractLegacyThink()` at render time.

**CSS** — `.chat-tool-call` (accent left border, 🔧 header, monospace), `.chat-tool-call-args` (key: value pairs), `.chat-tool-result` (darker border, `max-height: 200px` with overflow scroll so long results don't blow up the bubble). All in `src/frontend/styles.css` right after `.chat-thinking`.

**Fragility note** — DuckDuckGo HTML endpoint is the most fragile surface here. If their markup changes and the regex breaks, symptoms will be empty `web_search` results (the model will say "I found nothing" instead of crashing). Swap is local: rewrite `webSearch()` to hit a SearXNG instance (`/search?format=json`) — no other code changes needed since the rest of the pipeline is tool-agnostic.
