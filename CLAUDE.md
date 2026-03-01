# Amp Account Manager — Claude Rules

## No Tests
- This project has NO tests and will NEVER have tests
- Do NOT write *.test.ts, *.test.tsx, *.spec.ts, *.spec.tsx files
- Do NOT add vitest, jest, @testing-library/*, or any testing libraries
- Do NOT add test scripts to package.json

## Architecture
- **Electron main process** → `electron/main.ts` (bundled to `dist-electron/main.js` via tsup)
- **Preload** → `electron/preload.ts`
- **Renderer** → `src/` with React + Vite (dev server port 5180)
- **Shared types** → `shared/ipc.ts`
- IPC uses `contextBridge` + `ipcMain`/`ipcRenderer` — no `nodeIntegration`

## Dev
```bash
npm run dev        # starts all three: main watcher, Vite renderer, Electron
```

## Build
```bash
npm run build      # tsup + vite build
npm run dist       # build + package locally (unsigned)
```

## Release
Use the release skill: in Claude Code, just ask to release the app.
See `.claude/skills/release.md` for full details.

## Env vars
- `AMP_MANAGER_WORKSPACE_ROOT` — override default workspace root for Amp commands
- `ELECTRON_START_URL` — set by dev script; do not touch manually

## Keys
- Accounts are encrypted via Electron `safeStorage` (OS keychain-backed)
- Never log or expose raw API keys

## electron-builder config
- Lives in `electron-builder.yml` (not inside package.json)
- Notarization is enabled: `notarize: true`
- Publishes directly to `hweihwang/amp-account-manager` GitHub repo (no separate releases repo)
