# amp-account-manager-release

End-to-end release workflow for Amp Account Manager. Builds, notarizes, publishes to GitHub Releases, and updates the Homebrew cask.

## Prerequisites (one-time setup)

- Apple Developer account with notarization credentials set in keychain or env vars
- `GH_TOKEN` exported with `repo` scope (for GitHub Releases + Homebrew tap push)
- Homebrew tap repo `hweihwang/homebrew-amp-account-manager` exists on GitHub

Required env vars for notarization (electron-builder reads these automatically):
```
APPLE_ID=your@apple.id
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
APPLE_TEAM_ID=XXXXXXXXXX
```

## Full release

```bash
# 1. Bump version
npm version patch   # or minor / major

# 2. Run the full release pipeline
GH_TOKEN=xxx npm run release
```

This runs:
1. `npm run build` — TypeScript + Vite renderer
2. `npm run release:builder` — electron-builder: package → sign → notarize → staple → DMG → publish to GitHub Releases
3. `npm run release:clear-notes` — clear auto-generated release notes body
4. `npm run release:cleanup` — delete all old releases/tags, keep only current
5. `npm run homebrew:cask` — generate `homebrew/Casks/amp-account-manager.rb` from the built DMG sha256
6. `npm run homebrew:publish` — clone tap repo, commit + push updated cask

## Step-by-step (manual)

```bash
# Build only
npm run build

# Package + notarize + publish to GitHub Releases
GH_TOKEN=xxx npm run release:builder

# After builder finishes, update Homebrew
npm run homebrew:cask
GH_TOKEN=xxx npm run homebrew:publish

# Cleanup old releases
GH_TOKEN=xxx npm run release:cleanup
```

## What gets published

| Artifact | Target |
|----------|--------|
| `AmpAccountManager-mac-arm64.dmg` | GitHub Release (main download) |
| `AmpAccountManager-mac-arm64.zip` | GitHub Release (auto-updater) |
| `latest-mac.yml` | GitHub Release (auto-updater manifest) |
| `homebrew/Casks/amp-account-manager.rb` | `hweihwang/homebrew-amp-account-manager` tap |

## Troubleshooting

**Notarization fails** → verify `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` are set.

**GH_TOKEN missing** → `export GH_TOKEN=$(gh auth token)` or pass inline: `GH_TOKEN=xxx npm run release`.

**DMG not found for Homebrew cask** → ensure `release:builder` completed successfully; `release/latest-mac.yml` must exist.

**Tap push fails** → check that `hweihwang/homebrew-amp-account-manager` exists and `GH_TOKEN` has write access.
