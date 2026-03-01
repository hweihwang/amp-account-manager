# Amp Account Manager

A minimal Electron desktop app to manage multiple [Amp CLI](https://ampcode.com) accounts, switch between them in one click, and handoff threads across accounts.

## Download

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | [Latest Release](https://github.com/hweihwang/amp-account-manager/releases/latest) |

> Windows and Linux builds are not currently published, but the code supports them. PRs welcome.

## Install via Homebrew (macOS)

```bash
brew tap hweihwang/amp-account-manager
brew install --cask amp-account-manager
```

To update:

```bash
brew upgrade --cask amp-account-manager
```

## What It Does

- **Multi-account management** — store multiple Amp profiles (label + API key + optional `AMP_URL`) in encrypted local storage.
- **One-click account switch** — click any account row to set it as active.
- **Usage at a glance** — see per-account `amp usage` so you know which account has budget left.
- **Thread browser** — load and filter threads for the active account.
- **Thread handoff** — generate a concise Markdown summary from `amp threads markdown` and copy it to clipboard.

> **Important:** Amp policy says one account per person. Use this only for accounts you are authorized to operate.

---

## Run Locally

```bash
git clone https://github.com/hweihwang/amp-account-manager.git
cd amp-account-manager
npm install
npm run dev
```

The app opens automatically. Hot-reload is active for both the renderer and the Electron main process.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AMP_MANAGER_WORKSPACE_ROOT` | `~/Projects` | Root workspace path passed to Amp commands |

```bash
AMP_MANAGER_WORKSPACE_ROOT=/path/to/workspace npm run dev
```

## Build from Source

```bash
npm run build      # compile TypeScript + Vite renderer
npm run dist       # package with electron-builder (local, unsigned)
```

Output lands in `release/`.

---

## Tech Stack

- **Electron** — desktop shell
- **React + Vite** — renderer
- **tsup** — main process bundler
- **electron-builder** — packaging, notarization, DMG
- **electron-updater** — in-app update checks

## Contributing

PRs that fix bugs or add platform support are welcome.

1. Fork → branch → PR
2. `npm run typecheck` must pass
3. No test framework — manual smoke test is sufficient

## License

MIT
