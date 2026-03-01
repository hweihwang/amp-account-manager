# amp-account-manager-release

End-to-end release workflow for Amp Account Manager. Builds, notarizes, staples, publishes to GitHub Releases (same repo), updates Homebrew cask.

Modeled after the codexuse-full-release skill.

## Env vars (already in environment — no setup needed)

```
APPLE_API_KEY=/Users/hweihwang/Downloads/AuthKey_RG657XT2D5.p8
APPLE_API_KEY_ID=RG657XT2D5
APPLE_API_ISSUER=f88b0140-3ca4-4291-9535-205cabbf7954
GH_TOKEN=<already set>
```

Tap repo: `hweihwang/homebrew-amp-account-manager`

---

## Full Release Steps

### 1. Preflight

```bash
git status --short --branch
version=$(node -e "console.log(require('./package.json').version)")
echo "Releasing v${version}"
```

### 2. Bump Version

```bash
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json'));
const [,ma,mi,p] = pkg.version.match(/^(\d+)\.(\d+)\.(\d+)/);
pkg.version = \`\${ma}.\${mi}.\${Number(p)+1}\`;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('v' + pkg.version);
"
version=$(node -e "console.log(require('./package.json').version)")
```

### 3. Build

```bash
npm run build
```

### 4. electron-builder: package + sign + ZIP + publish to GitHub

```bash
npx electron-builder \
  --config electron-builder.yml \
  --mac zip \
  --arm64 \
  --publish always
```

This signs the app with Developer ID, produces a ZIP + `latest-mac.yml`, and uploads them to `hweihwang/amp-account-manager` GitHub releases.

### 5. Build DMG (background while notarization submits)

```bash
(
  app_path="release/mac-arm64/Amp Account Manager.app"
  dmg_path="release/AmpAccountManager-mac-arm64.dmg"
  tmp_dir=$(mktemp -d)
  cp -R "$app_path" "$tmp_dir/"
  ln -s /Applications "$tmp_dir/Applications"
  hdiutil create -volname "Amp Account Manager" -srcfolder "$tmp_dir" -ov -format UDZO "$dmg_path"
  identity=$(codesign -dvv "$app_path" 2>&1 | sed -n 's/^Authority=\(Developer ID Application:.*\)$/\1/p' | head -1)
  codesign --force --sign "$identity" --timestamp "$dmg_path"
  rm -rf "$tmp_dir"
) &
DMG_PID=$!
```

### 6. Sync latest-mac.yml to include DMG entry

After electron-builder produces `latest-mac.yml` with only the ZIP, we'll update it after DMG is ready (step 9).

### 7. Wait for DMG + Notarize + Staple (BLOCKING)

```bash
wait $DMG_PID

submit_output=$(xcrun notarytool submit "release/AmpAccountManager-mac-arm64.dmg" \
  --key "${APPLE_API_KEY}" \
  --key-id "${APPLE_API_KEY_ID}" \
  --issuer "${APPLE_API_ISSUER}" \
  --force \
  --output-format json)
submission_id=$(echo "$submit_output" | grep -o '"id": "[^"]*"' | head -1 | cut -d'"' -f4)
echo "Notarization submitted: $submission_id"

for i in {1..60}; do
  sleep 10
  status=$(xcrun notarytool info "$submission_id" \
    --key "${APPLE_API_KEY}" \
    --key-id "${APPLE_API_KEY_ID}" \
    --issuer "${APPLE_API_ISSUER}" \
    --output-format json 2>/dev/null | grep -o '"status": "[^"]*"' | cut -d'"' -f4)
  echo "[$i/60] Status: $status"
  if [ "$status" = "Accepted" ]; then break
  elif [ "$status" = "Invalid" ] || [ "$status" = "Rejected" ]; then echo "Notarization failed"; exit 1; fi
done

xcrun stapler staple "release/AmpAccountManager-mac-arm64.dmg"
xcrun stapler validate "release/AmpAccountManager-mac-arm64.dmg"
echo "DMG notarized and stapled"
```

### 8. Upload DMG to existing GitHub release

```bash
gh release upload "v${version}" -R hweihwang/amp-account-manager \
  release/AmpAccountManager-mac-arm64.dmg
```

### 9. Post-release cleanup + Homebrew

```bash
npm run release:clear-notes
npm run release:cleanup
npm run homebrew:cask
npm run homebrew:publish
```

### 10. Commit + push

```bash
git add -A
git commit -m "chore(release): v${version}"
git push origin main
```

---

## What gets published

| Artifact | Where |
|----------|-------|
| `AmpAccountManager-mac-arm64.zip` | GitHub Release (auto-updater) |
| `AmpAccountManager-mac-arm64.dmg` | GitHub Release (main download) |
| `latest-mac.yml` | GitHub Release (auto-updater manifest) |
| `homebrew/Casks/amp-account-manager.rb` | `hweihwang/homebrew-amp-account-manager` tap |

## Notes

- DMG **must** be notarized and stapled before Homebrew cask is generated (sha256 must match final artifact)
- electron-builder handles app signing automatically via `APPLE_API_KEY*` env vars
- No separate releases repo — releases live directly on `hweihwang/amp-account-manager`
