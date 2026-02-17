# Internal reference — build & distribution

## Building for production

Generate distributable packages for Linux:

```bash
npm run dist
```

This runs esbuild (TypeScript bundling) followed by electron-builder. Output goes to `release/`:

| File | Format | Description |
|---|---|---|
| `open-os-{version}.AppImage` | AppImage | Portable executable, works on any Linux distro |
| `open-os-cli-{version}.pacman` | pacman | Native Arch Linux package |

### Adding more targets

Edit the `build.linux.target` array in `package.json`:

```json
"target": ["AppImage", "pacman", "deb", "rpm"]
```

Available targets: `AppImage`, `deb`, `rpm`, `pacman`, `snap`, `flatpak`. See [electron-builder Linux docs](https://www.electron.build/linux).

### Release checklist

1. Bump version in `package.json`
2. `npm run dist`
3. Test the AppImage: `chmod +x release/open-os-*.AppImage && ./release/open-os-*.AppImage`
4. Test the pacman: `sudo pacman -U release/open-os-cli-*.pacman && open-os`
5. Create a GitHub Release, attach the binaries from `release/`

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
        path: release/open-os-{version}.AppImage
    build-commands:
      - install -Dm755 open-os-{version}.AppImage /app/bin/open-os
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
- Command detection: the LLM is instructed to prefix commands with `$ `. The renderer extracts lines starting with `$ ` and shows approval options. This is a simple convention — no structured output or code block parsing.
