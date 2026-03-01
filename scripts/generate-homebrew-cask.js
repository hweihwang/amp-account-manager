#!/usr/bin/env node
// Generates homebrew/Casks/amp-account-manager.rb from the release build output.
// Run after `npm run release:builder`.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const releaseDir = path.join(repoRoot, "release");
const latestMacPath = path.join(releaseDir, "latest-mac.yml");
const packageJsonPath = path.join(repoRoot, "package.json");
const githubRepo = process.env.AMP_MANAGER_GITHUB_REPO || "hweihwang/amp-account-manager";

function findDmgInReleaseDir() {
  if (!fs.existsSync(releaseDir)) return null;
  const candidates = fs.readdirSync(releaseDir).filter(f =>
    /^AmpAccountManager-mac-.*\.dmg$/.test(f),
  );
  return candidates[0] ?? null;
}

function readLatestMac() {
  if (!fs.existsSync(latestMacPath)) {
    throw new Error(`Missing ${latestMacPath}. Run the release build first.`);
  }

  const raw = fs.readFileSync(latestMacPath, "utf8");
  const normalized = raw.replace(/^\uFEFF/, "");
  const versionMatch = normalized.match(/^version:\s*(.+)\s*$/m);
  const fileUrls = [...normalized.matchAll(/- url:\s*(\S+)\s*$/gm)].map(m => m[1].trim());
  const dmgFileFromYaml = fileUrls.find(f => f.endsWith(".dmg")) ?? null;
  const dmgFile = dmgFileFromYaml ?? findDmgInReleaseDir();
  const zipFile = fileUrls.find(f => f.endsWith(".zip")) ?? null;
  const artifactFile = dmgFile ?? zipFile ?? null;

  if (!versionMatch) throw new Error("Unable to find version in latest-mac.yml");
  if (!artifactFile) throw new Error("Unable to find DMG/ZIP entry in latest-mac.yml");

  return { version: versionMatch[1].trim(), artifactFile };
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function loadDescription() {
  if (!fs.existsSync(packageJsonPath)) return "Desktop account manager for Amp CLI";
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  return pkg.description || "Desktop account manager for Amp CLI";
}

function buildCask({ version, artifactFile, sha256, description }) {
  const downloadUrl = `https://github.com/${githubRepo}/releases/download/v#{version}/${artifactFile}`;
  return `cask "amp-account-manager" do
  version "${version}"
  sha256 "${sha256}"

  url "${downloadUrl}"
  name "Amp Account Manager"
  desc "${description}"
  homepage "https://github.com/${githubRepo}"

  depends_on arch: :arm64
  auto_updates true

  app "Amp Account Manager.app"

  uninstall quit: "com.hweihwang.amp-account-manager"

  zap trash: [
    "~/Library/Application Support/Amp Account Manager",
    "~/Library/Logs/Amp Account Manager",
    "~/Library/Preferences/com.hweihwang.amp-account-manager.plist",
    "~/Library/Saved Application State/com.hweihwang.amp-account-manager.savedState",
  ]
end
`;
}

function main() {
  const { version, artifactFile } = readLatestMac();
  const artifactPath = path.join(releaseDir, artifactFile);

  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing release artifact at ${artifactPath}. Run the release build first.`);
  }

  const sha256 = sha256File(artifactPath);
  const description = loadDescription();
  const cask = buildCask({ version, artifactFile, sha256, description });

  const outPath = path.join(repoRoot, "homebrew", "Casks", "amp-account-manager.rb");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, cask, "utf8");
  console.log(`Wrote ${outPath}`);
}

if (require.main === module) {
  main();
}
